import { useEffect, useMemo, useState } from 'react'
import { SITE_BY_ID, STOP_SITES } from '../data/corridor.js'
import { clockLeftMs, fmtClock, hosStatus } from '../engine/hos.js'
import { issueCommand } from '../services/serverApi.js'
import { makeCustomerToken } from '../auth/AuthContext.jsx'
import { incidentsAhead, incidentLabel } from '../services/on511.js'
import { EVENT } from '../contract.js'
import { fmtTime } from '../format.js'

/**
 * One plain-English line for an event in a driver's log — a trimmed mirror of
 * EventFeed's describe(), scoped to what a dispatcher needs on an in-motion task
 * (no pings, no other trucks).
 */
function describeDriverEvent(e) {
  switch (e.type) {
    case EVENT.FENCE_ENTER: return `arrived at ${e.siteName}`
    case EVENT.FENCE_EXIT:
      return e.dwellMin >= 5 ? `left ${e.siteName} after ${e.dwellMin} min` : `passed ${e.siteName}`
    case EVENT.LOAD_ASSIGNED: return `picked up ${e.loadId}`
    case EVENT.LOAD_DELIVERED: return `delivered ${e.loadId} at ${e.siteName}`
    case EVENT.BREAK_START: return `started a 10-hour reset at ${e.siteName}`
    case EVENT.BREAK_END: return `back in service from ${e.siteName}`
    case EVENT.PARKING_CLAIM: return `holding a space at ${e.siteName}`
    case EVENT.PARKING_RELEASE: return `released a space at ${e.siteName}`
    case EVENT.FORCED_STOP: return `out of hours, ${e.shortfallKm} km short of ${e.nearestSiteName}`
    case EVENT.DRIVER_ACTION:
      if (e.action === 'dispatch.replied') return `dispatch replied${e.message ? ` — ${e.message}` : ''}`
      return `${e.action.replaceAll('.', ' ')}${e.message ? ` — ${e.message}` : ''}`
    case EVENT.INSPECTION: return `${e.major ? 'failed' : 'flagged'} a ${e.phase} inspection`
    case EVENT.BREAKDOWN: return `breakdown at km ${Math.round(e.chainage)}`
    case EVENT.BREAKDOWN_CLEARED: return 'rolling again after a breakdown'
    case EVENT.STOP_ARRIVED: return `arrived at stop ${e.stopId}`
    case EVENT.STOP_CHECKED_IN: return `checked in at stop ${e.stopId}`
    case EVENT.STOP_SERVICE_STARTED: return `service started at stop ${e.stopId}`
    case EVENT.STOP_SERVICE_COMPLETED: return `service completed at stop ${e.stopId}`
    case EVENT.STOP_DEPARTED: return `departed stop ${e.stopId}`
    default: return e.type
  }
}

/** Resolve the start and end locations for a truck's active task. The
 *  destination is authoritative on the truck; the origin is the posted
 *  shipment's pickup if we have it, else the truck's current site, else the
 *  nearest corridor stop — so the card always reads "from → to". */
function resolveRoute(truck, events) {
  const destinationId = truck.destinationId
  let originId = null
  const key = truck.shipmentId || (truck.loadId ? `SHP-${truck.loadId}` : null)
  if (key) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type === 'shipment.posted' && (e.shipmentId === key || e.loadId === truck.loadId)) {
        originId = e.originId || e.stops?.[0]
        break
      }
    }
  }
  if (!originId) originId = truck.insideSiteId
  if (!originId && Number.isFinite(truck.chainage)) {
    let best = null, bestD = Infinity
    for (const s of STOP_SITES) {
      const d = Math.abs(s.chainage - truck.chainage)
      if (d < bestD) { bestD = d; best = s }
    }
    originId = best?.id
  }
  return {
    originId,
    destinationId,
    originName: SITE_BY_ID[originId]?.name || originId || 'Current position',
    destinationName: SITE_BY_ID[destinationId]?.name || destinationId || 'Pending',
  }
}

const SITE = (id) => SITE_BY_ID[id]?.name || id

/**
 * A single active task in the right rail. Compact by default: the driver, their
 * route, and the one number a dispatcher watches (hours of service). "Details"
 * expands the card to the assignment view — customer link, driver log, road
 * ahead, HOS, and contact — and isolates the centre map on this one driver and
 * their route.
 */
