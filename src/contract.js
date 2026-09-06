/**
 * The contract. Written first and frozen: the engine implements it, the views
 * read it, and neither side needs the other to exist to start work.
 *
 * The one rule everything else follows: the event log is the only source of
 * truth. Nothing writes application state directly. Every view is a fold over
 * the log, so any view can be rebuilt by replaying it, and a new metric needs a
 * new fold rather than a migration.
 */

export const EVENT = {
  PING: 'truck.ping',
  FENCE_ENTER: 'fence.enter',
  FENCE_EXIT: 'fence.exit',
  LOAD_ASSIGNED: 'load.assigned',
  LOAD_DELIVERED: 'load.delivered',
  BREAK_START: 'hos.break.start',
  BREAK_END: 'hos.break.end',
  PARKING_CLAIM: 'parking.claim',
  PARKING_RELEASE: 'parking.release',
  FORCED_STOP: 'hos.forced_stop',
  INCIDENT: 'traffic.incident',
}

/** Events a human should see in the feed. Pings are far too noisy. */
export const FEED_TYPES = new Set([
  EVENT.FENCE_ENTER,
  EVENT.FENCE_EXIT,
  EVENT.LOAD_ASSIGNED,
  EVENT.LOAD_DELIVERED,
  EVENT.BREAK_START,
  EVENT.BREAK_END,
  EVENT.PARKING_CLAIM,
  EVENT.FORCED_STOP,
  EVENT.INCIDENT,
])

/**
 * A stop under this many minutes is a truck driving through a geofence, not a
 * visit. Recording those as dwells fills the league table with noise.
 */
export const DWELL_THRESHOLD_MIN = 5

/**
 * Which events a dispatcher should actually see.
 *
 * Several rest areas sit closer to the highway than their own fence radius, so
 * every truck that drives past trips the geofence. That is real telematics
 * behaviour and the log records all of it — but a feed full of "arrived" and
 * "passed without stopping" for trucks that never left the mainline is noise.
 * The log keeps everything; this decides what surfaces.
 */
export function isFeedWorthy(e) {
  if (!FEED_TYPES.has(e.type)) return false
  if (e.type === EVENT.FENCE_ENTER) return Boolean(e.intended)
  if (e.type === EVENT.FENCE_EXIT) return e.dwellMin >= DWELL_THRESHOLD_MIN
  return true
}

/**
 * How far ahead of a site a truck begins pulling off the mainline, in km.
 *
 * Trucks drive the corridor polyline, but sites sit a few hundred metres off it
 * — a rest area is beside the highway, not on it. Without modelling the exit,
 * a truck sails straight past every geofence and none of them ever fire. Any
 * site further off the line than this is unreachable, which `scripts/smoke.mjs`
 * asserts.
 */
export const APPROACH_KM = 1.5

/**
 * @typedef {Object} Truck  The observable subset. Views may read only this.
 * @property {string} id
 * @property {string} plate
 * @property {string} driverId
 * @property {string} driverName
 * @property {[number,number]} coord      [lat, lon]
 * @property {number} heading             degrees, for icon rotation
 * @property {number} chainage            km along the corridor, west to east
 * @property {1|-1} direction             1 = eastbound
 * @property {number} speedKph
 * @property {number} odometerKm
 * @property {boolean} laden
 * @property {string|null} loadId
 * @property {string} destinationId
 * @property {'driving'|'dwelling'|'resting'} state
 * @property {number} drivingMs           accumulated this shift
 * @property {number} onDutyMs
 * @property {string|null} insideSiteId
 * @property {string|null} claimedSiteId
 * @property {boolean} parked
 *
 * @typedef {Object} World
 * @property {number} clock
 * @property {Record<string, Truck>} trucks
 * @property {Record<string, {occupants: string[], claims: object[], visits: number}>} sites
 * @property {{truckId: string, siteId: string, minutes: number, at: number}[]} dwells
 * @property {number} ladenKm
 * @property {number} emptyKm
 * @property {number} transits            drive-throughs, not counted as dwells
 *
 * @typedef {Object} Pressure
 * @property {object} site
 * @property {number} observed            our own trucks on site, counted exactly
 * @property {number} claims
 * @property {object[]} inbound
 * @property {number} historical          0-1, time-of-day baseline
 * @property {number} confidence          0-1, how much the live sample is trusted
 * @property {number} estimatedUtil       0-1
 * @property {number} occupied
 * @property {number} free
 * @property {number} projectedFree
 * @property {'open'|'filling'|'tight'|'full'} level
 */

/**
 * A frozen, hand-written world. Lets the views render before the simulator
 * exists, and gives the test suite a fixture that never drifts.
 */
export function mockWorld() {
  const at = Date.UTC(2026, 8, 6, 18, 0, 0)
  const truck = (id, over) => ({
    id,
    plate: `ON ZZ ${id.slice(-3)}`,
    driverId: `D-${id.slice(-3)}`,
    driverName: 'Demo Driver',
    coord: [43.13, -80.75],
    heading: 90,
    chainage: 225,
    direction: 1,
    speedKph: 96,
    odometerKm: 120_000,
    laden: true,
    loadId: 'L-4001',
    destinationId: 'cambridge-dc',
    state: 'driving',
    drivingMs: 6 * 3600_000,
    onDutyMs: 7 * 3600_000,
    insideSiteId: null,
    claimedSiteId: null,
    parked: false,
    ...over,
  })

  return {
    clock: at,
    trucks: {
      'GLD-101': truck('GLD-101'),
      'GLD-102': truck('GLD-102', { chainage: 240, laden: false, loadId: null }),
      'GLD-103': truck('GLD-103', { chainage: 269, state: 'resting', parked: true, insideSiteId: 'onr-cambridge', drivingMs: 13 * 3600_000 }),
      'GLD-104': truck('GLD-104', { chainage: 132, direction: -1, drivingMs: 12.6 * 3600_000 }),
      'GLD-105': truck('GLD-105', { chainage: 76, state: 'dwelling', insideSiteId: 'chatham-pt' }),
      'GLD-106': truck('GLD-106', { chainage: 298, drivingMs: 2 * 3600_000 }),
    },
    sites: {
      'onr-cambridge': { occupants: ['GLD-103'], claims: [], visits: 4 },
      'onr-woodstock': { occupants: [], claims: [{ truckId: 'GLD-104', etaMin: 40, at }], visits: 2 },
      'chatham-pt': { occupants: ['GLD-105'], claims: [], visits: 1 },
    },
    dwells: [
      { truckId: 'GLD-105', siteId: 'chatham-pt', minutes: 62, at },
      { truckId: 'GLD-101', siteId: 'london-dc', minutes: 47, at: at - 3600_000 },
    ],
    ladenKm: 8837,
    emptyKm: 2510,
    transits: 3,
  }
}
