import { EVENT, FEED_TYPES, DWELL_THRESHOLD_MIN, isFeedWorthy } from '../contract.js'
import { SITE_BY_ID } from '../data/corridor.js'

export { EVENT, FEED_TYPES }

/**
 * The append-only log and the fold over it. Two consequences worth saying out
 * loud: any view can be rebuilt by replaying the log, and a new metric needs a
 * new fold rather than a migration.
 */
export function emptyWorld() {
  return {
    clock: 0,
    trucks: {},
    sites: {},
    dwells: [],
    adminLog: [],
    ladenKm: 0,
    emptyKm: 0,
    transits: 0,
    forcedStops: 0,
    lastEventSeq: -1,
    // v2 domain state — the shipment/stop/detention/exception projections.
    // These are folds over the v2 event vocabulary (domain/contract.js); the
    // v1 events above are unchanged. A view reads these via useEvents() +
    // projectShipment(), not by mutating the world directly.
    shipments: {},    // shipmentId → { status, stops, assignmentId }
    stops: {},        // stopId → { milestone, shipmentId, visitEvents: [] }
    detention: [],    // calculated detention claims
    exceptions: [],   // open exception cases
  }
}

function siteState(world, siteId) {
  if (!world.sites[siteId]) {
    world.sites[siteId] = { id: siteId, occupants: [], claims: [], visits: 0 }
  }
  return world.sites[siteId]
}

/**
 * Apply one event to a mutable world draft. Deliberately total: an unrecognised
 * type advances the clock and nothing else, so a new event type can be logged
 * before any view knows how to read it.
 */
