import { randomBytes } from 'node:crypto'
import express from 'express'
import { db, type UserRow } from './db.js'

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:5173/api/auth/google/callback'
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true'

const SESSION_COOKIE = 'session'
const STATE_COOKIE = 'oauth_state'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function newToken(): string {
  return randomBytes(32).toString('hex')
}

function createSession(userId: string): string {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt)
  return token
}

function getUserForSession(token: string): UserRow | null {
  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ? AND sessions.expires_at > datetime('now')`,
    )
    .get(token) as UserRow | undefined
  return row ?? null
}

function upsertGoogleUser(profile: { sub: string; email: string; name: string; picture?: string }): UserRow {
  const existing = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub) as UserRow | undefined
  if (existing) {
    db.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?').run(
      profile.email,
      profile.name,
      profile.picture ?? null,
      existing.id,
    )
    return { ...existing, email: profile.email, name: profile.name, picture: profile.picture ?? null }
  }
  const id = newToken()
  db.prepare('INSERT INTO users (id, google_sub, email, name, picture) VALUES (?, ?, ?, ?, ?)').run(
    id,
    profile.sub,
    profile.email,
    profile.name,
    profile.picture ?? null,
  )
  return { id, google_sub: profile.sub, email: profile.email, name: profile.name, picture: profile.picture ?? null, created_at: '' }
}

export const authRouter = express.Router()

authRouter.get('/google', (_req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    res.status(500).send('Google OAuth is not configured on the server (missing GOOGLE_CLIENT_ID).')
    return
  }
  const state = newToken()
  res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', maxAge: 10 * 60 * 1000 })

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
})

authRouter.get('/google/callback', async (req, res) => {
  const { code, state } = req.query
  const expectedState = req.cookies?.[STATE_COOKIE]
  res.clearCookie(STATE_COOKIE)

  if (!code || typeof code !== 'string' || !state || state !== expectedState) {
    res.status(400).send('Invalid or expired login attempt. Please try signing in again.')
    return
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`)
    const tokenBody = (await tokenRes.json()) as { access_token: string }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    })
    if (!profileRes.ok) throw new Error(`userinfo fetch failed: ${profileRes.status}`)
    const profile = (await profileRes.json()) as { sub: string; email: string; name: string; picture?: string }

    const user = upsertGoogleUser(profile)
    const sessionToken = createSession(user.id)
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    })
    res.redirect(FRONTEND_URL)
  } catch (err) {
    console.error('[auth] Google OAuth callback failed:', err)
    res.status(502).send('Sign-in failed. Please try again.')
  }
})

authRouter.get('/me', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE]
  const user = token ? getUserForSession(token) : null
  if (!user) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }
  res.json({ id: user.id, email: user.email, name: user.name, picture: user.picture })
})

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE]
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  res.clearCookie(SESSION_COOKIE)
  res.json({ ok: true })
})

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE]
  const user = token ? getUserForSession(token) : null
  if (!user) {
    res.status(401).json({ error: 'Sign in required' })
    return
  }
  ;(req as express.Request & { user: UserRow }).user = user
  next()
}
