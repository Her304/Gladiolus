import { useState } from 'react'
import { EVENT } from '../contract.js'
import { defectLabels } from '../engine/inspection.js'
import { CATEGORY_BY_ID } from '../engine/breakdown.js'
import { fmtTime } from '../format.js'

/** The driver.action sub-types a dispatcher can answer. A reply threads under
 *  the original request by its seq, so only these three get a reply field. */
const REPLYABLE = ['delay.reported', 'correction.requested', 'dispatch.requested']

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
    case EVENT.DRIVER_ACTION:
      // A dispatcher's reply reads as a reply, not as another driver action.
      if (e.action === 'dispatch.replied') return `replied${e.message ? ` — ${e.message}` : ''}`
      return `${e.action.replaceAll('.', ' ')}${e.message ? ` — ${e.message}` : ''}`
    case EVENT.ADMIN_ACTION:
      return e.detail ? `${e.action} — ${e.detail}` : e.action
    // Only inspections carrying a defect reach the feed — see isFeedWorthy.
    case EVENT.INSPECTION:
      return `${e.major ? 'FAILED' : 'flagged'} a ${e.phase} inspection — ${defectLabels(e.defects).join(', ')}`
    case EVENT.BREAKDOWN:
      return `is down at km ${Math.round(e.chainage)} — ${(CATEGORY_BY_ID[e.category]?.label ?? e.category).toLowerCase()}${e.blockingLane ? ', BLOCKING A LIVE LANE' : ''}`
    case EVENT.BREAKDOWN_CLEARED:
      return 'is rolling again after a breakdown'
    default: return e.type
  }
}

/** An inline reply field under a driver's request. State is local so each
 *  request keeps its own draft; submitting clears it and hands the text to the
 *  board, which appends the dispatch.replied event to the shared store. */
function ReplyForm({ onReply, seq, truckId }) {
  const [text, setText] = useState('')
  function submit(e) {
    e.preventDefault()
    const msg = text.trim()
    if (!msg) return
    onReply(seq, truckId, msg)
    setText('')
  }
  return (
    <div className="reply">
      <form className="reply-row" onSubmit={submit}>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reply to driver…"
          maxLength={1000}
          aria-label={`Reply to ${truckId}`}
        />
        <button type="submit" className="ghost" disabled={!text.trim()}>Reply</button>
      </form>
    </div>
  )
}

export default function EventFeed({ events, onReply }) {
  return (
    <section className="panel">
      <h2>Event log <span className="count">{events.length}</span></h2>
      <p className="note">
        Every view in this app is a fold over this log, so any of them can be
        rebuilt by replaying it.
      </p>
      <ul className="feed">
        {events.map((e) => (
          <li key={e.seq} className={e.type === EVENT.FORCED_STOP || e.type === EVENT.BREAKDOWN || (e.type === EVENT.INSPECTION && e.major) ? 'alarm' : undefined}>
            <time>{fmtTime(e.at)}</time>
            <span>
              <span className="who">{e.truckId || e.actor}</span> {describe(e)}
            </span>
            {onReply && e.type === EVENT.DRIVER_ACTION && REPLYABLE.includes(e.action) && (
              <ReplyForm onReply={onReply} seq={e.seq} truckId={e.truckId} />
            )}
          </li>
        ))}
        {events.length === 0 && <li><span className="note">Waiting for telemetry…</span></li>}
      </ul>
    </section>
  )
}
