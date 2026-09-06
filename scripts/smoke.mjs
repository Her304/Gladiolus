/**
 * Headless smoke test for the engine. Runs eight simulated hours and asserts
 * the invariants that matter. This is the merge gate for the engine lane: if it
 * does not exit 0, nothing downstream can be trusted.
 */
import { createStore, rebuild, EVENT } from '../src/engine/events.js'
import { createSimulator } from '../src/engine/simulator.js'
import { INITIAL_INCIDENTS } from '../src/services/on511.js'
import { pressureBoard, recommendParking } from '../src/engine/parking.js'
import { CORRIDOR, SITES, PARKING_SITES, unreachableSites } from '../src/data/corridor.js'
import { clockLeftMs, reachableKm, DRIVE_LIMIT_MS } from '../src/engine/hos.js'
import { DWELL_THRESHOLD_MIN } from '../src/contract.js'

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : `  — ${detail}`}`)
  if (!cond) failures++
}

console.log(`corridor: ${CORRIDOR.length.toFixed(1)} km, ${SITES.length} sites\n`)

const store = createStore()
const sim = createSimulator(store, { startHour: 14 })
sim.setIncidents(INITIAL_INCIDENTS)
sim.bootstrap()

check('corridor length is realistic for the 401', CORRIDOR.length > 300 && CORRIDOR.length < 450, `${CORRIDOR.length.toFixed(1)} km`)
check('every site sits on the corridor', SITES.every((s) => s.chainage >= 0 && s.chainage <= CORRIDOR.length))
// Sites sit off the driven line. Any further off than the approach blend can
// reach is a fence that can never fire — which is silent, and breaks everything
// downstream: no dwells, no parking, no refusals, trucks stranded past lots.
check('every geofence is reachable from the driven line',
  unreachableSites().length === 0,
  unreachableSites().map((s) => s.id).join(' '))
check('incidents loaded from the cached fixture', INITIAL_INCIDENTS.length > 0, `${INITIAL_INCIDENTS.length}`)
check('bootstrap populated all 40 trucks', Object.keys(store.getWorld().trucks).length === 40)

const REAL_STEP = 500
const STEPS = (8 * 3600_000) / (REAL_STEP * sim.getSpeed())
const t0 = Date.now()
for (let i = 0; i < STEPS; i++) sim.advance(REAL_STEP)
const elapsed = Date.now() - t0

const world = store.getWorld()
console.log(`\n8 sim hours in ${elapsed} ms — ${store.events.length} events, ` +
  `${world.dwells.length} dwells, ${world.transits} transits, ${world.forcedStops} forced stops`)
console.log(`laden ${world.ladenKm.toFixed(0)} km, empty ${world.emptyKm.toFixed(0)} km\n`)

// The load-bearing property: the log is the source of truth.
const replayed = rebuild(store.events)
check('replaying the log reproduces the live world',
  replayed.dwells.length === world.dwells.length &&
  Math.abs(replayed.emptyKm - world.emptyKm) < 1e-6 &&
  Math.abs(replayed.ladenKm - world.ladenKm) < 1e-6 &&
  Object.keys(replayed.trucks).length === Object.keys(world.trucks).length)

const enters = store.events.filter((e) => e.type === EVENT.FENCE_ENTER).length
const exits = store.events.filter((e) => e.type === EVENT.FENCE_EXIT).length
check('geofences fired', enters > 20, `${enters} enters`)
check('exits never outnumber enters', exits <= enters, `${exits}/${enters}`)

// Trap 4: a drive-through is a transit, not a zero-minute dwell.
check('no dwell shorter than the stop threshold',
  world.dwells.every((d) => d.minutes >= DWELL_THRESHOLD_MIN),
  JSON.stringify(world.dwells.filter((d) => d.minutes < DWELL_THRESHOLD_MIN).slice(0, 3)))

check('drivers claimed parking before running out of clock',
  store.events.some((e) => e.type === EVENT.PARKING_CLAIM))
check('drivers took resets', store.events.some((e) => e.type === EVENT.BREAK_START))

const overLimit = Object.values(world.trucks)
  .filter((t) => t.state === 'driving' && t.drivingMs > DRIVE_LIMIT_MS + 3600_000)
check('no truck drives more than an hour past the 13 h limit',
  overLimit.length === 0,
  overLimit.map((t) => `${t.id}:${(t.drivingMs / 3600000).toFixed(1)}h`).join(' '))

// Trap 9: the fleet must not all pile into one rest area.
const worstLot = PARKING_SITES
  .map((s) => ({ s, n: (world.sites[s.id]?.occupants || []).length }))
  .sort((a, b) => b.n - a.n)[0]
check('no rest area holds more of our fleet than it has spaces',
  worstLot.n <= worstLot.s.spaces,
  `${worstLot.s.name} ${worstLot.n}/${worstLot.s.spaces}`)

// The behavioural counterpart to the reachability check above.
const visited = SITES.filter((s) => (world.sites[s.id]?.visits || 0) > 0 ||
  store.events.some((e) => e.type === EVENT.FENCE_ENTER && e.siteId === s.id))
check('most sites saw real traffic over the run',
  visited.length >= Math.ceil(SITES.length * 0.75),
  `${visited.length}/${SITES.length} visited: missing ` +
  SITES.filter((s) => !visited.includes(s)).map((s) => s.id).join(' '))

const board = pressureBoard(world, new Date(sim.getClock()))
console.log('\nparking pressure board:')
for (const p of board) {
  console.log(
    `  ${p.site.name.padEnd(29)}${String(p.occupied).padStart(2)}/${String(p.site.spaces).padEnd(3)}` +
    ` free ${String(p.projectedFree).padStart(2)}   seen ${p.observed}` +
    `  conf ${p.confidence.toFixed(2)}  inbound ${p.inbound.length}   ${p.level}`,
  )
}
check('every estimate is bounded by capacity and never below what we can see',
  board.every((p) => p.occupied >= p.observed && p.occupied <= p.site.spaces && p.estimatedUtil <= 1))

const tightest = Object.values(world.trucks)
  .filter((t) => t.state === 'driving')
  .sort((a, b) => clockLeftMs(a) - clockLeftMs(b))[0]
if (tightest) {
  const rec = recommendParking(tightest, world, new Date(sim.getClock()))
  console.log(`\ntightest clock: ${tightest.id}, ${(clockLeftMs(tightest) / 3600000).toFixed(2)} h left`)
  console.log(rec
    ? `  -> ${rec.best.site.name}, ${rec.best.ahead.toFixed(0)} km ahead, ` +
      `${rec.best.projectedFree} projected free, viable=${rec.viable}`
    : '  -> nothing reachable (this is the real alert)')
  check('a recommendation is ahead of the truck and inside its reach',
    !rec || (rec.best.ahead > 0 && rec.best.ahead <= rec.reach))
  // Trap 8: null is correct only when nothing is reachable — never merely
  // because every reachable lot is busy.
  const reach = reachableKm(tightest)
  const reachable = board.filter((p) => {
    const ahead = (p.site.chainage - tightest.chainage) * tightest.direction
    return ahead > 0 && ahead <= reach
  })
  check('recommender returns an option whenever one is reachable, null only when none is',
    (reachable.length > 0) === (rec !== null),
    `${reachable.length} reachable within ${reach.toFixed(0)} km, rec=${rec ? 'yes' : 'null'}`)

  // And with every lot busy it must still hand back the least-bad one.
  const lateNight = new Date(sim.getClock())
  lateNight.setHours(2, 0, 0, 0)
  const roomy = { ...tightest, chainage: 10, direction: 1, speedKph: 95, drivingMs: 0, onDutyMs: 0 }
  const lateRec = recommendParking(roomy, world, lateNight)
  check('at 02:00, when lots are near capacity, it still returns a best option',
    lateRec !== null && Boolean(lateRec.best),
    lateRec ? `${lateRec.best.site.name} viable=${lateRec.viable}` : 'null')
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
process.exit(failures ? 1 : 0)
