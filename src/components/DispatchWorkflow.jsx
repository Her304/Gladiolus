import { useMemo, useState } from 'react'
import { STOP_SITES, SITE_BY_ID } from '../data/corridor.js'
import { clockLeftMs, fmtClock, hosStatus } from '../engine/hos.js'
import { projectDispatch } from '../domain/dispatchProjection.js'
import { issueCommand } from '../services/serverApi.js'
import { deadheadKm } from '../engine/geo.js'

export default function DispatchWorkflow({ events, world, onFocusTruck }) {
  const projection = useMemo(() => projectDispatch(events), [events])
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const selected = projection.loads.find((l) => l.id === selectedId) || projection.loads.find((l) => l.status === 'open') || projection.loads[0]
  const origin = selected ? SITE_BY_ID[selected.originId] : null
  const candidates = useMemo(() => {
    if (!selected || !origin) return []
    return Object.values(world.trucks)
      .filter((t) => !t.loadId || t.loadId === selected.id)
      .map((truck) => ({ truck, left: clockLeftMs(truck), status: hosStatus(truck), deadhead: deadheadKm(truck, origin) }))
      // Nearest-feasible first: deadhead asc (unknown after known), then most
      // remaining HOS. Replaces the prior HOS-left-only ordering so the
      // dispatcher sees the least-empty-running truck on top.
      .sort((a, b) => {
        if (a.deadhead == null && b.deadhead == null) return b.left - a.left
        if (a.deadhead == null) return 1
        if (b.deadhead == null) return -1
        if (a.deadhead !== b.deadhead) return a.deadhead - b.deadhead
        return b.left - a.left
      })
      .slice(0, 6)
  }, [world, selected?.id, origin])
  const assignedRevenue = projection.loads.filter((l) => l.status === 'assigned').reduce((sum, l) => sum + (Number(l.revenue) || 0), 0)

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
          <p className="workflow-hint">The server rechecks trip HOS, equipment, gross/axle weight, vehicle blocks, and route before creating an offer. Candidates are ranked by deadhead to pickup.</p>
          {candidates.length === 0 && <p className="note">No unassigned truck currently has complete candidate data.</p>}
          {candidates.map(({ truck, left, status, deadhead }, i) => (
            <div className="candidate" key={truck.id}>
              <button className="candidate-focus" onClick={() => onFocusTruck(truck.id)}><b>{truck.id}</b><span>{truck.driverName}{i === 0 && deadhead != null ? ' · nearest' : ''}</span></button>
              <span className="deadhead">{deadhead != null ? `${Math.round(deadhead)} km` : '— km'}</span>
              <span className={`hos hos-${status}`}>{fmtClock(left)} HOS</span>
              <button className="ghost" disabled={selected.status !== 'open' || Boolean(busy)} onClick={() => run({ type: 'offerLoad', loadId: selected.id, driverId: truck.driverId, truckId: truck.id }, `${selected.id} offered to ${truck.driverName}.`)}>Offer</button>
            </div>
          ))}
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
