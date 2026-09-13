import { createStore } from '../engine/events.js'
import { EVENT } from '../contract.js'
import { SITE_BY_ID, CORRIDOR } from '../data/corridor.js'
import { HIGHWAY_401_ROUTE } from '../data/highway401-route.js'
import { positionAt, headingAt, haversine, chainageOf, measurePath } from '../engine/geo.js'
import { H, clockLeftMs } from '../engine/hos.js'

const ROAD_CORRIDOR = measurePath(HIGHWAY_401_ROUTE)

export const DRIVER_EVENT = 'driver.action'
export const DEMO_ID = 'GLD-118'
export const SCENES = { rolling: 'On the road', offer: 'New load offer', dock: 'At the dock', critical: 'Time to rest', resting: 'Resting', inspection: 'Start of shift', breakdown: 'Truck won’t move' }
export function driverActions(events, truckId) { return events.filter(e => e.type === DRIVER_EVENT && e.truckId === truckId) }
export function recordAction(store, truckId, action, detail = {}) {
  store.append(DRIVER_EVENT, store.getWorld().clock, { truckId, action, ...detail })
  store.commit()
}
export function latestOffer(events, truckId) {
  const actions = driverActions(events, truckId)
  const offer = actions.findLast(e => e.action === 'load.offered')
  if (offer && !actions.some(e => e.offerId === offer.offerId && ['load.accepted', 'load.rejected'].includes(e.action))) return offer

  // Authoritative server offers use the v2 lifecycle rather than a browser-
  // local driver.action. Join the offer with its posted load specification.
  const created = events.findLast((e) => e.type === 'offer.created' && e.truckId === truckId)
  if (!created) return null
  const closed = events.some((e) => e.loadId === created.loadId && ['offer.accepted', 'offer.rejected'].includes(e.type) && e.seq >= created.seq)
  if (closed) return null
  const posted = events.findLast((e) => e.type === 'shipment.posted' && (e.loadId === created.loadId || e.shipmentId === created.shipmentId))
  return {
    ...created,
    offerId: created.loadId,
    originId: created.originId || posted?.originId || posted?.stops?.[0],
    destinationId: created.destinationId || posted?.destinationId || posted?.stops?.at(-1),
    distanceKm: posted?.distanceKm || 0,
    weightKg: created.payloadKg || posted?.payloadKg || 0,
    dueAt: posted?.appointment || posted?.expiresAt,
  }
}

/** Project the simulator's lightweight GPS trace onto the detailed 401 road
 * geometry before it is shown or handed to the routing service. */
export function roadPosition(coord) {
  return positionAt(ROAD_CORRIDOR, chainageOf(ROAD_CORRIDOR, coord))
}

export function routePoints(truck, target) {
  if (!target) return []
  if (haversine(truck.coord, target.coord) < 0.2) return []
  const start = chainageOf(ROAD_CORRIDOR, truck.coord)
  const end = chainageOf(ROAD_CORRIDOR, target.coord)
  if (Math.abs(end - start) < 0.1) return [truck.coord, target.coord]
  const low = Math.min(start, end), high = Math.max(start, end)
  let first = 0, last = ROAD_CORRIDOR.cum.length - 1
  while (first < ROAD_CORRIDOR.cum.length && ROAD_CORRIDOR.cum[first] <= low) first++
  while (last >= 0 && ROAD_CORRIDOR.cum[last] >= high) last--
  const road = ROAD_CORRIDOR.points.slice(first, last + 1)
  if (end < start) road.reverse()
  const points = [positionAt(ROAD_CORRIDOR, start), ...road, positionAt(ROAD_CORRIDOR, end), target.coord]
  return points.filter((point, index) => index === 0 || haversine(point, points[index - 1]) > 0.002)
}
export function hosRings(truck) {
  return [
    ['Driving', truck.drivingMs, 13 * H], ['On duty', truck.onDutyMs, 14 * H],
    ['Elapsed', truck.elapsedMs, 16 * H], ['Cycle 1', truck.cycleMs, 70 * H],
  ].map(([label, used, limit]) => ({ label, used, limit, status: used == null ? 'unknown' : limit - used <= H / 2 ? 'critical' : limit - used <= 2 * H ? 'warn' : 'ok' }))
}
export function dutySegments(events, truckId) {
  const segments = []
  for (const e of events) {
    if (e.type !== EVENT.PING || e.truckId !== truckId) continue
    const state = e.truck.state === 'driving' ? 'Driving' : e.truck.state === 'resting' ? 'Off duty' : 'On duty'
    if (segments.at(-1)?.state !== state) segments.push({ at: e.at, state })
  }
  return segments
}

/**
 * A driver's completed loads — the "previous tasks." Folds the event stream
 * for one truck into a list of loads that were assigned and delivered, with
 * the origin, destination, and completion time. Shown on the log screen so a
 * driver can see what they've done this session, not just the duty chart.
 */
