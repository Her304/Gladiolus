/**
 * Idempotent schema migrations (Phase A).
 *
 * Runs on boot against whichever backend server/db.js selected. The same tables
 * the SQLite path created, translated to portable DDL (Postgres + SQLite both
 * accept these). The `events` table's unique provider-id index is the atomic
 * dedup guard; `records` carries the optimistic-concurrency version; the
 * `users` and `tracking_grants` tables support Phase B auth.
 *
 * Each statement is IF NOT EXISTS so re-running is safe.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
     seq            INTEGER PRIMARY KEY AUTOINCREMENT,
     type           TEXT NOT NULL,
     payload        TEXT NOT NULL DEFAULT '{}',
     observed_at    INTEGER NOT NULL,
     received_at    INTEGER NOT NULL,
     provider_id    TEXT,
     idempotency_key TEXT,
     schema_version INTEGER NOT NULL,
     actor          TEXT,
     source         TEXT NOT NULL DEFAULT 'live'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider
     ON events(provider_id) WHERE provider_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq)`,

  `CREATE TABLE IF NOT EXISTS records (
     id        TEXT NOT NULL,
     kind      TEXT NOT NULL,
     version   INTEGER NOT NULL DEFAULT 1,
     data      TEXT NOT NULL DEFAULT '{}',
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (id, kind)
   )`,

  `CREATE TABLE IF NOT EXISTS client_acks (
     client_id  TEXT PRIMARY KEY,
     last_seq   INTEGER NOT NULL DEFAULT 0,
     seen_at    INTEGER NOT NULL
   )`,

  // Phase B auth tables (created here so the migration is one pass).
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     email         TEXT UNIQUE,
     role          TEXT NOT NULL,
     password_hash TEXT,
     name          TEXT,
     driver_id     TEXT,
     truck_id      TEXT,
     created_at    INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS tracking_grants (
     token_id    TEXT PRIMARY KEY,
     shipment_id TEXT NOT NULL,
     exp         INTEGER NOT NULL,
     revoked_at  INTEGER,
     issued_at   INTEGER NOT NULL,
     issued_by   TEXT
   )`,
]

const POSTGRES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS events (
     seq             BIGSERIAL PRIMARY KEY,
     type            TEXT NOT NULL,
     payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
     observed_at     BIGINT NOT NULL,
     received_at     BIGINT NOT NULL,
     provider_id     TEXT,
     idempotency_key TEXT,
     schema_version  INTEGER NOT NULL,
     actor           TEXT,
     source          TEXT NOT NULL DEFAULT 'live'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_provider
     ON events(provider_id) WHERE provider_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq)`,
  `CREATE TABLE IF NOT EXISTS records (
     id         TEXT NOT NULL,
     kind       TEXT NOT NULL,
     version    INTEGER NOT NULL DEFAULT 1,
     data       JSONB NOT NULL DEFAULT '{}'::jsonb,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (id, kind)
   )`,
  `CREATE TABLE IF NOT EXISTS client_acks (
     client_id TEXT PRIMARY KEY,
     last_seq  BIGINT NOT NULL DEFAULT 0,
     seen_at   BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     email         TEXT UNIQUE,
     role          TEXT NOT NULL,
     password_hash TEXT,
     name          TEXT,
     driver_id     TEXT,
     truck_id      TEXT,
     created_at    BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tracking_grants (
     token_id    TEXT PRIMARY KEY,
     shipment_id TEXT NOT NULL,
     exp         BIGINT NOT NULL,
     revoked_at  BIGINT,
     issued_at   BIGINT NOT NULL,
     issued_by   TEXT
   )`,
]

/**
 * Run all migrations. Idempotent.
 * @param {{kind:string, exec:Function, query?:Function}} db
 */
export async function migrate(db) {
  if (db.kind === 'postgres') {
    for (const sql of POSTGRES_STATEMENTS) await db.query(sql)
    return
  }
  // SQLite: statements run as-is via exec.
  for (const sql of STATEMENTS) db.exec(sql)
}
