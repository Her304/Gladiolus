/**
 * Server client — the browser's connection to the authoritative server (Phase 1).
 *
 * Browsers are clients, not separate fleet worlds (plan §3.1). This module
 * connects to the SSE stream, reconnects from the last acknowledged sequence,
 * and exposes connection state + data age so every decision surface can show
 * whether it is seeing live, stale, or disconnected data (plan §5 Phase 1).
 *
 * A disconnected production client remains visibly disconnected; it never
 * labels stale/empty state as a local simulator that is not actually running.
 */
import { getToken } from '../auth/AuthContext.jsx'
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

const STREAM_PATH = '/api/stream'

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
  let tokenOverride = null
  const clientId = `c-${Math.random().toString(36).slice(2)}`

  function connect() {
    if (!SERVER_ENABLED) { state = CONN_STATE.LOCAL; return }
    // The SSE stream requires a signed token (Phase B). EventSource can't set
    // headers, so the token goes in the query string. If there's no token yet
    // (not signed in), defer. AuthContext calls reconnect() after login.
    const token = tokenOverride || (typeof getToken === 'function' ? getToken() : '')
    if (!token) { state = CONN_STATE.DISCONNECTED; return }
    state = CONN_STATE.CONNECTING
    try {
      es = new EventSource(`${apiUrl(STREAM_PATH)}?since=${lastSeq}&client=${clientId}&token=${encodeURIComponent(token)}`)
      es.onopen = () => { state = CONN_STATE.CONNECTED }
      es.onmessage = (msg) => {
        try {
          const e = JSON.parse(msg.data)
          if (e.type === 'caught-up' || e.type === 'tick') {
            // Control cursors are safe acknowledgements only because the server
            // emits them after it has scanned every preceding sequence.
            if (e.replayedThrough != null) lastSeq = Math.max(lastSeq, Number(e.replayedThrough))
            lastEventAt = Date.now()
            return
          }
          if (e.seq) { lastSeq = Math.max(lastSeq, Number(e.seq)); lastEventAt = Date.now() }
          if (e.type) onEvent?.(e)
        } catch { /* ignore malformed */ }
      }
      es.onerror = () => {
        es?.close()
        state = CONN_STATE.DISCONNECTED
        if (!reconnectTimer) reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
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
    if (!SERVER_ENABLED) return { ok: false, local: true }
    try {
      const res = await fetch(apiUrl('/api/events/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOverride || getToken()}` },
        body: JSON.stringify(event),
      })
      return await res.json()
    } catch {
      return { ok: false, error: 'server unreachable' }
    }
  }

  /** Issue a command (authorized). */
  async function command(cmd, token) {
    if (!SERVER_ENABLED) return { ok: false, local: true }
    try {
      const res = await fetch(apiUrl('/api/commands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(cmd),
      })
      return await res.json()
    } catch {
      return { ok: false, error: 'server unreachable' }
    }
  }

  /** Reconnect after a token becomes available (called by AuthContext on login). */
  function reconnect(accessToken = null) {
    if (es) { es.close(); es = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    lastSeq = 0 // replay from the start so the newly-authed client sees everything
    tokenOverride = accessToken
    connect()
  }

  return {
    connect, disconnect, reconnect, ingest, command,
    get state() { return state },
    get lastSeq() { return lastSeq },
    get lastEventAt() { return lastEventAt },
    get source() { return state === CONN_STATE.CONNECTED ? 'live' : state === CONN_STATE.LOCAL ? 'local' : 'stale' },
    get dataAgeMs() { return lastEventAt ? Date.now() - lastEventAt : null },
  }
}
