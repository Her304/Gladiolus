/**
 * Durable event store (Phase A — Postgres + SQLite dev fallback).
 *
 * Append-only log preserving the constraints the browser-local store could not
 * (plan §5 Phase 1):
 *   - unique provider-event id (dedup across retries/sessions)
 *   - idempotency keys (a retry never creates a second visit/charge)
 *   - monotonic sequence + optimistic-concurrency version columns
 *
 * Production backs onto PostgreSQL (DATABASE_URL). When DATABASE_URL is unset,
 * a dev fallback uses node:sqlite — clearly labelled dev-only. Both backends
 * implement the same async interface:
 *   { append, eventsAfter, all, currentSeq, writeRecord, readRecord,
 *     acknowledge, close, kind }
 *
 * Methods are async (return Promises) so the Postgres path fits; the SQLite
 * path resolves immediately. Callers (app.js) await them.
 */
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION } from '../src/domain/contract.js'
import { openDatabase } from './db.js'
import { migrate } from './migrate.js'

const META = ['type', 'observedAt', 'receivedAt', 'providerId', 'idempotencyKey', 'schemaVersion', 'actor', 'source', 'at', 'payload', 'seq']

function payloadOf(event) {
  const payload = { ...event }
  for (const k of META) delete payload[k]
  return payload
}

/**
 * Open a store. With no argument (or path string) uses SQLite; pass a db object
 * from openDatabase() to use Postgres.
 * @param {string|object} [pathOrDb]
 */
export async function openStore(pathOrDb) {
  const db = pathOrDb && typeof pathOrDb === 'object' && pathOrDb.kind
    ? pathOrDb
    : await openDatabase(typeof pathOrDb === 'string' ? pathOrDb : undefined)
  await migrate(db)

  if (db.kind === 'postgres') {
    const store = postgresStore(db)
    await store.refreshSeq()
    return store
  }
  return sqliteStore(db, typeof pathOrDb === 'string' ? pathOrDb : ':memory:')
}

// ---------------------------------------------------------------------------
// SQLite path (dev fallback — synchronous under a Promise)
// ---------------------------------------------------------------------------

