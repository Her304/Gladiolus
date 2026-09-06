import { EVENT, FEED_TYPES, DWELL_THRESHOLD_MIN } from '../contract.js'

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
    ladenKm: 0,
    emptyKm: 0,
    transits: 0,
    forcedStops: 0,
    lastEventSeq: -1,
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
      const s = siteState(world, e.siteId)
      s.claims = s.claims.filter((c) => c.truckId !== e.truckId)
      s.claims.push({ truckId: e.truckId, etaMin: e.etaMin, at: e.at })
      break
    }
    case EVENT.PARKING_RELEASE: {
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
    default:
      break
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
    if (FEED_TYPES.has(type)) {
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
