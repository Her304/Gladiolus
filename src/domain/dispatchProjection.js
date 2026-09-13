/** Read model for the dispatcher load queue and exception ownership. */
export function projectDispatch(events = []) {
  const loads = new Map()
  const exceptions = new Map()

  for (const e of events) {
    if (e.type === 'shipment.posted' && e.loadId) {
      loads.set(e.loadId, {
        id: e.loadId, shipmentId: e.shipmentId, originId: e.originId || e.stops?.[0],
        destinationId: e.destinationId || e.stops?.at(-1), readyAt: e.readyAt,
        appointment: e.appointment, expiresAt: e.expiresAt, revenue: e.revenue,
        equipment: e.equipment || [], payloadKg: e.payloadKg, status: 'open',
        offeredTo: null, truckId: null, postedAt: e.observedAt ?? e.at,
      })
    } else if (e.type === 'offer.created') {
      const load = loads.get(e.loadId)
      if (load) Object.assign(load, { status: 'offered', offeredTo: e.driverId, truckId: e.truckId, feasibility: e.feasibility, deadheadKm: e.deadheadKm ?? e.feasibility?.deadheadKm ?? null })
    } else if (e.type === 'offer.rejected') {
      const load = loads.get(e.loadId)
      if (load) Object.assign(load, { status: 'open', offeredTo: null, truckId: null })
    } else if (e.type === 'assignment.committed') {
      const load = loads.get(e.loadId) || [...loads.values()].find((l) => l.shipmentId === e.shipmentId)
      if (load) Object.assign(load, { status: 'assigned', offeredTo: e.driverId, truckId: e.truckId, assignmentId: e.assignmentId })
    } else if (e.type === 'shipment.cancelled') {
      const load = loads.get(e.loadId) || [...loads.values()].find((l) => l.shipmentId === e.shipmentId)
      if (load) load.status = 'cancelled'
    } else if (e.type === 'shipment.changed' && e.change === 'held') {
      const load = loads.get(e.loadId)
      if (load) Object.assign(load, { status: 'held', holdReason: e.reason })
    } else if (e.type === 'assignment.unassigned' && e.newDriverId) {
      const load = loads.get(e.loadId)
      if (load) Object.assign(load, { status: 'assigned', offeredTo: e.newDriverId, truckId: e.newTruckId })
    }

    if (e.type === 'exception.opened') {
      const id = e.exceptionId || e.providerId || `EX-${e.seq}`
      exceptions.set(id, { ...e, id, state: 'open' })
    } else if (['exception.acknowledged', 'exception.assigned', 'exception.resolved'].includes(e.type)) {
      const item = exceptions.get(e.exceptionId)
      if (item) Object.assign(item, {
        state: e.type.split('.')[1], owner: e.owner || item.owner,
        resolution: e.resolution || item.resolution,
      })
    }
  }

  const loadList = [...loads.values()].sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))
  // Aggregate committed deadhead across offered/assigned loads — the empty km
  // the fleet is currently committed to driving to pickup. Feeds the
  // avoidableEmptyKm pilot metric from real data instead of a hand-entered
  // number (plan §6).
  const committedDeadheadKm = loadList
    .filter((l) => l.status === 'offered' || l.status === 'assigned')
    .reduce((sum, l) => sum + (Number(l.deadheadKm) || 0), 0)
  return {
    loads: loadList,
    exceptions: [...exceptions.values()].filter((e) => e.state !== 'resolved'),
    emptyKm: { committedDeadheadKm },
  }
}