export function applyEvent(world, e) {
  world.clock = Math.max(world.clock, e.at)
  world.lastEventSeq = e.seq

  switch (e.type) {
    case EVENT.PING: {
      const prev = world.trucks[e.truckId]
      const t = { ...(prev || {}), id: e.truckId, ...e.truck }
      if (e.shipmentId != null) t.shipmentId = e.shipmentId
      if (prev && typeof prev.odometerKm === 'number') {
        const delta = Math.max(0, t.odometerKm - prev.odometerKm)
        if (t.laden) world.ladenKm += delta
        else world.emptyKm += delta
      }
      world.trucks[e.truckId] = t
      break
    }
    case EVENT.FENCE_ENTER: {
      const t = world.trucks[e.truckId]
      if (t) {
        t.insideSiteId = e.siteId
        t.enteredAt = e.at
      }
      const s = siteState(world, e.siteId)
      if (!s.occupants.includes(e.truckId)) s.occupants.push(e.truckId)
      s.claims = s.claims.filter((c) => c.truckId !== e.truckId)
      break
    }
    case EVENT.FENCE_EXIT: {
      const t = world.trucks[e.truckId]
      if (t) {
        t.insideSiteId = null
        t.enteredAt = null
      }
      const s = siteState(world, e.siteId)
      s.occupants = s.occupants.filter((id) => id !== e.truckId)
      // A truck driving through a geofence is a transit, not a visit. Counting
      // those as dwells fills the league table with zero-minute noise.
      if (e.dwellMin >= DWELL_THRESHOLD_MIN) {
        s.visits += 1
        world.dwells.push({
          truckId: e.truckId,
          siteId: e.siteId,
          minutes: e.dwellMin,
          at: e.at,
        })
      } else {
        world.transits += 1
      }
      break
    }
    case EVENT.PARKING_CLAIM: {
      const t = world.trucks[e.truckId]
      if (t) t.claimedSiteId = e.siteId
      const s = siteState(world, e.siteId)
      s.claims = s.claims.filter((c) => c.truckId !== e.truckId)
      s.claims.push({ truckId: e.truckId, etaMin: e.etaMin, at: e.at })
      break
    }
    case EVENT.PARKING_RELEASE: {
      const t = world.trucks[e.truckId]
      if (t && (!e.siteId || t.claimedSiteId === e.siteId)) t.claimedSiteId = null
      const s = siteState(world, e.siteId)
      s.claims = s.claims.filter((c) => c.truckId !== e.truckId)
      break
    }
    case EVENT.LOAD_ASSIGNED: {
      const t = world.trucks[e.truckId]
      if (t) t.loadId = e.loadId
      break
    }
    case EVENT.LOAD_DELIVERED: {
      const t = world.trucks[e.truckId]
      if (t) t.loadId = null
      break
    }
    case EVENT.FORCED_STOP: {
      world.forcedStops += 1
      break
    }
    // The audit trail is a fold like every other view, not a side table. An
    // admin action that never reached the log did not happen.
    case EVENT.ADMIN_ACTION: {
      world.adminLog.push({
        seq: e.seq,
        at: e.at,
        actor: e.actor,
        action: e.action,
        detail: e.detail ?? null,
      })
      break
    }
    default: {
      // v2 domain events. These are folded here so the world carries the
      // shipment/stop/detention/exception state the dispatch surfaces project.
      // Unknown types still advance the clock (the line above) and do nothing
      // else, so adding a new event type before any fold knows it is safe.
      const t = e.type || ''
      if (t === 'assignment.committed') {
        const s = world.shipments[e.shipmentId] || { status: 'posted', stops: [], assignmentId: null }
        s.status = 'assigned'
        s.assignmentId = e.assignmentId
        s.truckId = e.truckId
        s.driverId = e.driverId
        s.loadId = e.loadId
        world.shipments[e.shipmentId] = s
        const truck = world.trucks[e.truckId]
        if (truck) {
          truck.loadId = e.loadId || truck.loadId
          truck.shipmentId = e.shipmentId
          truck.laden = false
        }
      } else if (t.startsWith('shipment.')) {
        const s = world.shipments[e.shipmentId] || { status: 'posted', stops: [], assignmentId: null }
        if (t === 'shipment.posted') {
          s.status = 'posted'; s.stops = e.stops || []
          s.loadId = e.loadId; s.originId = e.originId; s.destinationId = e.destinationId
          s.revenue = e.revenue; s.payloadKg = e.payloadKg; s.equipment = e.equipment
        }
        else if (t === 'shipment.completed') s.status = 'completed'
        else if (t === 'shipment.cancelled') s.status = 'cancelled'
        world.shipments[e.shipmentId] = s
      } else if (t.startsWith('stop.')) {
        const st = world.stops[e.stopId] || { milestone: 'none', shipmentId: e.shipmentId, visitEvents: [] }
        st.shipmentId = e.shipmentId || st.shipmentId
        st.visitEvents.push(e)
        const rank = { none: 0, arrived: 1, checked_in: 2, service_started: 3, service_completed: 4, departed: 5 }
        const target = { 'stop.arrived': 'arrived', 'stop.checked_in': 'checked_in', 'stop.service_started': 'service_started', 'stop.service_completed': 'service_completed', 'stop.departed': 'departed' }[t]
        if (target && (rank[target] || 0) > (rank[st.milestone] || 0)) st.milestone = target
        world.stops[e.stopId] = st
      } else if (t === 'detention.calculated') {
        world.detention.push({
          claimId: e.claimId, shipmentId: e.shipmentId, stopId: e.stopId,
          ruleId: e.ruleId, billableMinutes: e.billableMinutes, amount: e.amount,
          currency: e.currency, state: 'calculated', at: e.at,
        })
      } else if (t.startsWith('detention.')) {
        const state = t.split('.')[1]
        const claim = world.detention.findLast((c) => c.claimId === e.claimId)
        if (claim) claim.state = state
      } else if (t === 'exception.opened') {
        world.exceptions.push({
          id: `EX-${e.seq}`, severity: e.severity, reason: e.reason,
          affectedTruck: e.affectedTruck, state: 'open', deadline: e.deadline, at: e.at,
        })
      } else if (t === 'exception.resolved') {
        const ex = world.exceptions.find((x) => x.state !== 'resolved')
        if (ex) { ex.state = 'resolved'; ex.resolution = e.resolution }
      } else if (t === 'config.changed') {
        if (e.configKey === 'site.capacity' && SITE_BY_ID[e.siteId]?.kind === 'parking') {
          SITE_BY_ID[e.siteId].spaces = e.value
        } else if (e.configKey === 'site.capacities.reset') {
          for (const [siteId, spaces] of Object.entries(e.capacities || {})) {
            if (SITE_BY_ID[siteId]?.kind === 'parking') SITE_BY_ID[siteId].spaces = spaces
          }
        }
      }
      break
    }
  }
  return world
}

/** Full replay. The invariant that proves the log is still the source of truth. */
export function rebuild(events) {
  const world = emptyWorld()
  for (const e of events) applyEvent(world, e)
  return world
}

/**
 * The store: the log, a running world, and a subscriber set so React can bind
 * through useSyncExternalStore without re-folding on every render.
 */
export function createStore() {
  const events = []
  const feedEvents = []
  let world = emptyWorld()
  let seq = 0
  let version = 0
  const listeners = new Set()

  function append(type, at, payload = {}) {
    const e = { seq: seq++, type, at, ...payload }
    events.push(e)
    // A separate capped feed array keeps the human feed O(1) instead of a
    // backwards scan across tens of thousands of pings.
    if (isFeedWorthy(e)) {
      feedEvents.push(e)
      if (feedEvents.length > 400) feedEvents.splice(0, feedEvents.length - 400)
    }
    applyEvent(world, e)
    return e
  }

  return {
    events,
    append,
    /** Batch a tick's worth of appends into a single notify. */
    commit() {
      version++
      world = { ...world }
      for (const l of listeners) l()
    },
    getWorld: () => world,
    getVersion: () => version,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    feed: (limit = 40) => feedEvents.slice(-limit).reverse(),
    reset() {
      events.length = 0
      feedEvents.length = 0
      world = emptyWorld()
      seq = 0
      version++
      for (const l of listeners) l()
    },
  }
}
