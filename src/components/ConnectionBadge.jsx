/**
 * Connection + data-age badge (Phase 1).
 *
 * Every decision surface shows connection state and data age (plan §5 Phase 1:
 * "Show connection state and data age on every decision surface"). A dispatcher
 * or driver must be able to see at a glance whether they are looking at live,
 * stale-last-known, or local-only data — never silently live.
 */
import { useSyncExternalStore } from 'react'

let client = null
const listeners = new Set()

// useSyncExternalStore calls getSnapshot during render and again on commit to
// detect external mutations; returning a fresh object each call makes React see
// a change every time and re-render in an infinite loop. Cache the snapshot and
// replace it only when a value the badge actually displays differs.
let snapshot = { state: 'local', source: 'local', dataAgeMs: null, lastSeq: 0 }

function recompute() {
  const next = client
    ? { state: client.state, source: client.source, dataAgeMs: client.dataAgeMs, lastSeq: client.lastSeq }
    : { state: 'local', source: 'local', dataAgeMs: null, lastSeq: 0 }
  if (
    next.state !== snapshot.state ||
    next.source !== snapshot.source ||
    next.lastSeq !== snapshot.lastSeq ||
    fmtAge(next.dataAgeMs) !== fmtAge(snapshot.dataAgeMs)
  ) {
    snapshot = next
  }
}

export function attachServerClient(c) {
  client = c
  recompute()
  // The client exposes its state via getters; poll-lightly for the badge.
  // (A full event emitter is overkill for a 1s badge refresh.)
  setInterval(() => { recompute(); listeners.forEach((l) => l()) }, 1000)
}

function subscribe(l) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getSnapshot() {
  return snapshot
}

export function ConnectionBadge() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const label = {
    connected: 'Live',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
    local: 'Local sim',
  }[s.state] || s.state
  const cls = `conn-badge conn-${s.state}`
  const age = s.dataAgeMs == null ? '' : ` · ${fmtAge(s.dataAgeMs)} ago`
  return (
    <span className={cls} title={`seq ${s.lastSeq} · ${s.source}${age}`}>
      <span className="conn-dot" /> {label}{age}
    </span>
  )
}

function fmtAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3600_000)}h`
}
