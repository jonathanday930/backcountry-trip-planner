import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// PERSIST_DIR points at a Fly.io volume mount (e.g. "/data") in production, so the database
// survives deploys/restarts. Defaults to the local backend/data directory for local dev.
const PERSIST_DIR = process.env.PERSIST_DIR ?? path.join(__dirname, '..', 'data')
mkdirSync(PERSIST_DIR, { recursive: true })
const DB_PATH = path.join(PERSIST_DIR, 'app.db')

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_routes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    park_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stops TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_saved_routes_user ON saved_routes(user_id);
`)

// `CREATE TABLE IF NOT EXISTS` above doesn't retroactively add columns to a database file that
// already exists from before this column was introduced, so it's added here as a one-off migration.
const savedRouteColumns = db.prepare(`PRAGMA table_info(saved_routes)`).all() as { name: string }[]
if (!savedRouteColumns.some((c) => c.name === 'sleep_stops')) {
  db.exec(`ALTER TABLE saved_routes ADD COLUMN sleep_stops TEXT NOT NULL DEFAULT '[]'`)
}

export interface UserRow {
  id: string
  google_sub: string
  email: string
  name: string
  picture: string | null
  created_at: string
}

export interface SavedRouteRow {
  id: string
  user_id: string
  park_id: string
  name: string
  stops: string
  sleep_stops: string
  created_at: string
}
