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
  // Starts a new synthetic telemetry session. This prevents an old accelerated
  // demo run from bleeding into a fresh real-time run after a server restart.
  SIMULATION_RESET: 'simulation.reset',
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
  ADMIN_ACTION: 'admin.action',
  DRIVER_ACTION: 'driver.action',
  // A daily trip inspection under O. Reg. 199/07 Schedule 1. Legally the driver
  // must record one before the first drive of the day and again at the end of
  // it, so this is not a feature the portal may omit.
  INSPECTION: 'inspection.recorded',
  // A truck that cannot move is the highest-stakes event a driver generates.
  // It is its own type rather than a driver.action detail so that a dispatcher
  // fold can find every one of them without string-matching a payload.
  BREAKDOWN: 'truck.breakdown',
  BREAKDOWN_CLEARED: 'truck.breakdown.cleared',
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
  // An administrator changing corridor configuration is operationally relevant
  // to the dispatcher watching the board, so it surfaces in the same feed
  // rather than in a private admin-only channel.
  EVENT.ADMIN_ACTION,
  EVENT.DRIVER_ACTION,
  EVENT.PARKING_RELEASE,
  EVENT.INSPECTION,
  EVENT.BREAKDOWN,
  EVENT.BREAKDOWN_CLEARED,
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
  // A clean inspection is a compliance record, not dispatcher news. One with a
  // defect on it changes what the dispatcher does next, so only that surfaces.
  if (e.type === EVENT.INSPECTION) return e.defects?.length > 0
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
 *
 * @typedef {Object} Facility  What a parking site actually offers.
 *   Static reference data, not sensed. Drivers choose a rest stop on parking
 *   first and amenities second, so these qualify a stop rather than list one.
 * @property {string} id
 * @property {string} label
 *
 * @typedef {Object} ScaleStatus  Fleet-as-sensor inspection-station estimate.
 * @property {object} site
 * @property {number} samples             our trucks close enough to observe
 * @property {number} slowed              of those, ones well below free-flow
 * @property {number} historical          0-1, time-of-day likelihood of open
 * @property {number} confidence          0-1, how much the live sample is trusted
 * @property {number} probability         0-1, blended estimate that it is open
 * @property {'open'|'likely-open'|'unknown'|'likely-closed'|'closed'} level
 * @property {number|null} lastSeenAt     when a truck last passed it
 *
 * @typedef {Object} Inspection  One recorded daily trip inspection.
 * @property {string} truckId
 * @property {'pre-trip'|'post-trip'} phase
 * @property {number} at
 * @property {string[]} defects           Schedule 1 item ids, empty when clean
 * @property {boolean} major              a defect that puts the truck out of service
 * @property {number} odometerKm
 * @property {string} note
 *
 * @typedef {Object} Breakdown  An open immobilising fault.
 * @property {string} truckId
 * @property {number} at
 * @property {string} category
 * @property {[number,number]} coord
 * @property {number} chainage
 * @property {string|null} vendorId       the vendor dispatch was pointed at
 * @property {boolean} blockingLane       changes the urgency, and calls 911 first
 */

/**
 * A daily trip inspection is valid for 24 hours (O. Reg. 199/07 s. 8). After
 * that the driver may not operate until a new one is recorded, which is why the
 * portal blocks on it rather than nagging.
 */
export const INSPECTION_VALID_H = 24

/**
 * Schedule 1 of O. Reg. 199/07, condensed to the groups a driver walks around.
 * `major` means the defect puts the vehicle out of service immediately — the
 * driver may not drive it, and no amount of dispatch pressure changes that.
 */
export const INSPECTION_ITEMS = [
  { id: 'air-brake', label: 'Air brake system', major: true },
  { id: 'coupling', label: 'Coupling devices', major: true },
  { id: 'steering', label: 'Steering', major: true },
  { id: 'tires', label: 'Tires and wheels', major: true },
  { id: 'suspension', label: 'Suspension', major: true },
  { id: 'frame', label: 'Frame and cargo body', major: false },
  { id: 'lamps', label: 'Lamps and reflectors', major: false },
  { id: 'glass', label: 'Glass and mirrors', major: false },
  { id: 'wipers', label: 'Windshield wipers and washer', major: false },
  { id: 'exhaust', label: 'Exhaust system', major: false },
  { id: 'fuel', label: 'Fuel system', major: false },
  { id: 'cargo', label: 'Cargo securement', major: false },
  { id: 'emergency', label: 'Emergency equipment', major: false },
  { id: 'heater', label: 'Heater and defroster', major: false },
]
export const INSPECTION_BY_ID = Object.fromEntries(INSPECTION_ITEMS.map((i) => [i.id, i]))

/**
 * Why a truck stopped moving. The categories are the ones that decide which
 * vendor gets called, not a free-text symptom — a driver on a live shoulder
 * should be tapping one button, not composing a description.
 */
export const BREAKDOWN_CATEGORIES = [
  { id: 'tire', label: 'Tire or wheel', service: 'tire' },
  { id: 'mechanical', label: 'Engine or mechanical', service: 'mechanical' },
  { id: 'air-brake', label: 'Air or brake system', service: 'mechanical' },
  { id: 'electrical', label: 'Electrical or no start', service: 'mechanical' },
  { id: 'reefer', label: 'Reefer unit', service: 'reefer' },
  { id: 'collision', label: 'Collision damage', service: 'tow' },
  { id: 'other', label: 'Something else', service: 'mechanical' },
]

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