export default function TaskCard({ truck, events, incidents, expanded, onToggle, onFocusTruck }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkUrl, setLinkUrl] = useState(null)
  const [copied, setCopied] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')

  // Reset the minted link whenever the dispatcher switches task cards, so a URL
  // minted for one shipment is never shown against another. The token itself
  // stays valid server-side; only the local field is cleared.
  useEffect(() => { setLinkUrl(null); setCopied(false) }, [truck.id, expanded])

  const route = useMemo(() => resolveRoute(truck, events), [truck, events])
  const status = hosStatus(truck)
  const left = clockLeftMs(truck)

  const driverLog = useMemo(() => {
    return events
      .filter((e) => e.truckId === truck.id && e.type !== EVENT.TRUCK_PING)
      .slice(-10)
      .reverse()
  }, [events, truck.id])

  const roadAhead = useMemo(
    () => incidentsAhead(truck, incidents).slice(0, 4),
    [truck, incidents],
  )

  async function messageDriver(e) {
    e.preventDefault()
    const text = replyDraft.trim()
    if (!text) return
    setBusy(true)
    const result = await issueCommand({ type: 'replyDriver', truckId: truck.id, message: text })
    setMessage(result.ok ? `Message sent to ${truck.driverName}.` : `${result.error || 'Unable to message driver'}`)
    setBusy(false)
    setReplyDraft('')
  }

  // Mint a shipment-scoped customer tracking link and surface the full URL so a
  // dispatcher can copy it and hand it to the customer. The grant is durable
  // (server-signed, expiring) so the same URL keeps working for this shipment's
  // whole lifecycle — including after delivery, when the truck has moved on to
  // its next load.
  async function openCustomerLink() {
    if (!truck.shipmentId) return
    setLinkBusy(true)
    setCopied(false)
    const token = await makeCustomerToken(truck.shipmentId)
    setLinkBusy(false)
    if (token) {
      const url = `${window.location.origin}${window.location.pathname}#/t/${token}`
      setLinkUrl(url)
      setMessage(`Client link ready for ${truck.shipmentId}.`)
    } else {
      setLinkUrl(null)
      setMessage('Could not mint a client link — the server may be unavailable.')
    }
  }

  async function copyCustomerLink() {
    if (!linkUrl) return
    try {
      await navigator.clipboard.writeText(linkUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be unavailable (non-secure context); fall back to
      // selecting the readonly field so the dispatcher can copy manually.
      const input = document.getElementById('task-customer-link-url')
      input?.select()
      setMessage('Copy the selected link.')
    }
  }

  return (
    <article className={`task-card ${expanded ? 'expanded' : ''}`}>
      <header className="task-head">
        <button className="task-identity" onClick={() => onFocusTruck(truck.id)}>
          <b>{truck.driverName}</b>
          <small>{truck.id} · {truck.laden ? `load ${truck.loadId}` : 'empty'} · {truck.parked ? 'Parked' : `${truck.speedKph} km/h`}</small>
        </button>
        <span className={`hos hos-${status}`}>{fmtClock(left)} left</span>
      </header>

      <div className="task-route">
        <span>{route.originName}</span>
        <span className="task-arrow" aria-hidden="true">→</span>
        <span>{route.destinationName}</span>
      </div>

      <div className="task-actions">
        <button className="ghost" onClick={() => onToggle(truck.id)}>
          {expanded ? 'Hide details' : 'Details'}
        </button>
      </div>

      {expanded && (
        <div className="task-detail">
          {message && <div className="task-message" role="status">{message}</div>}

          {/* 1. Customer portal link — a shipment-scoped tracking URL the
              dispatcher can copy and hand to the customer. It follows this one
              shipment's lifecycle (not the truck's next destination), so it stays
              valid after delivery. */}
          <div className="task-section">
            <span className="task-label">
              Client portal{truck.shipmentId ? ` · ${truck.shipmentId}` : ''}
            </span>
            {!linkUrl ? (
              <button
                className="primary-action task-link"
                disabled={!truck.shipmentId || linkBusy}
                onClick={openCustomerLink}
                title={truck.shipmentId ? 'Mint a shipment-scoped tracking link to copy and send' : 'No shipment linked to this task yet'}
              >
                {linkBusy ? 'Minting…' : truck.shipmentId ? 'Get client link' : 'No shipment linked'}
              </button>
            ) : (
              <div className="task-link-row">
                <input
                  id="task-customer-link-url"
                  className="task-link-url"
                  value={linkUrl}
                  readOnly
                  onFocus={(e) => e.target.select()}
                  aria-label="Client tracking link"
                />
                <button
                  className="ghost task-link-btn"
                  onClick={copyCustomerLink}
                  title="Copy the tracking link to the clipboard"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <a
                  className="ghost task-link-btn"
                  href={linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the client portal in a new tab"
                >
                  Open
                </a>
                <button
                  className="ghost task-link-btn task-link-redo"
                  onClick={openCustomerLink}
                  disabled={linkBusy}
                  title="Mint a fresh link"
                >
                  ↻
                </button>
              </div>
            )}
          </div>

          {/* 5. Hours of service */}
          <div className="task-section">
            <span className="task-label">Hours of service</span>
            <span className={`hos hos-${status}`}>{fmtClock(left)} drive/duty left</span>
          </div>

          {/* 4. Current or future road status */}
          <div className="task-section">
            <span className="task-label">Road status ahead</span>
            {roadAhead.length === 0 ? (
              <small className="note">No incidents between here and {SITE(route.destinationId)}.</small>
            ) : (
              <ul className="task-log">
                {roadAhead.map((inc) => (
                  <li key={inc.id}>
                    <span className={`task-badge ${inc.fullClosure ? 'closure' : ''}`}>{incidentLabel(inc.type)}</span>
                    <small>{Math.round(inc.ahead)} km ahead · {inc.fullClosure ? 'Full closure' : 'Lanes open'}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 3. The driver's log */}
          <div className="task-section">
            <span className="task-label">Driver log</span>
            {driverLog.length === 0 ? (
              <small className="note">No driver events recorded yet.</small>
            ) : (
              <ul className="task-log">
                {driverLog.map((e) => (
                  <li key={e.seq}>
                    <time>{fmtTime(e.at)}</time>
                    <span>{describeDriverEvent(e)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 6. Contact the driver */}
          <div className="task-section">
            <span className="task-label">Contact driver</span>
            <form className="task-reply" onSubmit={messageDriver}>
              <input
                type="text"
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder={`Message ${truck.driverName}…`}
                maxLength={1000}
                aria-label={`Message ${truck.driverName}`}
              />
              <button className="ghost" type="submit" disabled={!replyDraft.trim() || busy}>Send</button>
            </form>
          </div>
        </div>
      )}
    </article>
  )
}