function sqliteStore(db, _path) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  const insertEvent = db.prepare(
    `INSERT INTO events (type, payload, observed_at, received_at, provider_id,
                         idempotency_key, schema_version, actor, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const findByProvider = db.prepare(`SELECT * FROM events WHERE provider_id = ? LIMIT 1`)
  const afterSeq = db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
  const allEvents = db.prepare(`SELECT * FROM events ORDER BY seq ASC`)
  const lastSeq = db.prepare(`SELECT MAX(seq) AS s FROM events`)
  const upsertRecord = db.prepare(
    `INSERT INTO records (id, kind, version, data, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(id, kind) DO UPDATE SET
       data = excluded.data, version = records.version + 1, updated_at = excluded.updated_at`,
  )
  const getRecord = db.prepare(`SELECT * FROM records WHERE id = ? AND kind = ?`)
  const getRecordVersioned = db.prepare(
    `UPDATE records SET version = version, updated_at = updated_at
     WHERE id = ? AND kind = ? AND version = ? RETURNING *`,
  )
  const ack = db.prepare(
    `INSERT INTO client_acks (client_id, last_seq, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET last_seq = excluded.last_seq, seen_at = excluded.seen_at`,
  )

  function append(event) {
    const providerId = event.providerId ?? null
    if (providerId) {
      const existing = findByProvider.get(providerId)
      if (existing) return Promise.resolve({ ok: false, duplicate: true, event: rowToEvent(existing) })
    }
    const payload = payloadOf(event)
    try {
      const r = insertEvent.run(
        event.type, JSON.stringify(payload),
        event.observedAt ?? event.at ?? Date.now(), event.receivedAt ?? Date.now(),
        providerId, event.idempotencyKey ?? providerId,
        event.schemaVersion ?? SCHEMA_VERSION, event.actor ?? null, event.source ?? 'live',
      )
      return Promise.resolve({ ok: true, event: rowToEventFrom(r.lastInsertRowid, event, payload) })
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        const existing = providerId ? findByProvider.get(providerId) : null
        return Promise.resolve({ ok: false, duplicate: true, event: existing ? rowToEvent(existing) : undefined })
      }
      throw e
    }
  }
  const eventsAfter = (seq, limit = 500) => Promise.resolve(afterSeq.all(seq, limit).map(rowToEvent))
  const all = () => Promise.resolve(allEvents.all().map(rowToEvent))
  const currentSeq = () => { const r = lastSeq.get(); return r.s ? Number(r.s) : 0 }
  const writeRecord = (id, kind, data, expectedVersion) => {
    const now = Date.now()
    if (expectedVersion != null) {
      const r = getRecordVersioned.get(id, kind, expectedVersion)
      if (!r) return Promise.resolve({ ok: false, conflict: true })
      upsertRecord.run(id, kind, JSON.stringify(data), now)
      return Promise.resolve({ ok: true, record: { id, kind, data, version: expectedVersion + 1, updatedAt: now } })
    }
    upsertRecord.run(id, kind, JSON.stringify(data), now)
    const r = getRecord.get(id, kind)
    return Promise.resolve({ ok: true, record: { id, kind, data, version: Number(r.version), updatedAt: Number(r.updated_at) } })
  }
  const readRecord = (id, kind) => {
    const r = getRecord.get(id, kind)
    return Promise.resolve(r ? { id, kind, data: JSON.parse(r.data), version: Number(r.version), updatedAt: Number(r.updated_at) } : null)
  }
  const acknowledge = (clientId, seq) => { ack.run(clientId, seq, Date.now()); return Promise.resolve() }
  const close = () => { db.close(); return Promise.resolve() }

  return { kind: 'sqlite', append, eventsAfter, all, currentSeq, writeRecord, readRecord, acknowledge, close, _db: db }
}

// ---------------------------------------------------------------------------
// Postgres path (production)
// ---------------------------------------------------------------------------

function postgresStore(db) {
  const INSERT_EVENT = `INSERT INTO events (type, payload, observed_at, received_at, provider_id, idempotency_key, schema_version, actor, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING seq`
  const FIND_BY_PROVIDER = `SELECT * FROM events WHERE provider_id = $1 LIMIT 1`
  const AFTER_SEQ = `SELECT * FROM events WHERE seq > $1 ORDER BY seq ASC LIMIT $2`
  const ALL_EVENTS = `SELECT * FROM events ORDER BY seq ASC`
  const LAST_SEQ = `SELECT MAX(seq) AS s FROM events`
  const UPSERT_RECORD = `INSERT INTO records (id, kind, version, data, updated_at) VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (id, kind) DO UPDATE SET data = EXCLUDED.data, version = records.version + 1, updated_at = EXCLUDED.updated_at`
  const GET_RECORD = `SELECT * FROM records WHERE id = $1 AND kind = $2`
  const GET_RECORD_VERSIONED = `UPDATE records SET version = records.version WHERE id = $1 AND kind = $2 AND version = $3 RETURNING *`
  const ACK = `INSERT INTO client_acks (client_id, last_seq, seen_at) VALUES ($1, $2, $3)
     ON CONFLICT (client_id) DO UPDATE SET last_seq = EXCLUDED.last_seq, seen_at = EXCLUDED.seen_at`

  async function append(event) {
    const providerId = event.providerId ?? null
    if (providerId) {
      const { rows } = await db.query(FIND_BY_PROVIDER, [providerId])
      if (rows.length) return { ok: false, duplicate: true, event: pgRowToEvent(rows[0]) }
    }
    const payload = payloadOf(event)
    try {
      const { rows } = await db.query(INSERT_EVENT, [
        event.type, JSON.stringify(payload),
        event.observedAt ?? event.at ?? Date.now(), event.receivedAt ?? Date.now(),
        providerId, event.idempotencyKey ?? providerId,
        event.schemaVersion ?? SCHEMA_VERSION, event.actor ?? null, event.source ?? 'live',
      ])
      _lastKnownSeq = Math.max(_lastKnownSeq, Number(rows[0].seq))
      return { ok: true, event: rowToEventFrom(rows[0].seq, event, payload) }
    } catch (e) {
      if (e.code === '23505') { // unique_violation
        const { rows } = providerId ? await db.query(FIND_BY_PROVIDER, [providerId]) : { rows: [] }
        return { ok: false, duplicate: true, event: rows.length ? pgRowToEvent(rows[0]) : undefined }
      }
      throw e
    }
  }
  async function eventsAfter(seq, limit = 500) {
    const { rows } = await db.query(AFTER_SEQ, [seq, limit])
    return rows.map(pgRowToEvent)
  }
  async function all() {
    const { rows } = await db.query(ALL_EVENTS)
    return rows.map(pgRowToEvent)
  }
  function currentSeq() {
    // Synchronous-ish: return 0 and let callers poll; but Postgres needs a query.
    // For the notify path we cache the seq on append.
    return _lastKnownSeq
  }
  let _lastKnownSeq = 0
  async function refreshSeq() {
    const { rows } = await db.query(LAST_SEQ)
    _lastKnownSeq = rows[0].s ? Number(rows[0].s) : 0
    return _lastKnownSeq
  }
  async function writeRecord(id, kind, data, expectedVersion) {
    const now = Date.now()
    if (expectedVersion != null) {
      const { rows } = await db.query(GET_RECORD_VERSIONED, [id, kind, expectedVersion])
      if (!rows.length) return { ok: false, conflict: true }
      await db.query(UPSERT_RECORD, [id, kind, JSON.stringify(data), now])
      return { ok: true, record: { id, kind, data, version: expectedVersion + 1, updatedAt: now } }
    }
    await db.query(UPSERT_RECORD, [id, kind, JSON.stringify(data), now])
    const { rows } = await db.query(GET_RECORD, [id, kind])
    return { ok: true, record: { id, kind, data, version: Number(rows[0].version), updatedAt: Number(rows[0].updated_at) } }
  }
  async function readRecord(id, kind) {
    const { rows } = await db.query(GET_RECORD, [id, kind])
    if (!rows.length) return null
    return { id, kind, data: parseJsonColumn(rows[0].data), version: Number(rows[0].version), updatedAt: Number(rows[0].updated_at) }
  }
  async function acknowledge(clientId, seq) { await db.query(ACK, [clientId, seq, Date.now()]) }
  async function close() { await db.close() }

  return { kind: 'postgres', append, eventsAfter, all, currentSeq, writeRecord, readRecord, acknowledge, close, refreshSeq, _db: db }
}

// ---------------------------------------------------------------------------
// Row mappers (shared shape for both backends)
// ---------------------------------------------------------------------------

function rowToEvent(r) {
  const payload = parseJsonColumn(r.payload)
  return {
    seq: Number(r.seq), type: r.type,
    observedAt: Number(r.observed_at), receivedAt: Number(r.received_at),
    providerId: r.provider_id, idempotencyKey: r.idempotency_key,
    schemaVersion: Number(r.schema_version), actor: r.actor, source: r.source,
    at: Number(r.observed_at), ...payload,
  }
}

// Postgres returns column names lowercased already; same shape as sqlite rows.
function pgRowToEvent(r) { return rowToEvent(r) }

function parseJsonColumn(value) {
  if (value == null) return {}
  return typeof value === 'string' ? JSON.parse(value) : value
}

function rowToEventFrom(seq, event, payload) {
  return {
    seq: Number(seq), type: event.type,
    observedAt: event.observedAt ?? event.at ?? Date.now(),
    receivedAt: event.receivedAt ?? Date.now(),
    providerId: event.providerId ?? null,
    idempotencyKey: event.idempotencyKey ?? event.providerId ?? null,
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION,
    actor: event.actor ?? null, source: event.source ?? 'live',
    at: event.observedAt ?? event.at ?? Date.now(), ...payload,
  }
}