export function loadHistory(events, truckId) {
  const loads = new Map() // loadId → { loadId, assignedAt, destinationId, destinationName, completedAt, departedAt }
  for (const e of events) {
    if (e.truckId !== truckId && e.truckId !== undefined) continue
    // v1: load.assigned (the active sim still emits this)
    if (e.type === EVENT.LOAD_ASSIGNED && e.loadId) {
      loads.set(e.loadId, {
        loadId: e.loadId,
        assignedAt: e.at,
        destinationId: e.destinationId,
        destinationName: e.destinationName || SITE_BY_ID[e.destinationId]?.name,
        completedAt: null, departedAt: null,
      })
    }
    // v2: shipment.completed (the new milestone-based flow)
    if (e.type === 'shipment.completed' || e.type === 'stop.service_completed') {
      for (const l of loads.values()) {
        if (l.completedAt == null && e.shipmentId && (e.shipmentId === `SHP-${l.loadId}` || e.shipmentId === l.loadId)) {
          l.completedAt = e.at
        }
      }
    }
    if (e.type === 'stop.departed') {
      for (const l of loads.values()) {
        if (l.departedAt == null && l.completedAt != null) l.departedAt = e.at
      }
    }
  }
  return [...loads.values()].sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0))
}

/** A separate, explicitly labelled scenario store keeps the interactive tour
 * from modifying the running fleet. The UI consumes the same telemetry contract. */
