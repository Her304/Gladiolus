import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { StoreContext, SimContext, useStore, useWorld, useSim } from '../useStore.js'
import { SITE_BY_ID, facilitiesOf, VENDOR_BY_ID, vendorsNear, PARKING_SITES, SCALE_SITES } from '../data/corridor.js'
import { SEED_DRIVERS } from '../data/seed.js'
import { pressureBoard, recommendParking } from '../engine/parking.js'
import { scalesAhead } from '../engine/scales.js'
import { inspectionState, inspections, defectLabels, hasMajor } from '../engine/inspection.js'
import { openBreakdown, respondersFor, CATEGORY_BY_ID } from '../engine/breakdown.js'
import { incidentsAhead, incidentLabel, INITIAL_INCIDENTS } from '../services/on511.js'
import { clockLeftMs, fmtClock, H } from '../engine/hos.js'
import { EVENT, INSPECTION_ITEMS, BREAKDOWN_CATEGORIES, INSPECTION_VALID_H } from '../contract.js'
import { createDriverDemo, DEMO_ID, SCENES, driverActions, latestOffer, hosRings, dutySegments, loadHistory, recordAction } from './model.js'
import DriverMap from './DriverMap.jsx'
import ShipmentVisit from './ShipmentVisit.jsx'
import { issueCommand } from '../services/serverApi.js'
import { SERVER_ENABLED } from '../services/serverConfig.js'
import { fmtDate, fmtTime } from '../format.js'
import './driver.css'

const time = fmtTime
const date = fmtDate
const initials = s => s?.split(' ').map(x => x[0]).slice(0, 2).join('') || 'DR'
function Icon({ name, ...props }) {
  const paths = { today: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z', log: 'M4 5h16M4 12h16M4 19h11', parking: 'M6 21V3h7a6 6 0 0 1 0 12H6', me: 'M20 21a8 8 0 0 0-16 0M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8', back: 'm14 5-7 7 7 7', arrow: 'm9 5 7 7-7 7', locate: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10', overview: 'M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 12h8', navigate: 'm12 3 7 18-7-4-7 4Z', check: 'm4 12 5 5L20 6', bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4', truck: 'M2 6h12v12H2ZM14 10h5l3 5v3h-8M5 18v3M18 18v3', help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4M12 18v1', close: 'm6 6 12 12M6 18 18 6',
    ahead: 'M12 3v18M12 6h7l2 2.5-2 2.5h-7M12 13H5l-2 2.5L5 18h7',
    scale: 'M12 5v15M8.5 20h7M4 9h16M6.5 9 4 14.5h5ZM17.5 9 15 14.5h5Z',
    wrench: 'M20 5a4 4 0 0 1-5 5l-6 6a2 2 0 1 1-3-3l6-6a4 4 0 0 1 5-5l-2.5 2.5 2 2Z',
    alert: 'M12 3 2.5 19.5h19ZM12 10v4.5M12 17.2v.3',
    clipboard: 'M9 4h6v3H9ZM9 5.5H6V20h12V5.5h-3M8.5 12h7M8.5 16h4.5',
    phone: 'M7 3h3l2 5-2.5 1.5a12 12 0 0 0 5 5L16 12l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4 5.2 2 2 0 0 1 6 3Z' }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.arrow} /></svg>
}
function Button({ children, secondary, ...p }) { return <button className={`dp-button ${secondary ? 'dp-secondary' : ''}`} {...p}>{children}</button> }
function Row({ title, sub, onClick, icon }) { return <button className="dp-row" onClick={onClick}>{icon && <Icon name={icon} />}<span><strong>{title}</strong>{sub && <small>{sub}</small>}</span><Icon name="arrow" /></button> }
function Rings({ truck }) { return <div className="dp-rings">{hosRings(truck).map(({ label, used, limit, status }) => <div className={`dp-ring ${status}`} key={label} aria-label={`${label}: ${used == null ? 'unavailable' : `${fmtClock(used)} used of ${fmtClock(limit)}`}`}><div className="dp-dial"><svg viewBox="0 0 80 80" aria-hidden="true"><circle className="track" cx="40" cy="40" r="34" /><circle className="progress" cx="40" cy="40" r="34" strokeDasharray={`${Math.max(0, Math.min(1, (used || 0) / limit)) * 214} 214`} /></svg><span><b>{used == null ? '—' : fmtClock(used)}</b><small>/{fmtClock(limit)}</small></span></div><label>{label}</label></div>)}</div> }
function Identity({ truck }) { return <div className="dp-identity"><span className="dp-avatar">{initials(truck.driverName)}</span><span><strong>{truck.driverName}</strong><small>{truck.id} · {truck.plate}</small></span><span className="dp-pill">{truck.state === 'driving' ? 'Driving' : truck.state === 'resting' ? 'Resting' : 'On duty'}</span></div> }
function Empty({ title, children, action }) { return <div className="dp-empty"><span className="dp-symbol"><Icon name="check" /></span><h2>{title}</h2><p>{children}</p>{action}</div> }
/** Facilities are secondary to parking, so they read as quiet qualifiers. */
function Facilities({ site }) {
  const list = facilitiesOf(site)
  if (!list.length) return <p className="dp-footnote">No facility information recorded for this stop.</p>
  return <ul className="dp-chips" aria-label="Facilities at this stop">{list.map(f => <li key={f.id} className={f.key ? 'key' : ''}>{f.label}</li>)}</ul>
}
function Segmented({ value, onChange }) {
  return <div className="dp-segmented" role="tablist" aria-label="What is ahead on your route">{[['parking','Parking'],['scales','Scales'],['service','Service'],['conditions','Traffic']].map(([k,l]) =>
    <button key={k} role="tab" aria-selected={value===k} onClick={()=>onChange(k)}>{l}</button>)}</div>
}
const SCALE_COPY = { open: ['Open', 'ok'], 'likely-open': ['Likely open', 'ok'], unknown: ['Not known', 'muted'], 'likely-closed': ['Likely closed', 'quiet'], closed: ['Closed', 'quiet'] }
function ScaleBadge({ status }) {
  const [label, tone] = SCALE_COPY[status.level] || SCALE_COPY.unknown
  return <span className={`dp-badge ${tone}`}>{label}</span>
}
function DutyChart({ segments, now }) {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const x = at => 64 + Math.max(0, Math.min(1, (at - start.getTime()) / (24 * H))) * 270
  const ys = { 'Off duty': 25, Sleeper: 53, Driving: 81, 'On duty': 109 }
  const today = segments.filter((s, i) => (segments[i+1]?.at || now) >= start.getTime())
  let d = ''
  today.forEach((s, i) => { const from = x(s.at), to = x(today[i+1]?.at || now); d += `${i ? 'L' : 'M'}${from},${ys[s.state]} H${to} ` })
  return <svg className="dp-duty-chart" viewBox="0 0 350 145" role="img" aria-label="Duty timeline for today; only recorded periods are shown">
    {Object.entries(ys).map(([s,y])=><g key={s}><text x="0" y={y+4}>{s}</text><line x1="64" x2="334" y1={y} y2={y}/></g>)}
    {[0,6,12,18,24].map(h=><text key={h} x={64+h/24*270} y="138" textAnchor="middle">{String(h).padStart(2,'0')}</text>)}
    <path d={d} /><circle cx={x(now)} cy={ys[today.at(-1)?.state] || 25} r="3" />
  </svg>
}
function useRoute(demo) {
  const prefix = demo ? '/driver-demo' : '/driver'
  const read = () => { const h = location.hash.slice(1); return h.startsWith(prefix + '/') ? h.slice(prefix.length + 1) : 'today' }
  const [route, setRoute] = useState(read)
  useEffect(() => { const fn = () => setRoute(read()); window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn) }, [prefix])
  return [route, path => { location.hash = `${prefix}/${path}` }]
}

