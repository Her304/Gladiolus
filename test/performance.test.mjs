import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../src/engine/events.js'
import { createSimulator } from '../src/engine/simulator.js'
import { EVENT } from '../src/contract.js'

describe('runtime update pressure', () => {
  test('telemetry does not invalidate operational projections', () => {
    const store = createStore()

    store.append(EVENT.PING, 1, {
      truckId: 'GLD-101',
      truck: { id: 'GLD-101', coord: [43, -80] },
    })
    store.commit()

    const operationalSnapshot = store.getOperationalEvents()
    assert.equal(operationalSnapshot.length, 0)
    assert.equal(store.getOperationalVersion(), 0)
    assert.equal(store.getTruckPings('GLD-101').length, 1)

    store.append(EVENT.PING, 2, {
      truckId: 'GLD-101',
      truck: { id: 'GLD-101', coord: [43.01, -80] },
    })
    store.commit()

    assert.equal(store.getOperationalEvents(), operationalSnapshot)
    assert.equal(store.getOperationalVersion(), 0)
    assert.equal(store.getTruckPings('GLD-101').length, 2)

    store.append(EVENT.DRIVER_ACTION, 3, { truckId: 'GLD-101', action: 'dispatch.requested' })
    store.commit()
    assert.equal(store.getOperationalVersion(), 1)
    assert.deepEqual(store.getOperationalEvents().map((event) => event.type), [EVENT.DRIVER_ACTION])
  })

  test('a physics step with no emitted event does not publish a React update', () => {
    const store = createStore()
    const simulator = createSimulator(store, { startHour: 14 })
    simulator.setSpeed(1)

    let notifications = 0
    store.subscribe(() => { notifications++ })
    simulator.bootstrap()
    // The first physics pass records any seeded trucks already inside a fence.
    simulator.advance(1)
    const settledEventCount = store.events.length
    const settledNotifications = notifications

    simulator.advance(1)

    assert.equal(store.events.length, settledEventCount)
    assert.equal(notifications, settledNotifications)
  })
})
