import { randomBytes } from 'node:crypto'
import express from 'express'
import { db, type SavedRouteRow, type UserRow } from './db.js'
import { requireAuth } from './auth.js'

export const savedRoutesRouter = express.Router()
savedRoutesRouter.use(requireAuth)

/** Matches the /api/route stop cap in server.ts. */
const MAX_STOPS = 25

function currentUser(req: express.Request): UserRow {
  return (req as express.Request & { user: UserRow }).user
}

savedRoutesRouter.get('/', (req, res) => {
  const user = currentUser(req)
  const rows = db
    .prepare('SELECT * FROM saved_routes WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id) as SavedRouteRow[]
  res.json(
    rows.map((r) => ({
      id: r.id,
      parkId: r.park_id,
      name: r.name,
      stops: JSON.parse(r.stops) as string[],
      createdAt: r.created_at,
    })),
  )
})

savedRoutesRouter.post('/', (req, res) => {
  const user = currentUser(req)
  const { parkId, name, stops } = req.body ?? {}

  if (typeof parkId !== 'string' || !parkId) {
    res.status(400).json({ error: 'parkId is required' })
    return
  }
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  if (!Array.isArray(stops) || stops.length < 2 || !stops.every((s) => typeof s === 'string')) {
    res.status(400).json({ error: 'stops must be an array of at least 2 strings' })
    return
  }
  if (stops.length > MAX_STOPS) {
    res.status(400).json({ error: `stops must have at most ${MAX_STOPS} entries` })
    return
  }

  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO saved_routes (id, user_id, park_id, name, stops) VALUES (?, ?, ?, ?, ?)').run(
    id,
    user.id,
    parkId,
    name.trim(),
    JSON.stringify(stops),
  )
  res.status(201).json({ id, parkId, name: name.trim(), stops })
})

savedRoutesRouter.delete('/:id', (req, res) => {
  const user = currentUser(req)
  const result = db.prepare('DELETE FROM saved_routes WHERE id = ? AND user_id = ?').run(req.params.id, user.id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Route not found' })
    return
  }
  res.json({ ok: true })
})