export function DriverSignIn() {
  const { signInDriver } = useAuth()
  const [error, setError] = useState('')
  async function submit(e) {
    e.preventDefault(); const d = new FormData(e.currentTarget)
    const r = await signInDriver(d.get('truck'), d.get('pin'))
    if (!r.ok) setError(r.error); else location.hash = '/driver/today'
  }
  return <div className="dp-shell"><main className="dp-login"><a className="dp-wordmark" href="#/board">Gladiolus<span>DRIVER</span></a><div className="dp-login-art"><Icon name="truck" /><span>Every mile, a little clearer.</span></div><section className="dp-card"><div className="dp-heading"><span className="dp-eyebrow">WELCOME BACK</span><h1>Ready for the road?</h1><p>Sign in to your assigned truck.</p></div><form className="dp-form" onSubmit={submit}><label>Truck number<input name="truck" required defaultValue={SEED_DRIVERS[0].truckId} autoComplete="username" /></label><label>Driver PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required autoComplete="current-password" /></label>{error && <p role="alert" className="dp-error">{error}</p>}<Button type="submit">Start my shift</Button></form><a className="dp-text-link" href="#/driver-demo/today">Explore the interactive demo →</a><p className="dp-footnote">Credentials are verified by the shared server.</p></section></main></div>
}
export function DriverDemo() {
  const [controller] = useState(createDriverDemo)
  useEffect(() => { const t = setInterval(controller.tick, 1000); return () => clearInterval(t) }, [controller])
  return <StoreContext.Provider value={controller.store}><SimContext.Provider value={null}><DriverPortal demoController={controller} /></SimContext.Provider></StoreContext.Provider>
}

