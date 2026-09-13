/**
 * Detention ledger view (Phase 2 — dispatcher surface).
 *
 * The exception queue is led by stops approaching free time, claims awaiting
 * review, and missing evidence (plan §5 Phase 2). This view projects the
 * detention ledger from the event log: each delivery stop that has accumulated
 * visit evidence, with its calculated boundary, free/billable minutes, rate,
 * rounding, amount, uncertainty, and review state. The evidence package is
 * exportable.
 */
import { useMemo, useState } from 'react'
import { useEvents } from '../useStore.js'
import { useAuth, isAdmin } from '../auth/AuthContext.jsx'
import { issueCommand, exportReviewedDetention } from '../services/serverApi.js'
import { projectShipment, createShipment } from '../domain/shipment.js'
import { DEFAULT_DETENTION_RULE } from '../domain/contract.js'
import { fmtTime } from '../format.js'

const H = 3600_000

export default function DetentionLedger() {
  const events = useEvents()
  const { user } = useAuth()
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const { entries, exceptions } = useMemo(() => projectLedger(events), [events])

  async function transition(entry, type, reason) {
    setBusy(`${entry.claimId}:${type}`)
    const result = await issueCommand({
      type, claimId: entry.claimId, shipmentId: entry.shipmentId,
      stopId: entry.stopId, reason,
    })
    setMessage(result.ok ? `Claim ${entry.claimId} ${result.state}.` : result.error || 'Command failed.')
    setBusy('')
  }

  async function exportBilling() {
    setBusy('billing')
    const result = await exportReviewedDetention()
    setMessage(result.ok ? `${result.exported} reviewed claim${result.exported === 1 ? '' : 's'} exported to billing.` : result.error || 'Export failed.')
    setBusy('')
  }

  return (
    <div className="page">
      <div className="card">
        <div className="card-head">
          <h2>Detention ledger</h2>
          <span className="muted">Two-hour free time · live FTL · {entries.length} stop{entries.length === 1 ? '' : 's'}</span>
        </div>
        <div className="ledger-toolbar">
          <span className="muted">Review creates the approval event; billing export sends only reviewed claims.</span>
          {isAdmin(user) && <button className="ghost" disabled={busy === 'billing'} onClick={exportBilling}>{busy === 'billing' ? 'Exporting…' : 'Export reviewed to billing'}</button>}
        </div>
        {message && <p className="banner" role="status">{message}</p>}

        {exceptions.length > 0 && (
          <div className="exception-queue">
            <h3>Needs attention ({exceptions.length})</h3>
            {exceptions.map((x, i) => (
              <div key={i} className={`exception-row ex-${x.severity}`}>
                <span className="ex-stop">{x.stopId}</span>
                <span className="ex-reason">{x.reason}</span>
                <span className="ex-state">{x.state}</span>
              </div>
            ))}
          </div>
        )}

        {entries.length === 0 ? (
          <p className="muted">No delivery stops have accumulated visit evidence yet.</p>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Shipment</th><th>Stop</th><th>Arrived</th><th>Service complete</th>
                <th>Free min</th><th>Billable min</th><th>Rate</th><th>Amount</th>
                <th>State</th><th>Uncertainty</th><th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td>{e.shipmentId}</td>
                  <td>{e.stopId}</td>
                  <td>{e.arrived ? fmtTime(e.arrived) : '—'}</td>
                  <td>{e.serviceComplete ? fmtTime(e.serviceComplete) : '—'}</td>
                  <td>{e.freeMinutes}</td>
                  <td><b>{Math.round(e.billableMinutes)}</b></td>
                  <td>{e.ratePerHour}/{e.currency}</td>
                  <td>{e.amount} {e.currency}</td>
                  <td><span className={`state state-${e.state}`}>{e.state}</span></td>
                  <td className="muted">{e.uncertainty || '—'}</td>
                  <td>
                    <div className="ledger-actions">
                      {e.state === 'calculated' && <button className="ghost" disabled={Boolean(busy)} onClick={() => transition(e, 'reviewDetention')}>Review</button>}
                      {['calculated', 'reviewed', 'adjusted'].includes(e.state) && <button className="ghost" disabled={Boolean(busy)} onClick={() => transition(e, 'waiveDetention', 'waived in detention ledger')}>Waive</button>}
                      <button className="ghost" onClick={() => exportEvidence(e)}>Evidence JSON</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/** Project the ledger from accumulated stop-visit events. */
export function projectLedger(allEvents) {
  // Collect visit/shipment/detention events. In the browser-local fallback these
  // come from the in-memory store; when the server client is connected they
  // arrive via the SSE stream and are appended here.
  const events = (allEvents || []).filter((e) =>
    e.type.startsWith('stop.') || e.type.startsWith('shipment.') || e.type.startsWith('assignment.') || e.type.startsWith('detention.')
  )
  const byShipment = new Map()
  for (const e of events) {
    if (!e.shipmentId) continue
    if (!byShipment.has(e.shipmentId)) byShipment.set(e.shipmentId, [])
    byShipment.get(e.shipmentId).push(e)
  }
  const entries = []
  const exceptions = []
  for (const [shipmentId, evs] of byShipment) {
    const posted = evs.find((e) => e.type === 'shipment.posted')
    const observedStopIds = [...new Set(evs.map((e) => e.stopId).filter(Boolean))]
    const declaredStopIds = (posted?.stops || []).filter(Boolean)
    let stopIds = [...new Set([...declaredStopIds, ...observedStopIds])]
    if (stopIds.length === 1) stopIds = [`${shipmentId}:pickup`, stopIds[0]]
    if (stopIds.length === 0) continue
    const stops = stopIds.map((id, i) => ({
      id, shipmentId, sequence: i, role: i === stopIds.length - 1 ? 'delivery' : 'pickup',
      facilityId: id, milestone: 'none', visit: null,
    }))
    const ship = createShipment({ id: shipmentId, kind: 'ftl', stops })
    const proj = projectShipment(evs, ship, DEFAULT_DETENTION_RULE)
    for (const entry of proj.ledger) {
      entries.push(entry)
      // Exception queue: approaching free time, awaiting review, missing evidence
      if (entry.uncertainty) exceptions.push({ stopId: entry.stopId, reason: entry.uncertainty, state: entry.state, severity: 'warn' })
      if (entry.state === 'eligible' && entry.billableMinutes > 0) exceptions.push({ stopId: entry.stopId, reason: `${Math.round(entry.billableMinutes)} billable min awaiting review`, state: entry.state, severity: 'info' })
    }
  }
  return { entries, exceptions }
}

/** Export the detention evidence package as a downloadable JSON document. */
function exportEvidence(entry) {
  const doc = {
    documentType: 'detention-evidence',
    schemaVersion: 2,
    stopId: entry.stopId,
    shipmentId: entry.shipmentId,
    facilityId: entry.facilityId,
    contract: { ruleId: entry.ruleId, contractVersion: entry.contractVersion, currency: entry.currency, ratePerHour: entry.ratePerHour },
    milestones: {
      arrived: entry.arrived, checkedIn: entry.checkedIn, serviceStart: entry.serviceStart,
      serviceComplete: entry.serviceComplete, departed: entry.departed, appointment: entry.appointment,
    },
    calculation: {
      freeStart: entry.freeStart, chargeEnd: entry.chargeEnd,
      freeMinutes: entry.freeMinutes, chargeableMinutes: entry.chargeableMinutes,
      billableMinutes: entry.billableMinutes, roundedMinutes: entry.roundedMinutes, amount: entry.amount,
    },
    state: entry.state,
    generatedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `detention-${entry.shipmentId}-${entry.stopId}.json`
  a.click()
  URL.revokeObjectURL(url)
}
