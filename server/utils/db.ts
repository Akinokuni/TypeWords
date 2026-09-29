import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

let db: DatabaseSync | null = null

function getDataDir(): string {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR)
  return path.join(process.cwd(), 'data')
}

/**
 * SQLite 连接与表结构。
 *
 * 三张表：
 * - `store`  —— 文档与练习缓存：key → JSON 文本（向后兼容既有部署）
 * - `meta`   —— 全局单调修订号（单行）
 * - `oplog`  —— 操作日志：增量拉取（?since=）、幂等去重（op_id 唯一）、审计
 */
export function getDb(): DatabaseSync {
  if (db) return db
  const dir = getDataDir()
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'typewords.db')
  db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    replace_revision INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec('INSERT OR IGNORE INTO meta (id, revision) VALUES (1, 0)')
  // 兼容只含 revision 列的既有数据库
  try {
    db.exec('ALTER TABLE meta ADD COLUMN replace_revision INTEGER NOT NULL DEFAULT 0')
  } catch {
    // 列已存在，忽略
  }
  db.exec(`CREATE TABLE IF NOT EXISTS oplog (
    revision    INTEGER PRIMARY KEY,
    op_id       TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    payload     TEXT,
    entity_keys TEXT NOT NULL,
    origin      TEXT NOT NULL,
    client_ts   TEXT,
    applied_at  TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_oplog_rev ON oplog(revision)')
  // 提升并发与耐久性：WAL 允许读写并行，NORMAL 在 WAL 下仍然安全
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

/** 全局单调修订号 */
export function getRevision(): number {
  const row = getDb().prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number } | undefined
  return row?.revision ?? 0
}

export function setRevision(revision: number): void {
  getDb().prepare('UPDATE meta SET revision = ? WHERE id = 1').run(revision)
}

/**
 * 最近一次「整文档替换」（导入 / 恢复 / 手动覆盖）发生时的修订号。
 *
 * 与 `revision` 一起界定「文档代（generation）」：整文档替换会把文档整体换掉，
 * 因此早于该替换落库的 opId 不能作为「该意图已生效」的依据——否则响应丢失后重试的操作
 * 会被幂等去重跳过，而替换后的文档里并不包含它。`findAppliedOpRevision` 据此判定。
 */
export function getReplaceRevision(): number {
  const row = getDb().prepare('SELECT replace_revision FROM meta WHERE id = 1').get() as
    | { replace_revision: number }
    | undefined
  return row?.replace_revision ?? 0
}

export function setReplaceRevision(revision: number): void {
  getDb().prepare('UPDATE meta SET replace_revision = ? WHERE id = 1').run(revision)
}

export function getStoreValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM store WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function getStoreRow(key: string): { value: string; updated_at: string } | null {
  const row = getDb().prepare('SELECT value, updated_at FROM store WHERE key = ?').get(key) as
    | { value: string; updated_at: string }
    | undefined
  return row ?? null
}

export function setStoreValue(key: string, value: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .run(key, value, now)
}

/** 使用调用方给定的 updated_at 写入（避免「先读后写」把并发写入的时间戳覆盖掉） */
export function setStoreValueWithTime(key: string, value: string, updatedAt: string): void {
  getDb()
    .prepare(
      'INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .run(key, value, updatedAt)
}

export function deleteStoreValue(key: string): void {
  getDb().prepare('DELETE FROM store WHERE key = ?').run(key)
}

/**
 * 在单个 SQLite 写事务内执行 fn。
 * 使用 BEGIN IMMEDIATE 立即取写锁，使「读文档 → 应用操作 → 写回」整体原子化并串行执行。
 */
export function withTransaction<T>(fn: () => T): T {
  const conn = getDb()
  conn.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    conn.exec('COMMIT')
    return result
  } catch (error) {
    try {
      conn.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }
    throw error
  }
}
