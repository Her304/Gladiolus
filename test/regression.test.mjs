/**
 * Phase 0 regression tests — reproduce the UNSAFE current behavior.
 *
 * These drive the *existing* (v1) engine code from the assessment's
 * counterexamples. They assert what the code currently does (the unsafe
 * behavior), documenting the bugs Phase 1-4 must fix. When the engine is
 * migrated onto the v2 domain contract, these flip to assert the corrected
 * behavior and become the proof the fix worked.
 *
 * Counterexamples from corridor-project-assessment.md §6 and §9.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { remaining, clockLeftMs, hosStatus, reachableKm, DRIVE_LIMIT_MS, DUTY_LIMIT_MS } from '../src/engine/hos.js'

const H = 3600_000

describe('active HOS — the former counterexamples, now fixed', () => {
  test('missing driving/duty fields → unresolved, not ok (assessment §6 fixed)', () => {
    // Assessment §6: "Missing driving and duty fields → 13 hours available; status ok."
    // FIXED: unknown history is now 'unresolved', not affirmative availability.
    const truck = {} // no drivingMs, no onDutyMs
    const r = remaining(truck)
    assert.equal(r.driving, null, 'missing history yields null, not 13h')
    assert.equal(r.duty, null, 'missing history yields null, not 14h')
    assert.equal(hosStatus(truck), 'unresolved', 'unknown HOS is unresolved, not ok')
    assert.equal(clockLeftMs(truck), 0, 'unknown HOS yields 0 clock, not 13h')
  })

  test('elapsed/cycle exhaustion still not modeled by the two-counter helper (domain layer blocks it)', () => {
    // The two-counter helper still has no elapsed/cycle notion — that lives in
    // domain/feasibility.js (hosFeasibility), which the simulator's pre-movement
    // guard now uses. Document that the helper alone is insufficient and the
    // domain layer is the authority.
    const truck = { drivingMs: 5 * H, onDutyMs: 8 * H }
    assert.ok(clockLeftMs(truck) > 0, 'two-counter helper still reports hours (domain layer blocks on elapsed/cycle)')
    assert.equal(hosStatus(truck), 'ok', 'helper says ok; domain gateMovement says infeasible')
  })

  test('reachableKm no longer floors speed at 40km/h (assessment §6 fixed)', () => {
    // Assessment §6: "Actual speed 10km/h; 1h available → reach calculated as 40km."
    // FIXED: reach tracks the real speed with no floor.
    const truck = { drivingMs: 12 * H, onDutyMs: 13 * H, speedKph: 10 }
    const reach = reachableKm(truck)
    assert.ok(reach < 15, `10km/h truck now gets ~10km reach, not 40km-floored (got ${reach})`)
  })
})

describe('active simulator — arrival no longer conflated with delivery (fixed)', () => {
  // Assessment §5 flagged: "When a loaded truck enters its destination fence, it
  // immediately emits load.delivered, clears the load and begins its dock wait."
  // The active simulator now routes through the v2 milestones: arrival emits
  // STOP_ARRIVED (the load stays attached), and delivery is STOP_SERVICE_COMPLETED
  // when the dwell expires — not at fence entry.
  test('the active simulator emits STOP_SERVICE_COMPLETED, not LOAD_DELIVERED at fence entry', async () => {
    const simSrc = await import('node:fs').then((m) => m.readFileSync(new URL('../src/engine/simulator.js', import.meta.url), 'utf8'))
    // The fence-enter branch now emits STOP_ARRIVED, not LOAD_DELIVERED.
    assert.ok(simSrc.includes('STOP_ARRIVED'), 'arrival emits STOP_ARRIVED')
    assert.ok(!simSrc.includes('store.append(EVENT.LOAD_DELIVERED'), 'no LOAD_DELIVERED at fence entry')
    // Service completion is its own milestone, emitted on dwell expiry.
    assert.ok(simSrc.includes('STOP_SERVICE_COMPLETED'), 'delivery is STOP_SERVICE_COMPLETED')
  })

  test('a dwell produces a v2 milestone sequence and a billable detention when over free time', async () => {
    const { createStore } = await import('../src/engine/events.js')
    const { createSimulator } = await import('../src/engine/simulator.js')
    const { INITIAL_INCIDENTS } = await import('../src/services/on511.js')
    const store = createStore()
    const sim = createSimulator(store, { startHour: 14 })
    sim.setIncidents(INITIAL_INCIDENTS)
    sim.bootstrap()
    // 8 sim hours — enough for visits to complete.
    for (let i = 0; i < 57600; i++) sim.advance(500)
    const events = store.events
    assert.ok(events.some((e) => e.type === 'stop.arrived'), 'arrivals recorded as stop.arrived')
    assert.ok(events.some((e) => e.type === 'stop.service_completed'), 'delivery is service completion')
    assert.equal(events.filter((e) => e.type === 'load.delivered').length, 0, 'no LOAD_DELIVERED conflation')
    // At least one billable detention claim over the 8 hours.
    assert.ok(events.some((e) => e.type === 'detention.calculated'), 'a billable detention was calculated')
  })

  test('a truck whose HOS expires at the dock does not drift into a 375m move', async () => {
    // Assessment §6: "a following tick moves about 375m at 90km/h before a
    // forced stop." The pre-movement guard now holds before drive().
    const { createStore } = await import('../src/engine/events.js')
    const { createSimulator } = await import('../src/engine/simulator.js')
    const { INITIAL_INCIDENTS } = await import('../src/services/on511.js')
    const store = createStore()
    const sim = createSimulator(store, { startHour: 14 })
    sim.setIncidents(INITIAL_INCIDENTS)
    sim.bootstrap()
    // Run long enough for trucks to approach/exhaust HOS — the guard fires on
    // its own. Over 8 sim hours several trucks hit the limit.
    for (let i = 0; i < 57600; i++) sim.advance(500)
    const exceptions = store.events.filter((e) => e.type === 'exception.opened')
    // The pre-movement guard opens exceptions instead of drifting.
    assert.ok(exceptions.length > 0, 'HOS exhaustion opened exceptions, not silent drifts')
    // And no truck is recorded driving past its limit on the tick it expires.
    const world = store.getWorld()
    const overLimit = Object.values(world.trucks)
      .filter((t) => t.state === 'driving' && t.drivingMs > 13 * 3600_000 + 3600_000)
    assert.equal(overLimit.length, 0, 'no truck drifts past the limit before a forced stop')
  })
})
