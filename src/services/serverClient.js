/**
 * Server client — the browser's connection to the authoritative server (Phase 1).
 *
 * Browsers are clients, not separate fleet worlds (plan §3.1). This module
 * connects to the SSE stream, reconnects from the last acknowledged sequence,
 * and exposes connection state + data age so every decision surface can show
 * whether it is seeing live, stale, or disconnected data (plan §5 Phase 1).
 *
 * It degrades gracefully: if the server is unreachable (the static preview
 * build, or no network), the app falls back to the in-browser simulator and
 * labels the data source as 'local'. It never silently pretends to be live.
 */
import { EVENT } from '../domain/contract.js'

const SERVER_BASE = import.meta.env?.VITE_SERVER_URL || ''
const STREAM_PATH = '/api/stream'
const EVENTS_PATH = '/api/events'

export const CONN_STATE = Object.freeze({
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  LOCAL: 'local', // no server; running the in-browser sim, labelled
})

/**
 * @returns {{state:string, lastSeq:number, lastEventAt:number|null, source:string}}
 */
export function createServerClient({ onEvent } = {}) {
  let state = CONN_STATE.LOCAL
  let lastSeq = 0
  let lastEventAt = null
  let es = null
  let reconnectTimer = null
  const clientId = `c-${Math.random().toString(36).slice(2)}`

  function setState(s) { state = s }

  function connect() {
    if (!SERVER_BASE) { state = CONN_STATE.LOCAL; return }
    state = CONN_STATE.CONNECTING
    try {
      es = new EventSource(`${SERVER_BASE}${STREAM_PATH}?since=${lastSeq}&client=${clientId}`)
      es.onopen = () => { state = CONN_STATE.CONNECTED }
      es.onmessage = (msg) => {
        try {
          const e = JSON.parse(msg.data)
          if (e.seq) { lastSeq = e.seq; lastEventAt = Date.now() }
          if (e.type && e.type !== 'caught-up' && e.type !== 'tick') onEvent?.(e)
        } catch { /* ignore malformed */ }
      }
      es.onerror = () => {
        state = CONN_STATE.DISCONNECTED
        es?.close()
        // Reconnect with backoff; resume from last acknowledged sequence.
        if (!reconnectTimer) reconnectTimer = setTimeout(connect, 3000)
      }
    } catch {
      state = CONN_STATE.DISCONNECTED
    }
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    es?.close()
    es = null
    state = CONN_STATE.DISCONNECTED
  }

  /** Ingest an observation through the server (idempotent). */
  async function ingest(event) {
    if (!SERVER_BASE) return { ok: false, local: true }
    try {
      const res = await fetch(`${SERVER_BASE}/api/events/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })
      return await res.json()
    } catch {
      return { ok: false, error: 'server unreachable' }
    }
  }

  /** Issue a command (authorized). */
  async function command(cmd, token) {
    if (!SERVER_BASE) return { ok: false, local: true }
    try {
      const res = await fetch(`${SERVER_BASE}/api/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(cmd),
      })
      return await res.json()
    } catch {
      return { ok: false, error: 'server unreachable' }
    }
  }

  return {
    connect, disconnect, ingest, command,
    get state() { return state },
    get lastSeq() { return lastSeq },
    get lastEventAt() { return lastEventAt },
    get source() { return state === CONN_STATE.CONNECTED ? 'live' : state === CONN_STATE.LOCAL ? 'local' : 'stale' },
    get dataAgeMs() { return lastEventAt ? Date.now() - lastEventAt : null },
  }
}
