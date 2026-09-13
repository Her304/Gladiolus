import { useMemo, useState } from 'react'
import { STOP_SITES, SITE_BY_ID } from '../data/corridor.js'
import { clockLeftMs, fmtClock, hosStatus } from '../engine/hos.js'
import { projectDispatch } from '../domain/dispatchProjection.js'
import { issueCommand } from '../services/serverApi.js'
import { makeCustomerToken } from '../auth/AuthContext.jsx'
import { incidentsAhead, incidentLabel } from '../services/on511.js'
import { EVENT } from '../contract.js'
import { fmtTime } from '../format.js'

/** One plain-English line for an event in the assigned driver's log. A trimmed
 *  mirror of EventFeed's describe(), scoped to the events a dispatcher needs on
 *  an in-motion assignment (no pings, no other trucks). */
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

export default function DispatchWorkflow({ events, world, incidents = [], onFocusTruck }) {
  const projection = useMemo(() => projectDispatch(events), [events])
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [linkBusy, setLinkBusy] = useState(null)
  const [replyDraft, setReplyDraft] = useState('')
  const selected = projection.loads.find((l) => l.id === selectedId) || projection.loads.find((l) => l.status === 'open') || projection.loads[0]
  const candidates = useMemo(() => {
    if (!selected) return []
    return Object.values(world.trucks)
      .filter((t) => !t.loadId || t.loadId === selected.id)
      .map((truck) => ({ truck, left: clockLeftMs(truck), status: hosStatus(truck) }))
      .sort((a, b) => b.left - a.left)
      .slice(0, 6)
  }, [world, selected?.id])
  const assignedRevenue = projection.loads.filter((l) => l.status === 'assigned').reduce((sum, l) => sum + (Number(l.revenue) || 0), 0)

  /** The assigned truck carrying the selected load. The request card is only for
   *  loads that have left the queue and been assigned to a specific driver —
   *  open/offered loads have no driver log or HOS to surface yet. */
  const assignedTruck = useMemo(() => {
    if (!selected || selected.status !== 'assigned' || !selected.truckId) return null
    return world.trucks[selected.truckId] || null
  }, [world, selected])

  /** The driver's own event log for this truck — the slice a dispatcher cares
   *  about when a load is in motion: requests, replies, arrivals, departures,
   *  inspections and breakdowns. Pings are telemetry, not narrative. */
  const driverLog = useMemo(() => {
    if (!assignedTruck) return []
    return events
      .filter((e) => e.truckId === assignedTruck.id && e.type !== EVENT.TRUCK_PING)
      .slice(-12)
      .reverse()
  }, [events, assignedTruck])

  const roadAhead = useMemo(() => {
    if (!assignedTruck) return []
    return incidentsAhead(assignedTruck, incidents).slice(0, 4)
  }, [assignedTruck, incidents])

  /** Mint a shipment-scoped customer tracking link (server-signed). The board
   *  never signs; the server returns the grant and we open it in a new tab. */
  async function openCustomerLink(shipmentId) {
    if (!shipmentId) return
    setLinkBusy(shipmentId)
    const token = await makeCustomerToken(shipmentId)
    setLinkBusy(null)
    if (token) window.open(`#/t/${token}`, '_blank')
    else setMessage('Could not mint a customer link — the server may be unavailable.')
  }

  /** Message the assigned driver directly. Threads under nothing (a fresh
   *  dispatch message, not a reply), so it reads on the driver's Today screen. */
  async function messageDriver() {
    const text = replyDraft.trim()
    if (!text || !assignedTruck) return
    setBusy('messageDriver' + assignedTruck.id)
    const result = await issueCommand({ type: 'replyDriver', truckId: assignedTruck.id, message: text })
    setMessage(result.ok ? `Message sent to ${assignedTruck.driverName}.` : `${result.error || 'Unable to message driver'}`)
    setBusy('')
    setReplyDraft('')
  }

  async function run(command, success) {
    setBusy(command.type + (command.loadId || command.exceptionId || ''))
    const result = await issueCommand(command)
    setMessage(result.ok ? success : `${result.error || 'Command failed'}${result.blockers?.length ? `: ${result.blockers.join(', ')}` : ''}`)
    setBusy('')
    return result
  }

  async function postLoad(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const stamp = Date.now().toString(36).toUpperCase()
    const id = String(f.get('loadId') || `L-${stamp}`).trim()
    const result = await run({
      type: 'postLoad',
      load: {
        id, shipmentId: String(f.get('shipmentId') || `SHP-${stamp}`).trim(),
        originId: f.get('originId'), destinationId: f.get('destinationId'),
        payloadKg: Number(f.get('payloadKg')), revenue: Number(f.get('revenue')),
        equipment: [f.get('equipment')], readyAt: Date.now(),
      },
    }, `${id} posted to the shared load queue.`)
    if (result.ok) { setSelectedId(id); e.currentTarget.reset() }
  }

  return (
    <aside className="workflow" aria-label="Dispatch workflow">
      <div className="workflow-head">
        <div><span className="eyebrow">CONTROL TOWER</span><h1>Quote → assign</h1></div>
        <div className="recovery"><b>${assignedRevenue.toLocaleString()}</b><span>assigned revenue</span></div>
      </div>

      <details className="workflow-create" open={projection.loads.length === 0}>
        <summary>New quote / load</summary>
        <form className="workflow-form" onSubmit={postLoad}>
          <div className="field-pair"><label>Load<input name="loadId" placeholder="Auto-generated" /></label><label>Shipment<input name="shipmentId" placeholder="Auto-generated" /></label></div>
          <div className="field-pair"><label>Origin<select name="originId" defaultValue="london-dc">{STOP_SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Destination<select name="destinationId" defaultValue="milton-intermodal">{STOP_SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
          <div className="field-pair"><label>Payload kg<input name="payloadKg" type="number" min="0" max="50000" defaultValue="18000" required /></label><label>Quote CAD<input name="revenue" type="number" min="1" defaultValue="1850" required /></label></div>
          <label>Equipment<select name="equipment" defaultValue="dry-van"><option value="dry-van">Dry van</option><option value="reefer">Reefer</option><option value="flatbed">Flatbed</option></select></label>
          <button className="primary-action" disabled={Boolean(busy)}>Quote & post load</button>
        </form>
      </details>

      {message && <div className="workflow-message" role="status">{message}</div>}

      <section className="workflow-section">
        <div className="workflow-title"><h2>Load queue</h2><span>{projection.loads.length}</span></div>
        {projection.loads.length === 0 && <p className="note">No loads posted. Create the first quote above or send an authenticated order webhook.</p>}
        <div className="load-list">
          {projection.loads.slice(0, 12).map((load) => (
            <button key={load.id} className={`load-card ${selected?.id === load.id ? 'active' : ''}`} onClick={() => setSelectedId(load.id)}>
              <span><b>{load.id}</b><small>{SITE_BY_ID[load.originId]?.name || load.originId} → {SITE_BY_ID[load.destinationId]?.name || load.destinationId}</small></span>
              <span><b>${Number(load.revenue || 0).toLocaleString()}</b><small className={`load-status ${load.status}`}>{load.status}</small></span>
            </button>
          ))}
        </div>
      </section>

      {selected && (
        <section className="workflow-section">
          <div className="workflow-title"><h2>Candidate comparison</h2><span>{selected.id}</span></div>
          <p className="workflow-hint">The server rechecks trip HOS, equipment, gross/axle weight, vehicle blocks, and route before creating an offer.</p>
          {candidates.length === 0 && <p className="note">No unassigned truck currently has complete candidate data.</p>}
          {candidates.map(({ truck, left, status }) => (
            <div className="candidate" key={truck.id}>
              <button className="candidate-focus" onClick={() => onFocusTruck(truck.id)}><b>{truck.id}</b><span>{truck.driverName}</span></button>
              <span className={`hos hos-${status}`}>{fmtClock(left)} HOS</span>
              <button className="ghost" disabled={selected.status !== 'open' || Boolean(busy)} onClick={() => run({ type: 'offerLoad', loadId: selected.id, driverId: truck.driverId, truckId: truck.id }, `${selected.id} offered to ${truck.driverName}.`)}>Offer</button>
            </div>
          ))}
        </section>
      )}

      {/* The request card: shown once a load is assigned. Each system assigns
          the requirements to a driver; the dispatcher receives this card with
          the one driver and route that matter, their log and hours, the road
          ahead, and the two ways out — a customer tracking link and a message
          back to the driver. */}
      {selected && assignedTruck && (
        <section className="workflow-section request-card" aria-label="Assignment request card">
          <div className="workflow-title">
            <h2>Assignment</h2>
            <span>{assignedTruck.id}</span>
          </div>

          <div className="request-head">
            <button className="candidate-focus" onClick={() => onFocusTruck(assignedTruck.id)}>
              <b>{assignedTruck.driverName}</b>
              <span>{assignedTruck.id} · {SITE_BY_ID[selected.originId]?.name || selected.originId} → {SITE_BY_ID[selected.destinationId]?.name || selected.destinationId}</span>
            </button>
            <button className="primary-action request-link" disabled={linkBusy === selected.shipmentId} onClick={() => openCustomerLink(selected.shipmentId)}>
              {linkBusy === selected.shipmentId ? 'Minting…' : 'Customer link'}
            </button>
          </div>

          {/* Driver's hours of service */}
          <div className="request-row">
            <span className="request-label">Hours of service</span>
            <span className={`hos hos-${hosStatus(assignedTruck)}`}>{fmtClock(clockLeftMs(assignedTruck))} left</span>
          </div>

          {/* Current or future road status on the driver's route */}
          <div className="request-block">
            <span className="request-label">Road status ahead</span>
            {roadAhead.length === 0
              ? <small className="note">No incidents reported between here and {SITE_BY_ID[selected.destinationId]?.name || 'the destination'}.</small>
              : <ul className="request-log">
                  {roadAhead.map((inc) => (
                    <li key={inc.id}>
                      <span className={`request-badge ${inc.fullClosure ? 'closure' : ''}`}>{incidentLabel(inc.type)}</span>
                      <small>{Math.round(inc.ahead)} km ahead · {inc.fullClosure ? 'Full closure' : 'Lanes open'}</small>
                    </li>
                  ))}
                </ul>}
          </div>

          {/* The driver's log — the same narrative fold the event feed uses,
              scoped to this truck only */}
          <div className="request-block">
            <span className="request-label">Driver log</span>
            {driverLog.length === 0
              ? <small className="note">No driver events recorded yet.</small>
              : <ul className="request-log">
                  {driverLog.map((e) => (
                    <li key={e.seq}>
                      <time>{fmtTime(e.at)}</time>
                      <span>{describeDriverEvent(e)}</span>
                    </li>
                  ))}
                </ul>}
          </div>

          {/* Contact the driver or the customer */}
          <div className="request-block">
            <span className="request-label">Contact driver</span>
            <form className="request-reply" onSubmit={(e) => { e.preventDefault(); messageDriver() }}>
              <input
                type="text"
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder={`Message ${assignedTruck.driverName}…`}
                maxLength={1000}
                aria-label={`Message ${assignedTruck.driverName}`}
              />
              <button className="ghost" type="submit" disabled={!replyDraft.trim() || Boolean(busy)}>Send</button>
            </form>
          </div>
        </section>
      )}

      <section className="workflow-section">
        <div className="workflow-title"><h2>Owned exceptions</h2><span>{projection.exceptions.length}</span></div>
        {projection.exceptions.slice(0, 6).map((item) => (
          <div className="owned-exception" key={item.id}>
            <b>{item.reason || 'Operational exception'}</b>
            <span>{item.affectedTruck || item.shipmentId || item.loadId} · {item.owner || 'unowned'} · {item.state}</span>
            <div>
              {item.state === 'open' && <button className="ghost" onClick={() => run({ type: 'acknowledgeException', exceptionId: item.id }, 'Exception acknowledged and owned.')}>Own</button>}
              <button className="ghost" onClick={() => run({ type: 'resolveException', exceptionId: item.id, resolution: 'resolved from dispatch board' }, 'Exception resolved.')}>Resolve</button>
            </div>
          </div>
        ))}
        {projection.exceptions.length === 0 && <p className="note">No unresolved assignment or safety exceptions.</p>}
      </section>
    </aside>
  )
}