export default function DriverPortal({ demoController, incidents = INITIAL_INCIDENTS }) {
  const demo = !!demoController, { user, signOut } = useAuth(), store = useStore(), sim = useSim(), world = useWorld(), events = store.events
  const truckId = demo ? DEMO_ID : user?.truckId, truck = world.trucks[truckId]
  const [route, go] = useRoute(demo), [screen, siteId] = route.split('/')
  const [toast, setToast] = useState(''), [error, setError] = useState(''), [recenter, setRecenter] = useState(0)
  const [navigating, setNavigating] = useState(Boolean(truck?.loadId)), [sheet, setSheet] = useState('medium')
  const [mapMode, setMapMode] = useState('overview')
  const scroller = useRef(null), heading = useRef(null), preserveSheetOnRoute = useRef(false), sheetGesture = useRef({ startY: null, suppressUntil: 0 })
  const [prefs, setPrefs] = useState(() => { try { return JSON.parse(localStorage.getItem(`driver.preferences.${truckId}`)) || { offers: true, parking: true } } catch { return { offers: true, parking: true } } })
  useEffect(() => {
    setError('')
    scroller.current?.scrollTo(0, 0)
    heading.current?.focus({ preventScroll: true })
    if (preserveSheetOnRoute.current) preserveSheetOnRoute.current = false
    else setSheet('medium')
  }, [route])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t) }, [toast])
  const actions = driverActions(store.events, truckId)
  const offer = latestOffer(store.events, truckId)
  const board = useMemo(() => truck ? pressureBoard(world, new Date(world.clock)).map(p => ({ ...p, ahead: (p.site.chainage - truck.chainage) * truck.direction })) : [], [world, truck])
  const rec = useMemo(() => truck ? recommendParking(truck, world, new Date(world.clock)) : null, [world, truck])
  const scales = useMemo(() => truck ? scalesAhead(truck, world, new Date(world.clock)) : [], [world, truck])
  const roadAhead = useMemo(() => truck ? incidentsAhead(truck, incidents) : [], [truck?.chainage, truck?.direction, incidents])
  const inspect = useMemo(() => truckId ? inspectionState(store.events, truckId, world.clock) : null, [store.getVersion(), truckId, world.clock])
  const breakdown = useMemo(() => truckId ? openBreakdown(store.events, truckId) : null, [store.getVersion(), truckId])
  // mapPins is a hook, so it must run on every render in the same order —
  // BEFORE the `!truck` early return. Previously it sat ~200 lines lower, after
  // the return; the first render skipped it (no truck yet), and the render that
  // received telemetry ran it for the first time — one extra hook → React threw
  // "Rendered more hooks than during the previous render" and blanked the page.
  const showParkingPins = ['parking', 'stop', 'claim'].includes(screen)
  const showScalePins = ['scales', 'scale'].includes(screen)
  const mapPins = useMemo(() => {
    if (!truck) return []
    if (showParkingPins) return PARKING_SITES.map(s => ({ id: s.id, name: s.name, coord: s.coord, kind: 'parking', onSelect: id => go(`stop/${id}`) }))
    if (showScalePins) return SCALE_SITES
      .filter(s => !s.direction || s.direction === truck.direction)
      .map(s => ({ id: s.id, name: s.name, coord: s.coord, kind: 'scale', onSelect: id => go(`scale/${id}`) }))
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, showParkingPins, showScalePins, truck?.direction])
  if (!truck) return <div className="dp-shell"><main className="dp-login"><Empty title="Connecting to your truck">Waiting for the first telemetry update.</Empty></main></div>
  const destination = SITE_BY_ID[truck.destinationId], dock = SITE_BY_ID[truck.insideSiteId]?.kind === 'stop' && truck.state !== 'driving' ? SITE_BY_ID[truck.insideSiteId] : null
  const selected = board.find(p => p.site.id === siteId) || board.find(p => p.site.id === truck.claimedSiteId) || rec?.best
  const selectedScale = scales.find(s => s.site.id === siteId) || scales[0]
  const vendor = VENDOR_BY_ID[siteId]
  const left = clockLeftMs(truck), critical = left <= 90 * 60000
  // An incident has a coordinate and a chainage, so it can be a map target like
  // any site — it just needs a name, which 511 gives as a description.
  const nearIncident = roadAhead[0] ? { id: roadAhead[0].id, kind: 'incident', name: incidentLabel(roadAhead[0].type), coord: roadAhead[0].coord, chainage: roadAhead[0].chainage } : null
  const aheadScreens = ['parking', 'stop', 'claim', 'scales', 'scale', 'service', 'vendor', 'conditions']
  const target = ['parking', 'stop', 'claim'].includes(screen) ? selected?.site
    : ['scales', 'scale'].includes(screen) ? selectedScale?.site
    : screen === 'conditions' ? nearIncident
    : ['service', 'vendor', 'breakdown'].includes(screen) ? null
    : dock || (screen === 'today' && truck.claimedSiteId ? SITE_BY_ID[truck.claimedSiteId] : screen === 'today' && critical ? rec?.best.site : destination)
  const distance = target ? Math.abs(target.chainage - truck.chainage) : 0
  const eta = Math.max(1, Math.round(distance / Math.max(truck.speedKph, 40) * 60))
  const tab = ['log', 'events', 'correction', 'inspection', 'inspections'].includes(screen) ? 'log'
    : aheadScreens.includes(screen) ? 'ahead'
    : ['me', 'truck', 'documents', 'notifications', 'help', 'requests'].includes(screen) ? 'me' : 'today'
  const title = { today: breakdown ? 'Help is on the way' : dock ? 'At the dock' : truck.state === 'resting' ? 'Time to recharge' : 'Your next stop', load: 'Load details', offer: 'A new opportunity', parking: 'Find your next stop', stop: 'Parking details', claim: 'Your stop is planned', scales: 'Inspection stations', scale: 'Station details', service: 'Roadside service', vendor: 'Service provider', conditions: 'The road ahead', breakdown: breakdown ? 'Your breakdown report' : 'Trouble with the truck', inspection: 'Daily trip inspection', inspections: 'Inspection records', log: 'Hours of service', events: 'Duty events', me: 'Your space', delay: 'Report a delay', correction: 'Request a correction', help: 'Your dispatch team', requests: 'Your requests', documents: 'Driver documents', notifications: 'Notifications', truck: 'Your truck' }[screen] || 'Today'
  function notify(s) { setToast(s) }
  async function act(action, detail = {}) {
    let r
    if (demo) r = demoController.act(action, detail)
    else if (SERVER_ENABLED) {
      const eventType = action === 'parking.claimed' ? EVENT.PARKING_CLAIM
        : action === 'parking.released' ? EVENT.PARKING_RELEASE : EVENT.DRIVER_ACTION
      r = await issueCommand({
        type: 'recordDriverEvent', eventType,
        payload: eventType === EVENT.DRIVER_ACTION ? { action, ...detail } : { ...detail, siteId: detail.siteId || truck.claimedSiteId },
        idempotencyKey: `driver-${truckId}-${action}-${Date.now()}`,
      })
    } else if (action === 'parking.claimed' || action === 'parking.released') r = sim?.driverParking(truckId, action === 'parking.claimed' ? detail.siteId : null)
    else { recordAction(store, truckId, action, detail); r = { ok: true } }
    if (!r?.ok) { setError(r?.error || 'Unable to complete this action. Try again.'); return false }
    setError(''); return true
  }
  async function submitRequest(e, action) {
    e.preventDefault(); const f = new FormData(e.currentTarget), message = String(f.get('message') || '').trim()
    if (!message) { setError('Please add a short message.'); return }
    if (await act(action, { message, reason: f.get('reason') || null, siteId: dock?.id || null, loadId: truck.loadId, drivingMs: truck.drivingMs })) { go('requests'); notify('Request recorded in the dispatch event log.') }
  }
  const startNavigation = () => {
    setNavigating(true)
    setMapMode('follow')
    setSheet('peek')
    setRecenter(n => n + 1)
    preserveSheetOnRoute.current = true
    go('today')
    notify('Follow view started. Your route is highlighted ahead.')
  }
  function setMapView(mode) {
    setMapMode(mode)
    setRecenter(n => n + 1)
  }
  /** The handle cycles the sheet through its three heights: peek → medium →
   * full → peek. A drag gestures instead snaps to whichever of the three is
   * nearest the pointer's travel. */
  function toggleSheet() {
    if (Date.now() < sheetGesture.current.suppressUntil) return
    setSheet(s => s === 'peek' ? 'medium' : s === 'medium' ? 'full' : 'peek')
    setRecenter(n => n + 1)
  }
  function startSheetGesture(e) {
    sheetGesture.current.startY = e.clientY
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function endSheetGesture(e) {
    const startY = sheetGesture.current.startY
    sheetGesture.current.startY = null
    if (startY == null) return
    const delta = e.clientY - startY
    if (Math.abs(delta) < 36) return
    sheetGesture.current.suppressUntil = Date.now() + 500
    const order = ['peek', 'medium', 'full'], idx = Math.max(0, order.indexOf(sheet))
    // Dragging up grows the sheet (towards full); dragging down shrinks it
    // (towards peek), capped at the ends of the sequence.
    const next = Math.max(0, Math.min(order.length - 1, idx + (delta < 0 ? 1 : -1)))
    setSheet(order[next])
    setRecenter(n => n + 1)
  }
  /** Inspections and breakdowns are typed events the simulator does not own, so
   * they are appended straight to whichever store this portal is bound to — the
   * live one, or the demo's. Both honour the same contract. */
  async function record(type, payload) {
    if (!demo && SERVER_ENABLED) return issueCommand({
      type: 'recordDriverEvent', eventType: type, payload,
      idempotencyKey: `driver-${truckId}-${type}-${Date.now()}`,
    })
    store.append(type, world.clock, { truckId, ...payload }); store.commit()
    return { ok: true }
  }
  async function submitInspection(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget), defects = f.getAll('defect').map(String)
    const phase = String(f.get('phase') || 'pre-trip'), major = hasMajor(defects)
    const result = await record(EVENT.INSPECTION, { phase, defects, major, odometerKm: truck.odometerKm, note: String(f.get('note') || '').trim() })
    if (!result?.ok) { setError(result?.error || 'Unable to record inspection.'); return }
    go('inspections')
    notify(major ? 'Major defect recorded. This truck is out of service.' : defects.length ? `Inspection recorded with ${defects.length} defect${defects.length > 1 ? 's' : ''}.` : 'Inspection recorded. No defects found.')
  }
  async function submitBreakdown(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget), category = String(f.get('category') || 'mechanical')
    const { primary } = respondersFor(category, truck.chainage)
    const result = await record(EVENT.BREAKDOWN, { category, blockingLane: f.get('blockingLane') === 'on', coord: truck.coord, chainage: truck.chainage,
      loadId: truck.loadId, vendorId: primary?.id || null, note: String(f.get('note') || '').trim(), drivingMs: truck.drivingMs })
    if (!result?.ok) { setError(result?.error || 'Unable to report breakdown.'); return }
    notify('Dispatch alerted with your position and load.')
  }
  async function respondToOffer(accepted) {
    let result
    if (demo) result = await act(accepted ? 'load.accepted' : 'load.rejected', { offerId: offer.offerId })
    else result = await issueCommand({
      type: accepted ? 'acceptOffer' : 'rejectOffer', loadId: offer.loadId || offer.offerId,
      reason: accepted ? undefined : 'driver declined',
      idempotencyKey: `driver-offer-${offer.loadId || offer.offerId}-${user?.driverId}`,
    })
    if (!result?.ok) { setError(result?.error || 'Unable to update the offer.'); return }
    go(accepted ? 'load' : 'today')
    notify(accepted ? 'Load accepted. Your assignment has been updated.' : 'Load declined.')
  }
  const activeAssignment = events.findLast((e) => e.type === 'assignment.committed' && e.truckId === truckId)
  const activeShipmentId = truck.shipmentId || activeAssignment?.shipmentId
  const activeStopId = dock?.id
  const dockOperation = truck.laden ? 'unloading' : 'loading'
  const visitMilestone = activeShipmentId && activeStopId
    ? events.filter((e) => e.shipmentId === activeShipmentId && e.stopId === activeStopId && e.type.startsWith('stop.')).at(-1)?.type
    : null
  async function advanceVisit(type) {
    const result = demo
      ? demoController.advanceVisit(type)
      : await issueCommand({ type, shipmentId: activeShipmentId, stopId: activeStopId, idempotencyKey: `${type}-${activeShipmentId}-${activeStopId}` })
    if (!result.ok) { setError(result.error || 'Unable to update stop.'); return }
    notify(`Stop updated: ${result.milestone.replaceAll('_', ' ')}.`)
  }
  const hrs = <><div className="dp-section-heading"><h3>Hours of service</h3><span>Used / limit</span></div><Rings truck={truck} /></>
  const parkingRows = board.filter(p => p.ahead > 0 && p.ahead / Math.max(truck.speedKph, 40) * H <= left).sort((a,b) => a.ahead-b.ahead)
  const requestList = actions.filter(e => ['delay.reported', 'correction.requested', 'dispatch.requested'].includes(e.action)).reverse()
  function parkingSummary(p) { return <><span className="dp-eyebrow">RECOMMENDED STOP</span><h2>{p.site.name}</h2><p>{Math.round(p.ahead)} km ahead · About {Math.round(p.ahead / Math.max(truck.speedKph, 40) * 60)} min</p><span className={`dp-pill ${p.projectedFree < 3 ? 'warn' : ''}`}>{p.projectedFree} projected spaces · {Math.round(p.estimatedUtil * 100)}% full</span><Button onClick={() => go(`stop/${p.site.id}`)}>View stop & claim <Icon name="arrow" /></Button></> }
  let content
  switch (screen) {
    case 'today': content = <>
      <Identity truck={truck} />
      {breakdown ? <div className="dp-breakdown-card"><span className="dp-eyebrow">REPORTED {time(breakdown.at)}</span><h2>{CATEGORY_BY_ID[breakdown.category]?.label || 'Breakdown'}</h2><p>Dispatch has your position, your load and your remaining hours. Stay with the truck unless it is unsafe.</p><Button onClick={() => go('breakdown')}>View your report <Icon name="arrow" /></Button></div> : <>
        {inspect?.blocking ? <div className="dp-blocker"><span className="dp-symbol warn"><Icon name="clipboard" /></span><div><strong>{inspect.major ? 'This truck is out of service' : 'Inspection needed before you drive'}</strong><small>{inspect.reason}</small></div><Button onClick={() => go('inspection')}>{inspect.major ? 'Record a repair inspection' : 'Start inspection'}</Button></div>
          : inspect?.prompt ? <Row title="Record today’s trip inspection" sub="No inspection has been recorded in this app yet" icon="clipboard" onClick={() => go('inspection')} /> : null}
        {offer && prefs.offers && <Row title="A new load is waiting" sub={`${offer.offerId} · Review before ${time(offer.expiresAt)}`} onClick={() => go('offer')} icon="truck" />}
        {dock ? <div className="dp-dock"><span className="dp-eyebrow">{dockOperation === 'loading' ? 'PICKUP · LOADING' : 'DELIVERY · UNLOADING'}</span><ShipmentVisit truck={{...truck, clock: world.clock}} stopId={truck.insideSiteId} operation={dockOperation} /><div className="dp-actions">
          {activeShipmentId && (!visitMilestone || visitMilestone === 'stop.arrived') && <Button onClick={() => advanceVisit('checkInStop')}>Check in</Button>}
          {visitMilestone === 'stop.checked_in' && <Button onClick={() => advanceVisit('startService')}>Start {dockOperation}</Button>}
          {visitMilestone === 'stop.service_started' && <Button onClick={() => advanceVisit('completeService')}>Confirm {dockOperation} complete</Button>}
          {visitMilestone === 'stop.service_completed' && <Button onClick={() => advanceVisit('departStop')}>Confirm gate-out</Button>}
          <Button secondary onClick={() => go('delay')}>Report delay</Button><Button secondary onClick={() => go('help')}>Dispatch</Button>
        </div></div>
      : truck.state === 'resting' ? <Empty title="Take a well-earned break">{SITE_BY_ID[truck.insideSiteId]?.name || 'Truck is resting'}. Your hours update from telemetry.<Button secondary onClick={() => go('log')}>View your duty log</Button></Empty>
      : critical ? <div className="dp-parking-summary"><div className="dp-warning"><strong>{fmtClock(left)} left to drive</strong><span>Limited by driving or duty hours</span></div>{rec ? parkingSummary(board.find(p => p.site.id === truck.claimedSiteId) || rec.best) : <Empty title="No stop within reach" action={<Button onClick={() => go('help')}>Contact dispatch</Button>}>No parking site is reachable on your remaining hours.</Empty>}</div>
      : <>{hrs}<Row title={truck.loadId ? destination?.name || 'Assigned destination' : 'No active load'} sub={truck.loadId ? `CURRENT LOAD · ${truck.loadId}` : 'Your next assignment will appear here.'} onClick={() => go('load')} /></>}
        {roadAhead.length > 0 && <button className="dp-strip" onClick={() => go('conditions')}><Icon name="alert" /><span><strong>{incidentLabel(roadAhead[0].type)} {Math.round(roadAhead[0].ahead)} km ahead</strong><small>{roadAhead.length > 1 ? `${roadAhead.length} reports on your route` : 'On your route'} · Ontario 511</small></span><Icon name="arrow" /></button>}
        {inspect && !inspect.blocking && inspect.expiringSoon && <button className="dp-text-button" onClick={() => go('inspection')}>Inspection expires {time(inspect.expiresAt)} →</button>}
      </>}
    </>; break
    case 'offer': content = offer && world.clock < offer.expiresAt ? <><span className="dp-pill">NEW OFFER · FTL</span><div className="dp-heading"><h2>{SITE_BY_ID[offer.originId]?.name}<span className="dp-route-arrow">↓</span>{SITE_BY_ID[offer.destinationId]?.name}</h2><p>{offer.offerId}</p></div><div className="dp-stats"><span><b>{Math.round(offer.distanceKm || 0)} km</b>Trip distance</span><span><b>{offer.dueAt ? time(offer.dueAt) : 'TBC'}</b>Delivery due</span><span><b>{Number(offer.weightKg || 0)/1000} t</b>Load weight</span></div><p className="dp-info">Server precheck passed HOS, vehicle, equipment, route, and axle/gross weight before this offer was created.</p><p className="dp-center">Offer expires in {fmtClock(offer.expiresAt-world.clock)}</p><div className="dp-actions"><Button onClick={() => respondToOffer(true)}>Accept load</Button><Button secondary onClick={() => respondToOffer(false)}>Reject</Button></div></> : <Empty title="No pending offers" action={<Button onClick={() => go('today')}>Back to Today</Button>}>Accepted, declined, and expired offers leave this queue.</Empty>; break
    case 'load': content = truck.loadId ? <><div className="dp-heading"><span className="dp-eyebrow">{truck.laden ? 'ON BOARD' : 'ASSIGNED LOAD'}</span><h2>{truck.loadId}</h2><p>Next stop · {destination?.name}</p></div><div className="dp-stats"><span><b>{Math.round(distance)} km</b>Remaining</span><span><b>~{eta} min</b>Estimated travel</span></div><div className="dp-info"><h3>Arrival instructions</h3><p>Check in with the receiving team using load {truck.loadId}. Confirm gate and dock details with dispatch.</p></div><Button onClick={startNavigation}>View route to delivery <Icon name="locate" /></Button><Button secondary onClick={() => go('help')}>Contact dispatch</Button></> : <Empty title="No active load" action={<Button onClick={() => go(offer ? 'offer' : 'today')}>{offer ? 'Review new offer' : 'Back to Today'}</Button>}>Your next assignment will appear here.</Empty>; break
    case 'parking': content = <><Segmented value="parking" onChange={go} /><div className="dp-section-heading"><h2>Rest stops ahead</h2><span>{parkingRows.length} reachable</span></div>{critical && <div className="dp-warning">{fmtClock(left)} left before your first limit</div>}{truck.claimedSiteId && <Row title="Your planned stop" sub={SITE_BY_ID[truck.claimedSiteId]?.name} onClick={() => go(`claim/${truck.claimedSiteId}`)} />}{parkingRows.length ? parkingRows.map(p => <Row key={p.site.id} title={p.site.name} sub={`${Math.round(p.ahead)} km · ${p.projectedFree} projected spaces${p.projectedFree === 0 ? ' · May be full' : ''}${facilitiesOf(p.site).filter(f => f.key).length ? ' · ' + facilitiesOf(p.site).filter(f => f.key).map(f => f.label).join(', ') : ''}`} onClick={() => go(`stop/${p.site.id}`)} />) : <Empty title="No reachable stop ahead" action={<Button onClick={() => go('help')}>Contact dispatch</Button>}>The nearest sites are beyond your remaining hours.</Empty>}<p className="dp-footnote">Spaces are fleet estimates, not guaranteed availability.</p></>; break
    case 'stop': content = selected ? <><div className="dp-heading"><span className="dp-eyebrow">{selected.site.owned ? 'CARRIER YARD' : 'TRUCK PARKING'}</span><h2>{selected.site.name}</h2><p>{Math.round(selected.ahead)} km ahead · ~{Math.round(selected.ahead / Math.max(truck.speedKph, 40)*60)} min</p></div><div className="dp-space-count"><b>{selected.projectedFree}</b><span>projected spaces<small>{selected.site.spaces} total · Fleet estimate</small></span></div><Facilities site={selected.site} /><p className="dp-info">A claim shares your plan with the fleet. It does not reserve a parking bay; availability is checked again on arrival.</p><Button onClick={async () => { if(await act('parking.claimed',{siteId:selected.site.id})) go(`claim/${selected.site.id}`) }}>{truck.claimedSiteId === selected.site.id ? 'View your claim' : 'Claim this stop'}</Button><button className="dp-text-button" onClick={() => go('parking')}>Choose a different stop</button></> : <Empty title="Stop not available" action={<Button onClick={() => go('parking')}>View other stops</Button>}>Parking information could not be found.</Empty>; break
    case 'claim': content = truck.claimedSiteId ? <Empty title="Your stop is planned" action={<><Button onClick={() => { setNavigating(true); setRecenter(n=>n+1); notify('Your planned stop is highlighted on the map.') }}>Show route <Icon name="locate" /></Button><Button secondary onClick={async () => { if(await act('parking.released')) {go('parking');notify('Parking claim released.')} }}>Release claim</Button></>}><strong>{SITE_BY_ID[truck.claimedSiteId]?.name}</strong><br />Your plan is in the fleet event log. A parking space is not guaranteed.</Empty> : <Empty title="No active parking claim" action={<Button onClick={() => go('parking')}>Find a stop</Button>}>Your claim may have been released or completed on arrival.</Empty>; break
    case 'scales': content = <><Segmented value="scales" onChange={go} /><div className="dp-section-heading"><h2>Stations ahead</h2><span>{scales.length} on your side</span></div>{scales.length ? scales.map(st => <button className="dp-row" key={st.site.id} onClick={() => go(`scale/${st.site.id}`)}><span><strong>{st.site.name}</strong><small>{Math.round(st.ahead)} km ahead · Posted {st.site.postedHours}</small><ScaleBadge status={st} /></span><Icon name="arrow" /></button>) : <Empty title="Nothing ahead of you">No inspection station remains on this carriageway between here and the end of the corridor.</Empty>}<p className="dp-footnote">Estimated from how our own trucks behave going past. Posted hours are a schedule, not a promise — an estimate is never a reason to pass a station that is open.</p></>; break
    case 'scale': content = selectedScale ? <><div className="dp-heading"><span className="dp-eyebrow">INSPECTION STATION</span><h2>{selectedScale.site.name}</h2><p>{Math.round(selectedScale.ahead)} km ahead · ~{Math.round(selectedScale.ahead / Math.max(truck.speedKph, 40) * 60)} min</p></div><div className="dp-estimate"><ScaleBadge status={selectedScale} /><b>{Math.round(selectedScale.probability * 100)}%</b><span>estimated chance it is open<small>Posted hours {selectedScale.site.postedHours}</small></span></div><dl className="dp-details"><div><dt>Trucks observed</dt><dd>{selectedScale.samples || 'None nearby'}</dd></div>{selectedScale.samples > 0 && <div><dt>Slowing to enter</dt><dd>{selectedScale.slowed} of {selectedScale.samples}</dd></div>}<div><dt>Confidence in sample</dt><dd>{Math.round(selectedScale.confidence * 100)}%</dd></div><div><dt>Time-of-day baseline</dt><dd>{Math.round(selectedScale.historical * 100)}%</dd></div></dl><p className="dp-info">{selectedScale.confidence >= 1 ? 'Enough of our trucks have passed recently for the live signal to carry this estimate.' : selectedScale.samples > 0 ? 'Too few trucks have passed for the live signal to stand on its own, so the time-of-day baseline is doing most of the work.' : 'No truck of ours is close enough to observe this station right now. This is the time-of-day baseline alone.'}</p><Button secondary onClick={() => go('scales')}>Other stations ahead</Button></> : <Empty title="Station not available" action={<Button onClick={() => go('scales')}>View stations ahead</Button>}>This inspection station is not ahead of you on this carriageway.</Empty>; break
    case 'service': { const nearby = vendorsNear(truck.chainage); content = <><Segmented value="service" onChange={go} /><div className="dp-urgent"><span className="dp-symbol warn"><Icon name="alert" /></span><div><strong>Truck won’t move?</strong><small>One tap sends dispatch your position, load and hours.</small></div><Button onClick={() => go('breakdown')}>Report a breakdown</Button></div><div className="dp-section-heading"><h3>Service at km {Math.round(truck.chainage)}</h3><span>{nearby.length} on account</span></div>{nearby.length ? nearby.map(v => <Row key={v.id} title={v.name} sub={`${v.services.map(x => x === 'tow' ? 'Towing' : x === 'reefer' ? 'Reefer' : x === 'tire' ? 'Tire' : 'Mechanical').join(' · ')} · ${v.hours} · ~${v.etaMin} min`} onClick={() => go(`vendor/${v.id}`)} icon="wrench" />) : <Empty title="No vendor covers this stretch" action={<Button onClick={() => go('help')}>Contact dispatch</Button>}>Dispatch arranges service here case by case.</Empty>}<p className="dp-footnote">Vendors the carrier holds an account with. Anything outside this list needs dispatch approval before work starts.</p></> ; break }
    case 'vendor': content = vendor ? <><div className="dp-heading"><span className="dp-symbol"><Icon name="wrench" /></span><h2>{vendor.name}</h2><p>{vendor.services.map(x => x === 'tow' ? 'Towing' : x === 'reefer' ? 'Reefer' : x === 'tire' ? 'Tire service' : 'Mechanical').join(' · ')}</p></div><div className="dp-stats"><span><b>~{vendor.etaMin} min</b>Typical response</span><span><b>{vendor.hours}</b>Hours</span></div><a className="dp-button" href={`tel:${vendor.phone.replaceAll('-', '')}`}><Icon name="phone" /> Call {vendor.phone}</a><p className="dp-info">Tell them the truck number ({truck.id}), the plate ({truck.plate}) and your position: Highway 401 {truck.direction === 1 ? 'eastbound' : 'westbound'}, km {Math.round(truck.chainage)}.</p><Button secondary onClick={() => go('breakdown')}>Log this as a breakdown</Button><button className="dp-text-button" onClick={() => go('service')}>Other providers</button></> : <Empty title="Provider not found" action={<Button onClick={() => go('service')}>Back to service</Button>}>This vendor is not in the carrier’s book.</Empty>; break
    case 'conditions': content = <><Segmented value="conditions" onChange={go} /><div className="dp-section-heading"><h2>Between you and your stop</h2><span>{roadAhead.length} report{roadAhead.length === 1 ? '' : 's'}</span></div>{roadAhead.length ? roadAhead.map(inc => <article className="dp-incident" key={inc.id}><div><span className={`dp-badge ${inc.fullClosure ? 'stop' : 'quiet'}`}>{incidentLabel(inc.type)}</span><strong>{Math.round(inc.ahead)} km ahead</strong></div><p>{inc.description}</p><small>{inc.direction} · {inc.fullClosure ? 'Full closure' : 'Lanes open'}{inc.updated ? ` · Updated ${time(inc.updated)}` : ''}</small></article>) : <Empty title="Nothing reported ahead">Ontario 511 has no incident on your stretch of the 401 right now.</Empty>}<p className="dp-footnote">Ontario 511, filtered to Highway 401. The same feed already sets travel times on your route.</p></>; break
    case 'breakdown': content = breakdown ? <><div className="dp-heading"><span className="dp-symbol warn"><Icon name="alert" /></span><h2>{CATEGORY_BY_ID[breakdown.category]?.label || 'Breakdown'}</h2><p>Reported {time(breakdown.at)} · km {Math.round(breakdown.chainage)}</p></div>{breakdown.blockingLane && <div className="dp-warning"><strong>You reported a blocked lane</strong><span>If you have not already, call 911. Dispatch cannot clear traffic for you.</span></div>}{(() => { const v = VENDOR_BY_ID[breakdown.vendorId], b = respondersFor(breakdown.category, breakdown.chainage); return <>{v ? <><div className="dp-section-heading"><h3>Dispatch is calling</h3><span>~{v.etaMin} min</span></div><Row title={v.name} sub={`${v.hours} · ${v.phone}`} icon="wrench" onClick={() => go(`vendor/${v.id}`)} /></> : <p className="dp-info">No vendor on account covers this stretch. Dispatch is arranging service directly.</p>}{b.backups.length > 0 && <><div className="dp-divider" /><h3>If they cannot come out</h3>{b.backups.map(x => <Row key={x.id} title={x.name} sub={`${x.hours} · ~${x.etaMin} min`} onClick={() => go(`vendor/${x.id}`)} />)}</>}</> })()}<p className="dp-info">Your position, load {breakdown.loadId || '—'} and remaining hours went to dispatch when you reported this. You do not need to repeat them.</p><Button onClick={() => go('help')}>Message dispatch</Button><Button secondary onClick={async () => { const r = await record(EVENT.BREAKDOWN_CLEARED, { category: breakdown.category }); if (r?.ok) { go('today'); notify('Breakdown cleared. Dispatch has been told you are rolling.') } }}>Back in service</Button></> : <><div className="dp-heading"><span className="dp-symbol warn"><Icon name="alert" /></span><h2>What has stopped you?</h2><p>Pick the closest match. Details can wait.</p></div><form className="dp-form" onSubmit={submitBreakdown}><fieldset><legend>Fault</legend>{BREAKDOWN_CATEGORIES.map((c, i) => <label className="dp-radio" key={c.id}><input type="radio" name="category" value={c.id} defaultChecked={i === 0} />{c.label}</label>)}</fieldset><label className="dp-radio"><input type="checkbox" name="blockingLane" />I am blocking a live lane</label><label>Anything dispatch should know (optional)<textarea name="note" rows={2} maxLength={500} placeholder="Optional — you can send this and add detail later." /></label><Button type="submit">Report breakdown</Button></form><p className="dp-footnote">Sends your position, load and remaining hours. If you are blocking a lane or anyone is hurt, call 911 first.</p></>; break
    case 'inspection': content = <><div className="dp-heading"><span className="dp-symbol"><Icon name="clipboard" /></span><h2>{inspect?.pre ? 'Record an inspection' : 'Before you drive'}</h2><p>Daily trip inspection · Schedule 1, O. Reg. 199/07</p></div><form className="dp-form" onSubmit={submitInspection}><fieldset><legend>Which inspection is this?</legend>{[['pre-trip', 'Pre-trip — before the first drive'], ['post-trip', 'Post-trip — end of the day']].map(([v, l], i) => <label className="dp-radio" key={v}><input type="radio" name="phase" value={v} defaultChecked={i === 0} />{l}</label>)}</fieldset><fieldset><legend>Mark anything you found. Leave them all clear if the truck is sound.</legend><div className="dp-checks">{INSPECTION_ITEMS.map(i => <label className="dp-check" key={i.id}><input type="checkbox" name="defect" value={i.id} /><span>{i.label}</span>{i.major && <small>Out of service</small>}</label>)}</div></fieldset><label>Notes (optional)<textarea name="note" rows={3} maxLength={500} placeholder="Where on the vehicle, and what you saw…" /></label><Button type="submit">Record inspection</Button></form><p className="dp-footnote">Recorded against {truck.id} at {Math.round(truck.odometerKm).toLocaleString()} km. Inspections are never edited — record a new one to correct a mistake, and both stay in the log.</p></>; break
    case 'inspections': { const list = inspections(store.events, truckId).slice(-20).reverse(); content = <><div className="dp-heading"><h2>Inspection records</h2><p>Valid for {INSPECTION_VALID_H} hours from the pre-trip</p></div>{inspect?.major ? <div className="dp-estimate"><span className="dp-badge stop">Out of service</span><span>{defectLabels(inspect.major.defects).join(', ')}<small>Recorded {time(inspect.major.at)} · A repair inspection with the defect cleared puts this truck back in service.</small></span></div>
      : inspect?.pre ? <div className="dp-estimate"><span className="dp-badge ok">In force</span><b>{fmtClock(Math.max(0, inspect.dueIn))}</b><span>until this inspection expires<small>Recorded {time(inspect.pre.at)}</small></span></div> : null}{list.length ? list.map(e => <article className="dp-request" key={e.seq}><div><strong>{e.phase === 'pre-trip' ? 'Pre-trip' : 'Post-trip'}</strong><span className={`dp-badge ${e.major ? 'stop' : e.defects.length ? 'quiet' : 'ok'}`}>{e.major ? 'Major defect' : e.defects.length ? `${e.defects.length} defect${e.defects.length > 1 ? 's' : ''}` : 'No defects'}</span></div>{e.defects.length > 0 && <p>{defectLabels(e.defects).join(', ')}</p>}{e.note && <p>{e.note}</p>}<small>{time(e.at)} · {Math.round(e.odometerKm).toLocaleString()} km</small></article>) : <Empty title="No inspections recorded" action={<Button onClick={() => go('inspection')}>Start one now</Button>}>Your daily trip inspections will be listed here.</Empty>}<Button secondary onClick={() => go('inspection')}>Record a new inspection</Button></>; break }
    case 'log': { const segments = dutySegments(store.events,truckId); const history = loadHistory(store.events, truckId); content = <>{hrs}{truck.elapsedMs == null && <p className="dp-footnote">Elapsed and cycle totals are unavailable from the current feed.</p>}<div className="dp-divider" /><h3>Today’s duty record</h3><DutyChart segments={segments} now={world.clock} /><div className="dp-timeline">{segments.length ? segments.slice(-6).map((s,i) => <div key={s.at}><time>{time(s.at)}</time><span className={`dp-timeline-dot ${s.state === 'Driving' ? 'green' : ''}`} /><span><strong>{s.state}</strong><small>{i === segments.slice(-6).length-1 ? 'Current status' : 'Recorded telemetry'}</small></span></div>) : <p>No duty events recorded yet.</p>}</div><p className="dp-footnote">Recorded since this session began; no earlier history is inferred.</p><div className="dp-divider" /><h3>Previous tasks</h3>{history.length ? history.map(l => <article className="dp-request" key={l.loadId}><div><strong>{l.loadId}</strong><span className={`dp-badge ${l.completedAt ? 'ok' : 'quiet'}`}>{l.completedAt ? 'Delivered' : 'In progress'}</span></div><p>{l.destinationName || l.destinationId || 'Destination to be confirmed'}</p><small>{time(l.assignedAt)} → {l.completedAt ? time(l.completedAt) : 'pending'}</small></article>) : <p className="dp-info">No loads have been assigned to you yet this session.</p>}<div className="dp-divider" /><Row title="Daily trip inspection" sub={inspect?.major ? 'Major defect recorded — out of service' : inspect?.pre ? `In force · expires ${time(inspect.expiresAt)}` : inspect?.blocking ? 'Expired — a new one is needed before you drive' : 'None recorded in this app yet'} icon="clipboard" onClick={() => go('inspections')} /><Button secondary onClick={() => go('events')}>View all duty events</Button><button className="dp-text-button" onClick={() => go('correction')}>Request a correction</button></>; break }
    case 'events': { const records = store.events.filter(e=>e.truckId===truckId && e.type!==EVENT.PING && e.type!== 'driver.action').slice(-30).reverse(); content = <><div className="dp-heading"><h2>Today’s activity</h2><p>{date(world.clock)}</p></div>{records.length ? records.map(e=><div className="dp-event" key={e.seq}><time>{time(e.at)}</time><span><strong>{e.type.replaceAll('.',' ')}</strong><small>{e.siteName || e.loadId || ''}</small></span></div>) : <p className="dp-info">No arrival or departure events have been recorded this session.</p>}<div className="dp-divider" />{dutySegments(store.events,truckId).slice(-12).reverse().map(e=><div className="dp-event" key={e.at}><time>{time(e.at)}</time><strong>{e.state}</strong></div>)}<Button secondary onClick={()=>go('correction')}>Request a log correction</Button></>; break }
    case 'delay': case 'correction': case 'help': { const delay=screen==='delay', correction=screen==='correction'; content=<><div className="dp-heading"><span className="dp-symbol"><Icon name={delay?'truck':'help'} /></span><h2>{delay?'What’s holding you up?':correction?'Let’s get the record right.':'How can dispatch help?'}</h2><p>{delay?'Your arrival time and HOS accompany this report.':correction?'Requests preserve the original telemetry record.':'Record a request for your dispatcher.'}</p></div><form className="dp-form" onSubmit={e=>submitRequest(e,delay?'delay.reported':correction?'correction.requested':'dispatch.requested')}>{delay && <fieldset><legend>Reason</legend>{['Waiting for a dock','Loading / unloading','Paperwork'].map((r,i)=><label className="dp-radio" key={r}><input type="radio" name="reason" value={r} defaultChecked={i===0}/>{r}</label>)}</fieldset>}<label>{correction?'What needs correcting?':'Message'}<textarea name="message" required maxLength={1000} rows={4} placeholder={delay?'Tell dispatch about the delay…':correction?'Include the event time and the correction you need…':'What do you need help with?'} /></label><Button type="submit">{correction?'Submit correction request':'Send to dispatch log'}</Button></form><p className="dp-footnote">{demo?'Demo requests stay in this demo session.':'Recorded in this session’s shared dispatcher event feed.'}</p><button className="dp-text-button" onClick={()=>go('requests')}>View your requests</button></>; break }
    case 'requests': content=<><div className="dp-heading"><h2>Your requests</h2><p>Recorded in this session</p></div>{requestList.length ? requestList.map(e=>{const reply=actions.find(r=>r.action==='dispatch.replied'&&r.replyTo===e.seq);return <article className="dp-request" key={e.seq}><div><strong>{e.action==='delay.reported'?'Delay report':e.action==='correction.requested'?'Log correction':'Dispatch request'}</strong><span className="dp-pill">{reply?'Answered':'Recorded'}</span></div><p>{e.message}</p><small>{time(e.at)}{e.reason?` · ${e.reason}`:''}</small>{reply&&<div className="dp-info" style={{marginTop:12}}><strong>Dispatch replied</strong><p>{reply.message}</p><small>{time(reply.at)}</small></div>}</article>}) : <Empty title="You’re all caught up">No requests have been recorded yet.</Empty>}<Button secondary onClick={()=>go('help')}>New request</Button></>;break
    case 'me': content=<><div className="dp-heading"><span className="dp-avatar large">{initials(truck.driverName)}</span><h2>{truck.driverName}</h2><p>Gladiolus · Driver {truck.driverId}</p></div><Row title="My truck" sub={`${truck.id} · ${truck.plate}`} icon="truck" onClick={()=>go('truck')} /><Row title="Documents" sub="Licence, vehicle and carrier records" onClick={()=>go('documents')} /><Row title="Notifications" sub="Load offers and parking preferences" icon="bell" onClick={()=>go('notifications')} /><Row title="Roadside service" sub="Vendors on account and breakdown reporting" icon="wrench" onClick={()=>go('service')} /><Row title="Inspections" sub="Daily trip inspection records" icon="clipboard" onClick={()=>go('inspections')} /><Row title="Help & dispatch" sub="Requests and driver support" icon="help" onClick={()=>go('help')} /><button className="dp-text-button" onClick={()=>{ if(demo) location.hash='/driver';else {signOut();location.hash='/driver'} }}>Sign out</button></>;break
    case 'truck':content=<><div className="dp-heading"><span className="dp-symbol"><Icon name="truck" /></span><h2>{truck.id}</h2><p>{truck.plate}</p></div><dl className="dp-details"><div><dt>Driver</dt><dd>{truck.driverName}</dd></div><div><dt>Odometer</dt><dd>{Math.round(truck.odometerKm).toLocaleString()} km</dd></div><div><dt>Speed</dt><dd>{Math.round(truck.speedKph)} km/h</dd></div><div><dt>Load</dt><dd>{truck.loadId || 'Unassigned'}</dd></div><div><dt>Telemetry</dt><dd>{time(world.clock)}</dd></div></dl><Button secondary onClick={()=>go('breakdown')}>Report a vehicle issue</Button></>;break
    case 'documents':content=<Empty title="Your documents belong here" action={<Button secondary onClick={()=>go('help')}>Request a document from dispatch</Button>}>No licence or vehicle documents are connected to this prototype.</Empty>;break
    case 'notifications':content=<><div className="dp-heading"><h2>Keep the useful things on.</h2><p>Preferences are saved on this device.</p></div>{[['offers','Load offers','Show the new-offer badge.'],['parking','Parking updates','Show proactive parking alerts.']].map(([key,label,sub])=><label className="dp-toggle" key={key}><span><strong>{label}</strong><small>{sub}</small></span><input type="checkbox" role="switch" checked={!!prefs[key]} onChange={e=>{const next={...prefs,[key]:e.target.checked};setPrefs(next);try{localStorage.setItem(`driver.preferences.${truckId}`,JSON.stringify(next))}catch{};notify('Preference saved on this device.')}}/></label>)}<p className="dp-info">HOS warnings stay visible because they affect your next action.</p></>;break
    default:content=<Empty title="Page not found" action={<Button onClick={()=>go('today')}>Back to Today</Button>}>Choose one of the tabs below to continue.</Empty>
  }
  const backTo = screen === 'today' ? 'me'
    : ['parking', 'scales', 'service', 'conditions', 'log', 'me'].includes(screen) ? 'today'
    : screen === 'scale' ? 'scales' : ['vendor', 'breakdown'].includes(screen) ? 'service'
    : ['inspection', 'inspections'].includes(screen) ? 'log'
    : tab === 'ahead' ? 'parking' : tab === 'log' ? 'log' : tab === 'me' ? 'me' : 'today'
  const mapTarget = target || destination
  const mapDistance = mapTarget ? Math.abs(mapTarget.chainage - truck.chainage) : 0
  const mapEta = Math.max(1, Math.round(mapDistance / Math.max(truck.speedKph, 40) * 60))
  // mapPins is now computed above, with the other hooks (before the `!truck`
  // early return) so React's hook order stays stable across renders.
  const peeking = sheet === 'peek'
  const routeHeading = peeking && mapTarget
    ? 'Continue on Highway 401'
    : screen === 'today' ? mapTarget?.name || title : title
  const routeMeta = peeking && dock ? `Arrival recorded at ${time(truck.enteredAt)}`
    : peeking && mapTarget ? `${mapTarget.name} · ${mapEta} min · ${Math.round(mapDistance)} km`
    : screen === 'today' && mapTarget ? `${Math.round(distance)} km · About ${eta} min${navigating?' · Route highlighted':''}`
    : date(world.clock)
  return <div className={`dp-shell ${demo?'dp-is-demo':''}`}>
    {demo && <div className="dp-demo-bar"><span><i /> INTERACTIVE DEMO</span><label className="dp-sr-only" htmlFor="dp-scene">Demo scenario</label><select id="dp-scene" value={demoController.getScene()} onChange={e=>{demoController.setScene(e.target.value);setNavigating(false);setSheet('medium');go(e.target.value==='offer'?'offer':'today');setToast('');}}>{Object.entries(SCENES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><a href="#/driver">Exit demo</a></div>}
    <main className={`dp-app has-map sheet-${sheet} map-${mapMode}`}>
      <DriverMap truck={truck} target={mapTarget} recenter={recenter} viewMode={mapMode} collapsed={sheet === 'peek'} pins={mapPins} />
      <header className="dp-header"><a href={demo?'#/driver-demo/today':'#/driver/today'} className="dp-wordmark">Gladiolus<span>DRIVER</span></a>{!demo && <a href="#/board" className="dp-text-link" style={{marginLeft:'auto',marginRight:12}}>Dispatch board →</a>}<span className="dp-clock"><i /> {time(world.clock)}</span></header>
      <div className="dp-main" ref={scroller}>
        <div className="dp-route-header"><button aria-label="Go back" className="dp-back" onClick={()=>go(backTo)}><Icon name={screen==='today'?'me':'back'} /></button><div><h1 ref={heading} tabIndex={-1}>{routeHeading}</h1><p>{routeMeta}</p></div>{offer && prefs.offers && <button className="dp-icon-button" aria-label="Review new load offer" onClick={()=>go('offer')}><Icon name="bell" /><i /></button>}</div>
        <div className="dp-map-space"><div className="dp-map-controls" role="group" aria-label="Map view"><button aria-pressed={mapMode==='overview'} onClick={()=>setMapView('overview')}><Icon name="overview" /><span>Overview</span></button><button aria-pressed={mapMode==='follow'} onClick={()=>setMapView('follow')}><Icon name="navigate" /><span>Follow</span></button></div></div>
        <div className="dp-island">
          <section className={`dp-card dp-content ${screen}`} aria-label={title}><button className="dp-sheet-toggle" aria-expanded={sheet !== 'peek'} aria-label={sheet === 'peek' ? 'Expand driver details' : 'Collapse driver details'} onPointerDown={startSheetGesture} onPointerUp={endSheetGesture} onPointerCancel={()=>{sheetGesture.current.startY=null}} onClick={toggleSheet}><span className="dp-handle" /></button>{sheet === 'peek' ? <Identity truck={truck} /> : <>{content}{screen === 'today' && !critical && prefs.parking && truck.claimedSiteId && <button className="dp-text-button" onClick={()=>go(`claim/${truck.claimedSiteId}`)}>Your planned parking stop →</button>}{error && <p role="alert" className="dp-error">{error}</p>}</>}</section>
          <nav className="dp-nav" aria-label="Driver navigation">{[['today','Today','today'],['log','Log','log'],['ahead','Ahead','parking'],['me','Me','me']].map(([key,label,route])=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>go(route)}><span><Icon name={key} /></span>{label}</button>)}</nav>
        </div>
      </div>
    </main>
    {toast && <div role="status" className="dp-toast"><Icon name="check" />{toast}<button aria-label="Dismiss notification" onClick={()=>setToast('')}><Icon name="close" /></button></div>}
  </div>
}
