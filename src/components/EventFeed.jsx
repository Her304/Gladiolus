import { EVENT } from '../contract.js'
import { fmtTime } from '../format.js'

/** One line of plain English per event. The log is the product's spine. */
function describe(e) {
  switch (e.type) {
    case EVENT.FENCE_ENTER: return `arrived at ${e.siteName}`
    case EVENT.FENCE_EXIT:
      return e.dwellMin >= 5
        ? `left ${e.siteName} after ${e.dwellMin} min`
        : `passed ${e.siteName} without stopping`
    case EVENT.LOAD_ASSIGNED: return `picked up ${e.loadId} for ${e.destinationName ?? 'the next stop'}`
    case EVENT.LOAD_DELIVERED: return `delivered ${e.loadId} at ${e.siteName}`
    case EVENT.BREAK_START: return `started a 10-hour reset at ${e.siteName}`
    case EVENT.BREAK_END:
      return e.wasForced ? 'back in service after a roadside reset' : `back in service from ${e.siteName}`
    case EVENT.PARKING_CLAIM:
      return e.viable === false
        ? `holding a space at ${e.siteName} — projected full on arrival`
        : `holding a space at ${e.siteName}, ${e.etaMin} min out`
    case EVENT.PARKING_RELEASE: return `gave up its space at ${e.siteName} — ${e.reason}`
    case EVENT.FORCED_STOP:
      return `OUT OF HOURS on the shoulder, ${e.shortfallKm} km short of ${e.nearestSiteName}`
    case EVENT.ADMIN_ACTION:
      return e.detail ? `${e.action} — ${e.detail}` : e.action
    default: return e.type
  }
}

export default function EventFeed({ events }) {
  return (
    <section className="panel">
      <h2>Event log <span className="count">{events.length}</span></h2>
      <p className="note">
        Every view in this app is a fold over this log, so any of them can be
        rebuilt by replaying it.
      </p>
      <ul className="feed">
        {events.map((e) => (
          <li key={e.seq} className={e.type === EVENT.FORCED_STOP ? 'alarm' : undefined}>
            <time>{fmtTime(e.at)}</time>
            <span>
              <span className="who">{e.truckId || e.actor}</span> {describe(e)}
            </span>
          </li>
        ))}
        {events.length === 0 && <li><span className="note">Waiting for telemetry…</span></li>}
      </ul>
    </section>
  )
}
