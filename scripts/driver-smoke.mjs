import assert from 'node:assert/strict'
import { createDriverDemo, DEMO_ID, latestOffer, driverActions, hosRings } from '../src/driver/model.js'
import { rebuild } from '../src/engine/events.js'
import { createSimulator } from '../src/engine/simulator.js'
import { createStore } from '../src/engine/events.js'
import { recommendParking } from '../src/engine/parking.js'
import { EVENT, INSPECTION_VALID_H, isFeedWorthy } from '../src/contract.js'
import { inspectionState, hasMajor, fleetDefects } from '../src/engine/inspection.js'
import { openBreakdown, respondersFor, fleetBreakdowns } from '../src/engine/breakdown.js'
import { scaleStatus, scalesAhead, historicalOpen } from '../src/engine/scales.js'
import { SCALE_BY_ID, facilitiesOf, SITE_BY_ID, PARKING_SITES, vendorsNear } from '../src/data/corridor.js'
import { incidentsAhead } from '../src/services/on511.js'
import { INITIAL_INCIDENTS } from '../src/services/on511.js'
const d = createDriverDemo()
const truck = () => d.store.getWorld().trucks[DEMO_ID]
assert.equal(hosRings(truck())[0].used, 15600000)
d.setScene('offer')
let offer = latestOffer(d.store.events, DEMO_ID)
assert(d.act('load.accepted', { offerId: offer.offerId }).ok)
assert.equal(truck().loadId, offer.offerId)
assert.equal(latestOffer(d.store.events, DEMO_ID), null)
assert.equal(d.act('load.accepted', { offerId: offer.offerId }).ok, false)
d.setScene('offer')
offer = latestOffer(d.store.events, DEMO_ID)
assert(d.act('load.rejected', { offerId: offer.offerId }).ok)
assert.equal(truck().loadId, null)
d.setScene('offer')
for(let i=0;i<241;i++) d.tick()
assert.equal(d.act('load.accepted', {offerId:'MG-4490'}).ok,false)
d.setScene('critical')
assert.equal(d.act('parking.claimed', {siteId:'onr-tilbury'}).ok,false)
assert(d.act('parking.claimed', {siteId:'onr-trafalgar'}).ok)
assert(d.act('parking.claimed', {siteId:'onr-trafalgar'}).ok)
assert.equal(d.store.getWorld().sites['onr-trafalgar'].claims.length,1)
assert.equal(truck().claimedSiteId,'onr-trafalgar')
assert(d.act('parking.released').ok)
assert.equal(truck().claimedSiteId,null)
assert.equal(d.store.getWorld().sites['onr-trafalgar'].claims.length,0)
assert.equal(d.act('delay.reported', {message:'   '}).ok,false)
assert(d.act('delay.reported', {message:'Waiting at gate',reason:'Waiting for a dock'}).ok)
assert.equal(driverActions(d.store.events,DEMO_ID).at(-1).message,'Waiting at gate')

// Facility scenes are a usable driver workflow, not a static dock mock:
// pickup loads the trailer and delivery unloads it, with each confirmation
// recorded as an independent stop milestone.
d.setScene('loading')
assert.equal(truck().laden, false)
assert.equal(d.store.getWorld().stops['london-dc'].milestone, 'arrived')
for (const action of ['checkInStop', 'startService', 'completeService']) assert(d.advanceVisit(action).ok)
assert.equal(truck().laden, true)
assert(d.advanceVisit('departStop').ok)
d.setScene('unloading')
assert.equal(truck().laden, true)
assert.equal(d.store.getWorld().stops['cambridge-dc'].milestone, 'arrived')
for (const action of ['checkInStop', 'startService', 'completeService']) assert(d.advanceVisit(action).ok)
assert.equal(truck().laden, false)
assert(d.advanceVisit('departStop').ok)
assert.deepEqual(rebuild(d.store.events),d.store.getWorld())
const live = createStore(), sim = createSimulator(live)
sim.bootstrap()
const t = Object.values(live.getWorld().trucks).find(t=>recommendParking(t,live.getWorld(),new Date(live.getWorld().clock)))
const target = recommendParking(t,live.getWorld(),new Date(live.getWorld().clock)).best.site
assert(sim.driverParking(t.id,target.id).ok)
assert.equal(live.getWorld().trucks[t.id].claimedSiteId,target.id)
assert(sim.driverParking(t.id,null).ok)
assert.equal(live.getWorld().trucks[t.id].claimedSiteId,null)
assert.deepEqual(rebuild(live.events),live.getWorld())

