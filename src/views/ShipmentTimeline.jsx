/**
 * Shipment timeline (Phase 2 — dispatcher surface).
 *
 * The joined view the assessment said was missing: a shipment/stop timeline
 * that joins GPS evidence, duty state, driver actions, appointment changes,
 * and billing events on one screen (plan §5 Phase 2). It projects one
 * shipment's events through `projectShipment().timeline`, so a dispatcher sees
 * the whole sequence — milestones, detention, exceptions — in order.
 */
import { useMemo, useState } from 'react'
import { useEvents } from '../useStore.js'
import { projectShipment, createShipment } from '../domain/shipment.js'
import { DEFAULT_DETENTION_RULE } from '../domain/contract.js'
import { fmtTime } from '../format.js'

export default function ShipmentTimeline() {
  const events = useEvents()
  const shipments = useMemo(() => {
    const ids = [...new Set((events || []).map((e) => e.shipmentId).filter(Boolean))]
    return ids.map((id) => {
      const shipEvents = events.filter((e) => e.shipmentId === id)
      const stopIds = [...new Set(shipEvents.map((e) => e.stopId).filter(Boolean))]
      const stops = stopIds.length >= 2
        ? stopIds.map((sid, i) => ({ id: sid, shipmentId: id, sequence: i, role: i === 0 ? 'pickup' : 'delivery', facilityId: null, milestone: 'none', visit: null }))
        : [{ id: 'STP-pu', role: 'pickup' }, { id: stopIds[0] || 'STP-dl', role: 'delivery' }]
      try {
        const ship = createShipment({ id, kind: 'ftl', stops })
        return projectShipment(shipEvents, ship, DEFAULT_DETENTION_RULE)
      } catch {
        return null
      }
    }).filter(Boolean)
  }, [events])

  const [selected, setSelected] = useState(null)
  const current = shipments.find((s) => s.id === selected) || shipments[0]

  if (!current) {
    return (
      <div className="page">
        <div className="card">
          <h2>Shipment timeline</h2>
          <p className="muted">No shipments have been posted yet. As trucks complete visits, shipments appear here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="card">
        <div className="card-head">
          <h2>Shipment timeline</h2>
          <span className="muted">{shipments.length} shipment{shipments.length === 1 ? '' : 's'}</span>
        </div>

        <div className="shipment-tabs">
          {shipments.slice(0, 12).map((s) => (
            <button key={s.id} className={s.id === current.id ? 'active' : ''} onClick={() => setSelected(s.id)}>
              {s.id} <span className="muted">· {s.status}</span>
            </button>
          ))}
        </div>

        <div className="timeline-status">
          <span className="t-label">Status</span>
          <span className={`state state-${s2state(current.status)}`}>{current.status}</span>
          {current.ledger.length > 0 && (
            <span className="state state-eligible">
              {Math.round(current.ledger[0].billableMinutes)} billable min · {current.ledger[0].state}
            </span>
          )}
        </div>

        <div className="timeline-stops">
          {current.stops.map((s) => (
            <div key={s.id} className="timeline-stop">
              <span className="t-label">{s.role}</span>
              <span className="milestone m-{s.milestone}">{s.milestone}</span>
              <span className="muted">{s.id}</span>
            </div>
          ))}
        </div>

        <h3>Event timeline</h3>
        <div className="shipment-timeline-list">
          {current.timeline.map((t, i) => (
            <div key={i} className="timeline-event">
              <time>{fmtTime(t.at)}</time>
              <span className={`timeline-dot dot-${category(t.type)}`} />
              <span>
                <strong>{t.summary}</strong>
                <small className="muted"> {t.source}</small>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function s2state(status) {
  return { posted: 'calculated', assigned: 'eligible', in_progress: 'eligible', completed: 'reviewed', cancelled: 'waived' }[status] || 'calculated'
}

function category(type) {
  if (type.startsWith('stop.')) return 'milestone'
  if (type.startsWith('detention.')) return 'billing'
  if (type.startsWith('exception.')) return 'exception'
  if (type.startsWith('assignment.')) return 'assignment'
  return 'shipment'
}
