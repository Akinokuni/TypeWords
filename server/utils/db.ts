import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

let db: DatabaseSync | null = null

function getDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR)
  return path.join(process.cwd(), 'data')
}

export function getDb(): DatabaseSync {
  if (db) return db
  const dir = getDataDir()
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'typewords.db')
  db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  return db
}

export function getStoreValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM store WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setStoreValue(key: string, value: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .run(key, value, now)
}
