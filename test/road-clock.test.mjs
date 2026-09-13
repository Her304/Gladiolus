import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../src/engine/events.js'
import { createSimulator } from '../src/engine/simulator.js'
import { CORRIDOR, ROAD_CORRIDOR } from '../src/data/corridor.js'
import { haversine, positionAt } from '../src/engine/geo.js'
import { EVENT } from '../src/contract.js'
import { fmtTime } from '../src/format.js'

test('the simulator starts at the current time unless an explicit clock is supplied', () => {
  const before = Date.now()
  const store = createStore()
  const sim = createSimulator(store)
  sim.bootstrap()
  const after = Date.now()

  assert.ok(store.getWorld().clock >= before)
  assert.ok(store.getWorld().clock <= after)
})

test('moving fleet telemetry is emitted on the detailed Highway 401 geometry', () => {
  const store = createStore()
  const sim = createSimulator(store, { startAt: Date.UTC(2026, 8, 13, 14, 0, 0) })
  sim.bootstrap()
  const truck = Object.values(store.getWorld().trucks).find((t) => !t.insideSiteId)
  const expected = positionAt(ROAD_CORRIDOR, truck.chainage / CORRIDOR.length * ROAD_CORRIDOR.length)

  assert.ok(haversine(truck.coord, expected) < 0.005, 'truck position is on the road trace')
})

test('a new simulation session clears an earlier simulated fleet projection', () => {
  const store = createStore()
  store.append(EVENT.PING, Date.UTC(2026, 8, 13, 18), {
    truckId: 'OLD-TRUCK', truck: { id: 'OLD-TRUCK', coord: [43.5, -79.5] }, source: 'simulated',
  })
  const sim = createSimulator(store, { startAt: Date.UTC(2026, 8, 13, 14) })
  sim.bootstrap()

  const world = store.getWorld()
  assert.equal(world.trucks['OLD-TRUCK'], undefined)
  assert.equal(world.clock, Date.UTC(2026, 8, 13, 14))
  assert.equal(Object.keys(world.trucks).length, 40)
})

test('the simulator clock and rendered labels use Toronto time', () => {
  // September observes EDT (UTC-4), so 18:00Z is 14:00 in Toronto.
  const store = createStore()
  const sim = createSimulator(store, { startAt: Date.UTC(2026, 8, 13, 12, 0, 0), startHour: 14 })
  sim.bootstrap()

  assert.equal(sim.getClock(), Date.UTC(2026, 8, 13, 18, 0, 0))
  assert.equal(fmtTime(Date.UTC(2026, 8, 13, 18, 5, 0)), '14:05')
})
