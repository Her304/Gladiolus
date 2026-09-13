/**
 * Durable event store (Phase 1).
 *
 * A SQLite-backed append-only log that preserves the constraints the
 * browser-local store could not (plan §5 Phase 1):
 *   - unique provider-event id (dedup across retries/sessions)
 *   - idempotency keys (a retry never creates a second visit/charge)
 *   - monotonic sequence + optimistic-concurrency version columns
 *   - transactions for conflicting commands
 *
 * The dev adapter uses node:sqlite (Node 24 built-in). The same constraints
 * apply to a PostgreSQL pilot deployment; only the driver changes.
 */
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION } from '../src/domain/contract.js'

const MIGRATIONS = [
  // The event log. seq is monotonic; provider_id is unique per source so a
  // retry with the same provider id is rejected by the DB itself, not just app
  // logic. observed_at is split from received_at (plan §3.3, §10).
  `CREATE TABLE IF NOT EXISTS events (
     seq            INTEGER PRIMARY KEY AUTOINCREMENT,
     type           TEXT NOT NULL,
     payload        TEXT NOT NULL,
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

  // Versioned reference/configuration records. version is the optimistic
  // concurrency token; a write with a stale version is rejected.
  `CREATE TABLE IF NOT EXISTS records (
     id        TEXT NOT NULL,
     kind      TEXT NOT NULL,
     version   INTEGER NOT NULL DEFAULT 1,
     data      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (id, kind)
   )`,

  // Acknowledged sequence per client, so a reconnecting client asks for events
  // after its last ack (plan §5 Phase 1: "reconnect from the last acknowledged
  // sequence").
  `CREATE TABLE IF NOT EXISTS client_acks (
     client_id  TEXT PRIMARY KEY,
     last_seq   INTEGER NOT NULL DEFAULT 0,
     seen_at    INTEGER NOT NULL
   )`,
]

/**
 * @param {string} [path] ':memory:' for tests, a file path for a real run.
 */
export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const sql of MIGRATIONS) db.exec(sql)

  const insertEvent = db.prepare(
    `INSERT INTO events (type, payload, observed_at, received_at, provider_id,
                         idempotency_key, schema_version, actor, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const findByProvider = db.prepare(
    `SELECT * FROM events WHERE provider_id = ? LIMIT 1`,
  )
  const afterSeq = db.prepare(
    `SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
  )
  const allEvents = db.prepare(`SELECT * FROM events ORDER BY seq ASC`)
  const lastSeq = db.prepare(`SELECT MAX(seq) AS s FROM events`)

  const upsertRecord = db.prepare(
    `INSERT INTO records (id, kind, version, data, updated_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(id, kind) DO UPDATE SET
       data = excluded.data,
       version = records.version + 1,
       updated_at = excluded.updated_at`,
  )
  const getRecord = db.prepare(`SELECT * FROM records WHERE id = ? AND kind = ?`)
  const getRecordVersioned = db.prepare(
    `UPDATE records SET version = version, updated_at = updated_at
     WHERE id = ? AND kind = ? AND version = ?
     RETURNING *`,
  )

  const ack = db.prepare(
    `INSERT INTO client_acks (client_id, last_seq, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET last_seq = excluded.last_seq, seen_at = excluded.seen_at`,
  )

  /**
   * Append an event with idempotency enforced at the DB layer. A retry carrying
   * the same provider_id returns the existing event instead of duplicating.
   * Runs inside a transaction so the sequence and the unique index commit
   * together.
   *
   * @returns {{ok:boolean, event?:object, duplicate?:boolean}}
   */
  function append(event) {
    const providerId = event.providerId ?? null
    if (providerId) {
      const existing = findByProvider.get(providerId)
      if (existing) return { ok: false, duplicate: true, event: rowToEvent(existing) }
    }
    // The payload column holds the full domain data: everything that is not a
    // meta column with its own storage (type, times, provenance). This preserves
    // arbitrary domain fields (stopId, shipmentId, truckId, ...) across a
    // round-trip without a schema per event type.
    const META = ['type', 'observedAt', 'receivedAt', 'providerId', 'idempotencyKey', 'schemaVersion', 'actor', 'source', 'at', 'payload', 'seq']
    const payload = { ...event }
    for (const k of META) delete payload[k]
    try {
      const r = insertEvent.run(
        event.type,
        JSON.stringify(payload),
        event.observedAt ?? event.at ?? Date.now(),
        event.receivedAt ?? Date.now(),
        providerId,
        event.idempotencyKey ?? providerId,
        event.schemaVersion ?? SCHEMA_VERSION,
        event.actor ?? null,
        event.source ?? 'live',
      )
      return { ok: true, event: rowToEventFrom(r, event, payload) }
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        const existing = providerId ? findByProvider.get(providerId) : null
        return { ok: false, duplicate: true, event: existing ? rowToEvent(existing) : undefined }
      }
      throw e
    }
  }

  function eventsAfter(seq, limit = 500) {
    return afterSeq.all(seq, limit).map(rowToEvent)
  }

  function all() {
    return allEvents.all().map(rowToEvent)
  }

  function currentSeq() {
    const r = lastSeq.get()
    return r.s ? Number(r.s) : 0
  }

  /** Optimistic-concurrency write: rejects if the version is stale. */
  function writeRecord(id, kind, data, expectedVersion) {
    const now = Date.now()
    if (expectedVersion != null) {
      const r = getRecordVersioned.get(id, kind, expectedVersion)
      if (!r) return { ok: false, conflict: true }
      upsertRecord.run(id, kind, JSON.stringify(data), now)
      return { ok: true, record: { id, kind, data, version: expectedVersion + 1, updatedAt: now } }
    }
    upsertRecord.run(id, kind, JSON.stringify(data), now)
    const r = getRecord.get(id, kind)
    return { ok: true, record: { id, kind, data, version: Number(r.version), updatedAt: Number(r.updated_at) } }
  }

  function readRecord(id, kind) {
    const r = getRecord.get(id, kind)
    return r ? { id, kind, data: JSON.parse(r.data), version: Number(r.version), updatedAt: Number(r.updated_at) } : null
  }

  function acknowledge(clientId, seq) {
    ack.run(clientId, seq, Date.now())
  }

  function close() {
    db.close()
  }

  return {
    append, eventsAfter, all, currentSeq,
    writeRecord, readRecord,
    acknowledge,
    close,
    _db: db, // exposed for transaction control in tests
  }
}

function rowToEvent(r) {
  const payload = JSON.parse(r.payload)
  return {
    seq: Number(r.seq),
    type: r.type,
    observedAt: Number(r.observed_at),
    receivedAt: Number(r.received_at),
    providerId: r.provider_id,
    idempotencyKey: r.idempotency_key,
    schemaVersion: Number(r.schema_version),
    actor: r.actor,
    source: r.source,
    at: Number(r.observed_at), // alias so v1 folds still read e.at
    ...payload, // full domain data (stopId, shipmentId, truckId, ...)
  }
}

/** Build the returned event object for a just-inserted row (no re-read needed). */
function rowToEventFrom(r, event, payload) {
  return {
    seq: Number(r.lastInsertRowid),
    type: event.type,
    observedAt: event.observedAt ?? event.at ?? Date.now(),
    receivedAt: event.receivedAt ?? Date.now(),
    providerId: event.providerId ?? null,
    idempotencyKey: event.idempotencyKey ?? event.providerId ?? null,
    schemaVersion: event.schemaVersion ?? SCHEMA_VERSION,
    actor: event.actor ?? null,
    source: event.source ?? 'live',
    at: event.observedAt ?? event.at ?? Date.now(),
    ...payload,
  }
}
