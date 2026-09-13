/**
 * Database pool (Phase A).
 *
 * Production uses PostgreSQL (pg.Pool, DATABASE_URL). When DATABASE_URL is
 * unset (dev/test without a Postgres), this falls back to node:sqlite — clearly
 * labelled dev-only — so the same store interface works in both environments.
 * The store module (server/store.js) talks to whichever backend this returns.
 */
import { DatabaseSync } from 'node:sqlite'

/**
 * @returns {'postgres'|'sqlite'} the active backend kind
 */
export function backendKind() {
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite'
}

/**
 * Open a database. Returns an object with a `kind` and a uniform query helper:
 *   - postgres: { kind, pool, query, exec }  (query is async, returns rows)
 *   - sqlite:   { kind, db, prepare, exec }  (synchronous prepared statements)
 *
 * The store module branches on `kind`; the two paths implement the same store
 * interface so callers don't care which backend is active.
 *
 * @param {string} [path] SQLite file path (ignored when DATABASE_URL is set)
 */
export async function openDatabase(path) {
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    return {
      kind: 'postgres',
      pool,
      /** Run a parameterized query; returns { rows }. */
      query: (text, params) => pool.query(text, params),
      /** Run a statement with no result needed (DDL). */
      exec: async (text) => { await pool.query(text) },
      async close() { await pool.end() },
    }
  }
  // Dev fallback. node:sqlite is experimental but fine for local dev/tests.
  const db = new DatabaseSync(path || ':memory:')
  return {
    kind: 'sqlite',
    db,
    prepare: (sql) => db.prepare(sql),
    exec: (text) => db.exec(text),
    async close() { db.close() },
  }
}