export function createDriverDemo() {
  const store = createStore()
  let scene = 'rolling'
  function setScene(next) {
    if (!SCENES[next]) return
    scene = next
    store.reset()
    const clock = new Date(2026, 8, 7, next === 'dock' ? 8 : next === 'critical' ? 19 : next === 'inspection' ? 5 : 13, next === 'dock' ? 28 : 5).getTime()
    const chainage = next === 'critical' ? SITE_BY_ID['onr-trafalgar'].chainage - 18 : SITE_BY_ID['cambridge-dc'].chainage - 28
    const parked = ['offer', 'dock', 'resting', 'inspection', 'breakdown'].includes(next)
    const truck = { id: DEMO_ID, driverId: 'D-118', driverName: 'Priya Raman', plate: 'ON BJ 4821', chainage,
      coord: positionAt(CORRIDOR, chainage), heading: headingAt(CORRIDOR, chainage), direction: 1,
      speedKph: parked ? 0 : 82, odometerKm: 124412, state: parked ? next === 'resting' ? 'resting' : 'dwelling' : 'driving', parked: parked && next !== 'breakdown',
      drivingMs: Math.round((next === 'critical' ? 11.75 : next === 'inspection' ? 0 : 4 + 20 / 60) * H), onDutyMs: (next === 'critical' ? 12.5 : next === 'inspection' ? 0.25 : 12.25) * H,
      elapsedMs: (next === 'critical' ? 12.8 : next === 'inspection' ? 0.25 : 12.25) * H, cycleMs: (next === 'inspection' ? 32 : 48) * H,
      loadId: next === 'offer' ? null : 'MG-4482', laden: next !== 'offer', destinationId: next === 'critical' ? 'milton-intermodal' : 'cambridge-dc',
      insideSiteId: null, claimedSiteId: null, enteredAt: null }
    if (next === 'offer') Object.assign(truck, { coord: SITE_BY_ID['london-dc'].coord, chainage: SITE_BY_ID['london-dc'].chainage })
    if (next === 'dock') {
      Object.assign(truck, { coord: SITE_BY_ID['london-dc'].coord, chainage: SITE_BY_ID['london-dc'].chainage, insideSiteId: 'london-dc', enteredAt: clock - 8 * 60000, onDutyMs: 68 * 60000, elapsedMs: 68 * 60000, drivingMs: 0 })
    }
    if (next === 'resting') Object.assign(truck, { insideSiteId: 'onr-cambridge', coord: SITE_BY_ID['onr-cambridge'].coord, chainage: SITE_BY_ID['onr-cambridge'].chainage, enteredAt: clock - H })
    // Start of shift: in the yard, clocks fresh, and deliberately with no
    // inspection on file — that is the one scene where the portal should be
    // asking for one.
    if (next === 'inspection') Object.assign(truck, { insideSiteId: 'yard-windsor', coord: SITE_BY_ID['yard-windsor'].coord, chainage: SITE_BY_ID['yard-windsor'].chainage, enteredAt: clock - 25 * 60000, loadId: null, laden: false, destinationId: 'chatham-pt' })
    store.append(EVENT.PING, clock, { truckId: DEMO_ID, truck })
    // Every other scene is mid-shift, so the morning's inspection is already on
    // file. Without it the portal would open on a prompt in scenes that are
    // about something else entirely.
    if (next !== 'inspection') store.append(EVENT.INSPECTION, clock - 6 * H, { truckId: DEMO_ID, phase: 'pre-trip', defects: [], major: false, odometerKm: truck.odometerKm - 420, note: '' })
    if (next === 'offer') store.append(DRIVER_EVENT, clock, { truckId: DEMO_ID, action: 'load.offered', offerId: 'MG-4490', originId: 'london-dc', destinationId: 'cambridge-dc', distanceKm: 110, weightKg: 18400, expiresAt: clock + 4 * 60000, dueAt: clock + 3 * H })
    // Seed a driver request with a dispatcher reply on the two scenes a judge
    // lands on first (rolling is the default; critical is the parking crunch).
    // The reply threads under the request by seq so "Your requests" nests it.
    // New demo-submitted requests get no auto-reply — its absence is the
    // "awaiting reply" state, since there is no dispatcher in the demo.
    if (next === 'rolling' || next === 'critical') {
      const req = store.append(DRIVER_EVENT, clock - 12 * 60000, {
        truckId: DEMO_ID, action: 'delay.reported',
        message: next === 'critical'
          ? 'Down to 90 min of drive time, closest lot may be full.'
          : 'Traffic building past Milton, may be 20 min late to the DC.',
        reason: 'Loading / unloading',
      })
      store.append(DRIVER_EVENT, clock - 4 * 60000, {
        truckId: DEMO_ID, action: 'dispatch.replied',
        message: next === 'critical'
          ? 'Hold at Trafalgar — a bay is opening up. Routing you now.'
          : 'Noted, receiving team is expecting you. Safe travels.',
        replyTo: req.seq, actor: 'Dispatch',
      })
    }
    store.commit()
  }
  function act(action, detail = {}) {
    const w = store.getWorld(), t = w.trucks[DEMO_ID]
    const patch = change => store.append(EVENT.PING, w.clock, { truckId: DEMO_ID, truck: { ...t, ...change } })
    if (['load.accepted', 'load.rejected'].includes(action)) {
      const offer = latestOffer(store.events, DEMO_ID)
      if (!offer || offer.offerId !== detail.offerId || w.clock >= offer.expiresAt) return { ok: false, error: 'This offer is no longer available.' }
      if (action === 'load.accepted') {
        if (clockLeftMs(t) < offer.distanceKm / 80 * H) return { ok: false, error: 'Not enough hours remain for this load. Contact dispatch.' }
        patch({ loadId: offer.offerId, destinationId: offer.destinationId, laden: false })
      }
    }
    if (action === 'parking.claimed') {
      const site = SITE_BY_ID[detail.siteId]
      const ahead = site && (site.chainage - t.chainage) * t.direction
      if (!site || site.kind !== 'parking' || ahead <= 0 || ahead / Math.max(t.speedKph, 40) * H > clockLeftMs(t)) return { ok: false, error: 'This stop is no longer reachable. Choose another or contact dispatch.' }
      if (t.claimedSiteId === site.id) return { ok: true }
      if (t.claimedSiteId) store.append(EVENT.PARKING_RELEASE, w.clock, { truckId: DEMO_ID, siteId: t.claimedSiteId })
      store.append(EVENT.PARKING_CLAIM, w.clock, { truckId: DEMO_ID, siteId: site.id, siteName: site.name, etaMin: Math.round(ahead / Math.max(t.speedKph, 40) * 60) })
      patch({ claimedSiteId: site.id })
    }
    if (action === 'parking.released') {
      if (t.claimedSiteId) store.append(EVENT.PARKING_RELEASE, w.clock, { truckId: DEMO_ID, siteId: t.claimedSiteId })
      patch({ claimedSiteId: null })
    }
    if (['delay.reported', 'correction.requested', 'dispatch.requested'].includes(action) && !String(detail.message || '').trim()) return { ok: false, error: 'Please add a short message.' }
    recordAction(store, DEMO_ID, action, detail)
    return { ok: true }
  }
  setScene('rolling')
  return { store, setScene, getScene: () => scene, act, tick() {
    const w = store.getWorld(), t = w.trucks[DEMO_ID], dt = 1000
    const driving = t.state === 'driving'
    const chainage = Math.min(CORRIDOR.length, t.chainage + (driving ? t.speedKph / 3600 : 0))
    store.append(EVENT.PING, w.clock + dt, { truckId: DEMO_ID, truck: { ...t, chainage,
      coord: driving ? positionAt(CORRIDOR, chainage) : t.coord,
      drivingMs: t.drivingMs + (driving ? dt : 0), onDutyMs: t.onDutyMs + (t.state !== 'resting' ? dt : 0),
      elapsedMs: t.elapsedMs + dt, cycleMs: t.cycleMs + (t.state !== 'resting' ? dt : 0) } })
    store.commit()
  } }
}