// --- Facilities -------------------------------------------------------------
// Reference data, so the only thing worth asserting is that it is complete and
// resolves: a chip that renders as a bare id is a silent data bug.
for (const site of PARKING_SITES) {
  assert(site.facilities?.length, `${site.id} has no facilities recorded`)
  assert.equal(facilitiesOf(site).length, site.facilities.length, `${site.id} has an unknown facility id`)
}

// --- Daily trip inspection --------------------------------------------------
const H = 3_600_000
const now = 1_757_000_000_000
const ev = (at, over = {}) => ({ seq: 0, type: EVENT.INSPECTION, at, truckId: 'T1', phase: 'pre-trip', defects: [], major: false, odometerKm: 1, note: '', ...over })

// No record at all is a prompt, never a blocker: an empty log means this portal
// has not seen an inspection, not that the driver failed to do one.
let st = inspectionState([], 'T1', now)
assert.equal(st.blocking, false)
assert.equal(st.prompt, true)

st = inspectionState([ev(now - 2 * H)], 'T1', now)
assert.equal(st.blocking, false)
assert.equal(st.prompt, false)
assert.equal(st.expiresAt, now - 2 * H + INSPECTION_VALID_H * H)

// One held past its 24-hour life does block.
st = inspectionState([ev(now - (INSPECTION_VALID_H + 1) * H)], 'T1', now)
assert.equal(st.blocking, true)
assert.match(st.reason, /more than 24 hours/)

// A major defect blocks, and stays blocking until a later clean pre-trip clears it.
const major = ev(now - H, { defects: ['tires'], major: true })
st = inspectionState([major], 'T1', now)
assert.equal(st.blocking, true)
assert(st.major)
st = inspectionState([major, ev(now - 0.5 * H)], 'T1', now)
assert.equal(st.major, null)
assert.equal(st.blocking, false)

assert.equal(hasMajor(['tires']), true)
assert.equal(hasMajor(['lamps', 'glass']), false)
assert.equal(hasMajor([]), false)
assert.equal(fleetDefects([major], now).length, 1)

// A clean inspection is a compliance record, not dispatcher news; one with a
// defect on it changes what the dispatcher does next.
assert.equal(isFeedWorthy({ ...ev(now), defects: [] }), false)
assert.equal(isFeedWorthy({ ...ev(now), defects: ['lamps'] }), true)

// --- Breakdown --------------------------------------------------------------
const bd = { seq: 1, type: EVENT.BREAKDOWN, at: now, truckId: 'T1', category: 'tire', chainage: 250 }
assert.equal(openBreakdown([bd], 'T1').category, 'tire')
assert.equal(openBreakdown([bd, { seq: 2, type: EVENT.BREAKDOWN_CLEARED, at: now + H, truckId: 'T1' }], 'T1'), null)
assert.equal(openBreakdown([bd], 'T2'), null)
assert.equal(fleetBreakdowns([bd]).length, 1)

// Every category on every kilometre of the corridor must reach somebody, or the
// flow dead-ends exactly where a driver cannot afford it to.
for (const km of [0, 50, 120, 200, 280, 363]) {
  for (const cat of ['tire', 'mechanical', 'air-brake', 'electrical', 'reefer', 'collision', 'other']) {
    assert(respondersFor(cat, km).primary, `no responder for ${cat} at km ${km}`)
  }
}
// Towing is the expensive answer, so it never displaces a vendor who can fix it in place.
assert.equal(respondersFor('tire', 250).primary.services.includes('tire'), true)

// --- Inspection stations ----------------------------------------------------
const world = { clock: now, trucks: {}, sites: {} }
const milton = SCALE_BY_ID['scale-milton']
const at = (id, chainage, speedKph, direction = 1) => ({ id, chainage, speedKph, direction, state: 'driving' })

// No sample: the prior carries it, and nothing pretends otherwise.
let s0 = scaleStatus(milton, world, new Date(now))
assert.equal(s0.samples, 0)
assert.equal(s0.confidence, 0)
assert.equal(s0.probability, historicalOpen(milton, new Date(now)))

// Trucks slowing at the station while the corridor around them runs free is the
// signal. Congestion is the control: if everyone is slow, nothing is inferred.
const band = { ...world, trucks: Object.fromEntries([
  at('a', milton.chainage, 20), at('b', milton.chainage + 1, 25), at('c', milton.chainage - 2, 18),
  at('d', milton.chainage - 15, 95), at('e', milton.chainage + 18, 92), at('f', milton.chainage - 20, 94),
].map(t => [t.id, t])) }
const open = scaleStatus(milton, band, new Date(now))
assert.equal(open.samples, 3)
assert.equal(open.slowed, 3)
assert.equal(open.level, 'open')

const jam = { ...world, trucks: Object.fromEntries([
  at('a', milton.chainage, 20), at('b', milton.chainage + 1, 25), at('c', milton.chainage - 2, 18),
  at('d', milton.chainage - 15, 22), at('e', milton.chainage + 18, 19), at('f', milton.chainage - 20, 21),
].map(t => [t.id, t])) }
const congested = scaleStatus(milton, jam, new Date(now))
assert.equal(congested.samples, 3)
assert.equal(congested.slowed, 0, 'congestion must not read as an open station')
assert.equal(congested.level, 'closed')

// A station serves one carriageway; the far side of the median tells us nothing.
const wrongWay = { ...world, trucks: { z: at('z', milton.chainage, 15, -1) } }
assert.equal(scaleStatus(milton, wrongWay, new Date(now)).samples, 0)

// Only stations still ahead, and only on the driver's own carriageway.
const eastbound = { id: 'E', chainage: 100, direction: 1, speedKph: 90, state: 'driving' }
const ahead = scalesAhead(eastbound, world, new Date(now))
assert(ahead.every(x => x.ahead > 0 && x.site.direction === 1))
assert.deepEqual(ahead.map(x => x.site.id), [...ahead].sort((a, b) => a.ahead - b.ahead).map(x => x.site.id))
assert.equal(scalesAhead({ ...eastbound, chainage: 363 }, world, new Date(now)).length, 0)

// Probability is a probability, at every hour of the day, for every station.
for (const site of Object.values(SCALE_BY_ID)) {
  for (let h = 0; h < 24; h++) {
    const p = historicalOpen(site, new Date(2026, 8, 7, h))
    assert(p >= 0 && p <= 1, `${site.id} at ${h}:00 gave ${p}`)
  }
}

// --- Incidents ahead --------------------------------------------------------
const east = { chainage: 150, direction: 1 }
const west = { chainage: 150, direction: -1 }
for (const t of [east, west]) {
  for (const inc of incidentsAhead(t, INITIAL_INCIDENTS)) {
    assert(inc.ahead > 0, 'an incident behind the truck is not a decision')
    assert(/Both/i.test(inc.direction) || new RegExp(t.direction === 1 ? 'east' : 'west', 'i').test(inc.direction))
  }
}
assert.deepEqual(incidentsAhead(null, INITIAL_INCIDENTS), [])

// --- The new events replay like every other one ------------------------------
const demo2 = createDriverDemo()
demo2.store.append(EVENT.INSPECTION, demo2.store.getWorld().clock, { truckId: DEMO_ID, phase: 'pre-trip', defects: ['lamps'], major: false, odometerKm: 1, note: '' })
demo2.store.append(EVENT.BREAKDOWN, demo2.store.getWorld().clock, { truckId: DEMO_ID, category: 'tire', chainage: 100, blockingLane: false })
demo2.store.commit()
assert.deepEqual(rebuild(demo2.store.events), demo2.store.getWorld())
assert(openBreakdown(demo2.store.events, DEMO_ID))
assert.equal(inspectionState(demo2.store.events, DEMO_ID, demo2.store.getWorld().clock).blocking, false)

console.log('Driver checks passed: offers, expiry, duplicate protection, claims, release, requests, replay, live simulator actions,')
console.log('  facilities, inspections (prompt vs block, major defects), breakdowns (vendor coverage), scales (congestion control), incidents ahead.')
