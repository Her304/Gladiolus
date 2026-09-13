/** Authoritative operational command processor. */
import { createLoad } from '../src/domain/loadboard.js'
import { gateMovement, gateAssignment } from '../src/domain/command.js'
import {
  EVENT, VERDICT, canTransition, DETENTION_TRANSITIONS, STOP_TRANSITIONS,
} from '../src/domain/contract.js'
import { axleWeightCompliance } from '../src/domain/weight.js'
import { SITE_BY_ID, BASE_SITE_CAPACITIES } from '../src/data/corridor.js'
import { haversine, deadheadKm } from '../src/engine/geo.js'

const H = 3600_000
const STAFF = new Set(['dispatch', 'admin'])
const DRIVER_EVENT_TYPES = new Set([
  'driver.action', 'inspection.recorded', 'truck.breakdown',
  'truck.breakdown.cleared', 'parking.claim', 'parking.release',
])

export function createCommandProcessor({ store, loadBoard }) {
  async function emit(type, at, payload) {
    return store.append({ type, observedAt: at, receivedAt: Date.now(), ...payload })
  }

  async function handle(cmd, session) {
    if (!session) return { ok: false, error: 'unauthorized' }
    if (!cmd?.type) return { ok: false, error: 'command type is required' }
    const now = Number.isFinite(cmd.now) ? cmd.now : Date.now()

    switch (cmd.type) {
      case 'postLoad': {
        if (!STAFF.has(session.role) && session.role !== 'integration') return forbidden('only staff or integrations may post loads')
        if (!cmd.load?.id || !cmd.load?.shipmentId || !cmd.load?.originId || !cmd.load?.destinationId) {
          return { ok: false, error: 'load id, shipment, origin, and destination are required' }
        }
        const load = createLoad({ ...cmd.load, readyAt: cmd.load.readyAt || now })
        loadBoard.postLoad(load, session.email || session.role)
        await emit(EVENT.SHIPMENT_POSTED, now, {
          providerId: `post-${load.id}`,
          shipmentId: load.shipmentId,
          loadId: load.id,
          kind: cmd.load.kind || 'ftl',
          stops: [load.originId, load.destinationId],
          originId: load.originId,
          destinationId: load.destinationId,
          readyAt: load.readyAt,
          appointment: load.appointment,
          serviceTimeMs: load.serviceTimeMs,
          expiresAt: load.expiresAt,
          revenue: load.revenue,
          equipment: load.equipment,
          payloadKg: load.payloadKg,
        })
        return { ok: true, load }
      }

      case 'offerLoad': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may offer a load')
        const load = loadBoard._loads.get(cmd.loadId)
        if (!load) return { ok: false, error: 'unknown load' }
        if (!cmd.driverId || !cmd.truckId) return { ok: false, error: 'driverId and truckId are required' }
        const decision = await candidateDecision(store, load, cmd.driverId, cmd.truckId, now)
        if (decision.verdict !== VERDICT.FEASIBLE) {
          await emit(EVENT.EXCEPTION_OPENED, now, {
            providerId: `no-feasible-${load.id}-${cmd.truckId}-${now}`,
            shipmentId: load.shipmentId,
            loadId: load.id,
            affectedTruck: cmd.truckId,
            severity: decision.verdict === VERDICT.UNRESOLVED ? 'warn' : 'critical',
            reason: 'assignment blocked',
            blockers: decision.blockers,
            owner: session.email,
            deadline: now + 30 * 60_000,
          })
          return { ok: false, error: 'candidate is not feasible', ...decision }
        }
        const r = loadBoard.offerLoad(cmd.loadId, cmd.driverId, session.email, now)
        if (r.ok && r.event) {
          await emit(r.event.type, now, {
            ...r.event, loadId: cmd.loadId, truckId: cmd.truckId,
            shipmentId: load.shipmentId, feasibility: decision,
            deadheadKm: decision.deadheadKm,
            originId: load.originId, destinationId: load.destinationId,
            payloadKg: load.payloadKg, revenue: load.revenue,
            equipment: load.equipment, readyAt: load.readyAt,
            providerId: `offer-${cmd.loadId}-${cmd.driverId}`,
          })
        }
        return { ...r, feasibility: decision }
      }

      case 'recommendTrucks': {
        // Pure read: given a load, return every truck with recent telemetry,
        // feasibility-checked and ranked by deadhead asc (nearest feasible
        // first). Emits nothing, reserves nothing — it informs the dispatcher's
        // manual offerLoad, never replaces it (plan: recommend-only).
        if (!STAFF.has(session.role)) return forbidden('only dispatch may request recommendations')
        const load = loadBoard._loads.get(cmd.loadId)
        if (!load) return { ok: false, error: 'unknown load' }
        const events = await store.all()
        // Latest ping per truck (keyed by truckId).
        const latestByTruck = new Map()
        for (const e of events) {
          if (e.type !== EVENT.TRUCK_PING || !e.truckId) continue
          const cur = latestByTruck.get(e.truckId)
          if (!cur || (e.seq ?? e.at) > (cur.seq ?? cur.at)) latestByTruck.set(e.truckId, e)
        }
        const recommendations = []
        for (const ping of latestByTruck.values()) {
          const truck = ping.truck
          if (!truck) continue
          const driverId = truck.driverId
          const decision = await candidateDecision(store, load, driverId, ping.truckId, now)
          recommendations.push({
            truckId: ping.truckId, driverId, name: truck.driverName || truck.id,
            deadheadKm: decision.deadheadKm, verdict: decision.verdict, blockers: decision.blockers,
          })
        }
        // Feasible first, ordered by deadhead asc (unknown deadhead after known);
        // then infeasible/unresolved, also by deadhead asc for visibility.
        const rank = (r) => (r.verdict === VERDICT.FEASIBLE ? 0 : 1)
        recommendations.sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b)
          if (a.deadheadKm == null && b.deadheadKm == null) return 0
          if (a.deadheadKm == null) return 1
          if (b.deadheadKm == null) return -1
          return a.deadheadKm - b.deadheadKm
        })
        return { ok: true, loadId: load.id, recommendations: recommendations.slice(0, 12) }
      }

      case 'acceptOffer': {
        if (session.role !== 'driver') return forbidden('only the offered driver may accept a load')
        const driverId = session.driverId
        const truckId = session.truckId
        if (!driverId || !truckId || (cmd.driverId && cmd.driverId !== driverId) || (cmd.truckId && cmd.truckId !== truckId)) {
          return forbidden('driver may accept only their own offer')
        }
        const load = loadBoard._loads.get(cmd.loadId)
        if (!load || load.offeredTo !== driverId) return forbidden('this load is not offered to this driver')
        const decision = await candidateDecision(store, load, driverId, truckId, now)
        if (decision.verdict !== VERDICT.FEASIBLE) return { ok: false, error: 'offer is no longer feasible', ...decision }
        const key = cmd.idempotencyKey || `accept-${cmd.loadId}-${driverId}`
        const r = loadBoard.acceptOffer(cmd.loadId, driverId, truckId, key, now)
        if (r.ok && r.events) {
          for (const e of r.events) {
            await emit(e.type, now, {
              ...e, loadId: cmd.loadId,
              providerId: `${key}-${e.type}`,
              idempotencyKey: `${key}-${e.type}`,
            })
          }
        }
        return r
      }

      case 'rejectOffer': {
        if (session.role !== 'driver') return forbidden('only the offered driver may reject a load')
        const load = loadBoard._loads.get(cmd.loadId)
        if (!load || load.offeredTo !== session.driverId) return forbidden('this load is not offered to this driver')
        const r = loadBoard.rejectOffer(cmd.loadId, session.driverId, cmd.reason)
        if (r.ok && r.event) {
          await emit(r.event.type, now, {
            ...r.event, shipmentId: load.shipmentId,
            providerId: `reject-${cmd.loadId}-${session.driverId}`,
          })
        }
        return r
      }

      case 'reassign': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may reassign a load')
        const load = loadBoard._loads.get(cmd.loadId)
        if (!load) return { ok: false, error: 'unknown load' }
        if (!cmd.newDriverId || !cmd.newTruckId) return { ok: false, error: 'newDriverId and newTruckId are required' }
        const decision = await candidateDecision(store, load, cmd.newDriverId, cmd.newTruckId, now)
        if (decision.verdict !== VERDICT.FEASIBLE) {
          return { ok: false, error: 'replacement candidate is not feasible', ...decision }
        }
        const previousDriverId = load.acceptedBy
        const previousTruckId = load.acceptedTruckId
        const r = loadBoard.reassign(cmd.loadId, cmd.newDriverId, cmd.newTruckId, session.email, cmd.reason)
        if (r.ok && r.event) {
          await emit(r.event.type, now, {
            ...r.event, loadId: cmd.loadId, shipmentId: load.shipmentId,
            driverId: previousDriverId, truckId: previousTruckId,
            newDriverId: cmd.newDriverId, newTruckId: cmd.newTruckId,
            actor: session.email, providerId: `reassign-out-${cmd.loadId}-${now}`,
          })
          await emit(EVENT.ASSIGNMENT_COMMITTED, now, {
            loadId: cmd.loadId, shipmentId: load.shipmentId,
            driverId: cmd.newDriverId, truckId: cmd.newTruckId,
            assignmentId: loadBoard._assignments.get(load.shipmentId)?.id,
            actor: session.email, providerId: `reassign-in-${cmd.loadId}-${now}`,
          })
        }
        return { ...r, feasibility: decision }
      }

      case 'cancel': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may cancel a load')
        const load = loadBoard._loads.get(cmd.loadId)
        const r = loadBoard.cancel(cmd.loadId, session.email, cmd.reason)
        if (r.ok && r.event) await emit(r.event.type, now, {
          ...r.event, loadId: cmd.loadId, shipmentId: load?.shipmentId,
          actor: session.email, providerId: `cancel-${cmd.loadId}`,
        })
        return r
      }

      case 'hold': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may hold a load')
        const load = loadBoard._loads.get(cmd.loadId)
        const r = loadBoard.hold(cmd.loadId, session.email, cmd.reason)
        if (r.ok) await emit(EVENT.SHIPMENT_CHANGED, now, {
          providerId: `hold-${cmd.loadId}-${now}`, shipmentId: load?.shipmentId,
          loadId: cmd.loadId, change: 'held', reason: cmd.reason, actor: session.email,
        })
        return r
      }

      case 'gateMovement': {
        if (!STAFF.has(session.role) && session.role !== 'driver') return forbidden('movement gate is operational')
        if (session.role === 'driver' && cmd.truck?.id !== session.truckId) return forbidden('driver may gate only their truck')
        const r = gateMovement({
          truck: cmd.truck, vehicle: cmd.vehicle, route: cmd.route,
          duty: cmd.duty, assignmentId: cmd.assignmentId, now,
        })
        if (r.ok === false && r.events) {
          for (const [index, e] of r.events.entries()) await emit(e.type, e.observedAt || now, {
            ...e, providerId: `gate-${cmd.truck?.id}-${now}-${index}`,
          })
        }
        return r
      }

      case 'gateAssignment': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may evaluate assignments')
        return gateAssignment({
          duty: cmd.duty, vehicle: cmd.vehicle, route: cmd.route,
          equipment: cmd.equipment, weight: cmd.weight, assignment: cmd.assignment, now,
        })
      }

      case 'setSiteCapacity': {
        if (session.role !== 'admin') return forbidden('only administrators may change site capacity')
        const site = SITE_BY_ID[cmd.siteId]
        const spaces = Math.round(Number(cmd.spaces))
        if (!site || site.kind !== 'parking') return { ok: false, error: 'unknown parking site' }
        if (!Number.isFinite(spaces) || spaces < 1 || spaces > 400) {
          return { ok: false, error: 'capacity must be a whole number from 1 to 400' }
        }
        const previous = site.spaces
        await emit(EVENT.CONFIG_CHANGED, now, {
          configKey: 'site.capacity', siteId: site.id, value: spaces,
          previous, actor: session.email,
          providerId: cmd.idempotencyKey || `site-capacity-${site.id}-${now}`,
        })
        site.spaces = spaces
        await emit(EVENT.ADMIN_ACTION, now, {
          actor: session.email, action: 'changed site capacity',
          detail: `${site.name}: ${previous} → ${spaces} spaces`,
          providerId: `audit-site-capacity-${site.id}-${now}`,
        })
        return { ok: true, siteId: site.id, spaces }
      }

      case 'resetSiteCapacities': {
        if (session.role !== 'admin') return forbidden('only administrators may reset site capacity')
        await emit(EVENT.CONFIG_CHANGED, now, {
          configKey: 'site.capacities.reset', capacities: BASE_SITE_CAPACITIES,
          actor: session.email,
          providerId: cmd.idempotencyKey || `site-capacities-reset-${now}`,
        })
        for (const [siteId, spaces] of Object.entries(BASE_SITE_CAPACITIES)) SITE_BY_ID[siteId].spaces = spaces
        await emit(EVENT.ADMIN_ACTION, now, {
          actor: session.email, action: 'reset site capacities',
          detail: 'restored all seeded parking capacities',
          providerId: `audit-site-capacities-reset-${now}`,
        })
        return { ok: true, capacities: BASE_SITE_CAPACITIES }
      }

      case 'adminAction': {
        if (session.role !== 'admin') return forbidden('only administrators may write the admin audit trail')
        if (!String(cmd.action || '').trim()) return { ok: false, error: 'action is required' }
        await emit(EVENT.ADMIN_ACTION, now, {
          actor: session.email, action: String(cmd.action).trim(), detail: cmd.detail ?? null,
          providerId: cmd.idempotencyKey || `admin-action-${now}-${String(cmd.action).slice(0, 20)}`,
        })
        return { ok: true }
      }

      case 'recordDriverEvent': {
        if (session.role !== 'driver') return forbidden('only drivers may record driver events')
        if (!DRIVER_EVENT_TYPES.has(cmd.eventType)) return { ok: false, error: 'unsupported driver event' }
        const payload = { ...(cmd.payload || {}) }
        if (payload.truckId && payload.truckId !== session.truckId) return forbidden('driver may write only their truck')
        await emit(cmd.eventType, now, {
          ...payload, truckId: session.truckId, driverId: session.driverId,
          actor: session.email,
          providerId: cmd.idempotencyKey || `driver-${session.driverId}-${cmd.eventType}-${now}`,
        })
        if ((cmd.eventType === 'inspection.recorded' && payload.major) || cmd.eventType === 'truck.breakdown') {
          await emit(EVENT.VEHICLE_BLOCKED, now, {
            truckId: session.truckId,
            reason: cmd.eventType === 'truck.breakdown' ? 'vehicle.breakdown' : 'vehicle.defect',
            providerId: `vehicle-blocked-${session.truckId}-${now}`,
          })
        }
        if (cmd.eventType === 'truck.breakdown.cleared') {
          await emit(EVENT.VEHICLE_CLEARED, now, {
            truckId: session.truckId, providerId: `vehicle-cleared-${session.truckId}-${now}`,
          })
        }
        return { ok: true }
      }

      case 'replyDriver': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may reply to drivers')
        if (!String(cmd.message || '').trim()) return { ok: false, error: 'message is required' }
        await emit('driver.action', now, {
          truckId: cmd.truckId, action: 'dispatch.replied', message: String(cmd.message).trim(),
          replyTo: cmd.replyTo, actor: session.email,
          providerId: cmd.idempotencyKey || `reply-${cmd.truckId}-${cmd.replyTo}-${now}`,
        })
        return { ok: true }
      }

      case 'checkInStop':
      case 'startService':
      case 'completeService':
      case 'departStop': {
        if (session.role !== 'driver') return forbidden('only the assigned driver may update a stop')
        const load = [...loadBoard._loads.values()].find((l) => l.shipmentId === cmd.shipmentId)
        if (!load || load.acceptedBy !== session.driverId || load.acceptedTruckId !== session.truckId) {
          return forbidden('driver is not assigned to this shipment')
        }
        const eventType = {
          checkInStop: EVENT.STOP_CHECKED_IN,
          startService: EVENT.STOP_SERVICE_STARTED,
          completeService: EVENT.STOP_SERVICE_COMPLETED,
          departStop: EVENT.STOP_DEPARTED,
        }[cmd.type]
        const target = {
          [EVENT.STOP_CHECKED_IN]: 'checked_in', [EVENT.STOP_SERVICE_STARTED]: 'service_started',
          [EVENT.STOP_SERVICE_COMPLETED]: 'service_completed', [EVENT.STOP_DEPARTED]: 'departed',
        }[eventType]
        const state = currentStopState(await store.all(), cmd.shipmentId, cmd.stopId)
        if (!canTransition(STOP_TRANSITIONS, state, target)) return { ok: false, error: `cannot ${target} from ${state}` }
        await emit(eventType, now, {
          shipmentId: cmd.shipmentId, stopId: cmd.stopId, truckId: session.truckId,
          actor: session.email, source: 'driver-confirmed',
          providerId: cmd.idempotencyKey || `${eventType}-${cmd.shipmentId}-${cmd.stopId}-${now}`,
        })
        return { ok: true, milestone: target }
      }

      case 'reviewDetention':
      case 'waiveDetention':
      case 'exportDetention': {
        if (!STAFF.has(session.role)) return forbidden('only staff may change detention claims')
        if (cmd.type === 'exportDetention' && session.role !== 'admin') return forbidden('billing export requires admin')
        const target = { reviewDetention: 'reviewed', waiveDetention: 'waived', exportDetention: 'exported' }[cmd.type]
        const currentState = currentClaimState(await store.all(), cmd.claimId)
        if (!canTransition(DETENTION_TRANSITIONS, currentState, target)) {
          return { ok: false, error: `cannot ${cmd.type} from ${currentState || 'missing claim'}` }
        }
        const eventType = {
          reviewDetention: EVENT.DETENTION_REVIEWED,
          waiveDetention: EVENT.DETENTION_WAIVED,
          exportDetention: EVENT.DETENTION_EXPORTED,
        }[cmd.type]
        await emit(eventType, now, {
          claimId: cmd.claimId, shipmentId: cmd.shipmentId, stopId: cmd.stopId,
          actor: session.email, reason: cmd.reason,
          providerId: `${cmd.type}-${cmd.claimId}`,
        })
        return { ok: true, state: target }
      }

      case 'acknowledgeException':
      case 'assignException':
      case 'resolveException': {
        if (!STAFF.has(session.role)) return forbidden('only dispatch may own exceptions')
        const eventType = {
          acknowledgeException: EVENT.EXCEPTION_ACKNOWLEDGED,
          assignException: EVENT.EXCEPTION_ASSIGNED,
          resolveException: EVENT.EXCEPTION_RESOLVED,
        }[cmd.type]
        await emit(eventType, now, {
          exceptionId: cmd.exceptionId, owner: cmd.owner || session.email,
          resolution: cmd.resolution, actor: session.email,
          providerId: `${cmd.type}-${cmd.exceptionId}-${now}`,
        })
        return { ok: true }
      }

      default:
        return { ok: false, error: `unknown command: ${cmd.type}` }
    }
  }

  return { handle }
}

/** Rebuild the in-memory working board from its durable event history. */
export async function replayLoadBoard(loadBoard, events) {
  for (const e of events || []) {
    if (e.type === EVENT.SHIPMENT_POSTED) {
      const stops = e.stops || []
      const id = e.loadId || e.load?.id
      const originId = e.originId || stops[0]
      const destinationId = e.destinationId || stops.at(-1)
      if (!id || !e.shipmentId || !originId || !destinationId || loadBoard._loads.has(id)) continue
      loadBoard.postLoad(createLoad({
        id, shipmentId: e.shipmentId, originId, destinationId,
        readyAt: e.readyAt || e.observedAt || e.at,
        appointment: e.appointment, serviceTimeMs: e.serviceTimeMs,
        expiresAt: e.expiresAt, revenue: e.revenue,
        equipment: e.equipment, payloadKg: e.payloadKg,
      }), 'replay')
    } else if (e.type === EVENT.OFFER_CREATED) {
      const load = loadBoard._loads.get(e.loadId)
      if (load?.status === 'open') loadBoard.offerLoad(e.loadId, e.driverId, 'replay', e.observedAt || e.at)
    } else if (e.type === EVENT.ASSIGNMENT_COMMITTED) {
      const load = [...loadBoard._loads.values()].find((l) => l.shipmentId === e.shipmentId)
      if (load?.status === 'offered') loadBoard.acceptOffer(load.id, e.driverId, e.truckId, e.idempotencyKey || `replay-${e.seq}`, e.observedAt || e.at)
    } else if (e.type === EVENT.OFFER_REJECTED) {
      const load = loadBoard._loads.get(e.loadId)
      if (load) loadBoard.rejectOffer(e.loadId, e.driverId, e.reason)
    } else if (e.type === EVENT.SHIPMENT_CANCELLED) {
      const load = loadBoard._loads.get(e.loadId) || [...loadBoard._loads.values()].find((l) => l.shipmentId === e.shipmentId)
      if (load) loadBoard.cancel(load.id, e.actor || 'replay', e.reason)
    } else if (e.type === EVENT.SHIPMENT_CHANGED && e.change === 'held') {
      if (loadBoard._loads.has(e.loadId)) loadBoard.hold(e.loadId, e.actor || 'replay', e.reason)
    } else if (e.type === EVENT.ASSIGNMENT_UNASSIGNED && e.newDriverId) {
      if (loadBoard._loads.has(e.loadId)) loadBoard.reassign(e.loadId, e.newDriverId, e.newTruckId, e.actor || 'replay', e.reason || 'replayed')
    }
  }
  return loadBoard
}

/** Apply durable configuration events to the engine objects read at runtime. */
export function replayConfiguration(events, { reset = false } = {}) {
  if (reset) {
    for (const [siteId, spaces] of Object.entries(BASE_SITE_CAPACITIES)) SITE_BY_ID[siteId].spaces = spaces
  }
  for (const e of events || []) {
    if (e.type !== EVENT.CONFIG_CHANGED) continue
    if (e.configKey === 'site.capacity' && SITE_BY_ID[e.siteId]?.kind === 'parking' && Number.isFinite(e.value)) {
      SITE_BY_ID[e.siteId].spaces = e.value
    } else if (e.configKey === 'site.capacities.reset') {
      for (const [siteId, spaces] of Object.entries(e.capacities || BASE_SITE_CAPACITIES)) {
        if (SITE_BY_ID[siteId]?.kind === 'parking' && Number.isFinite(spaces)) SITE_BY_ID[siteId].spaces = spaces
      }
    }
  }
}

async function candidateDecision(store, load, driverId, truckId, now) {
  const events = await store.all()
  const ping = events.findLast((e) => e.type === EVENT.TRUCK_PING && e.truckId === truckId)
  const dutyEvent = events.findLast((e) => e.type === EVENT.DUTY_UPDATED && (e.driverId === driverId || e.truckId === truckId))
  const truck = ping?.truck
  const duty = dutyEvent ? { ...dutyEvent, observedAt: dutyEvent.observedAt ?? dutyEvent.at } : truck ? {
    drivingMs: truck.drivingMs, onDutyMs: truck.onDutyMs, elapsedMs: truck.elapsedMs,
    cycleMs: truck.cycleMs, dailyOffDutyMs: truck.dailyOffDutyMs,
    regime: truck.regime || 'cycle1', observedAt: ping.observedAt ?? ping.at,
  } : null
  const lastBlocked = events.findLast((e) => (e.type === EVENT.VEHICLE_BLOCKED || e.type === EVENT.VEHICLE_CLEARED) && e.truckId === truckId)
  const vehicle = truck ? { available: lastBlocked?.type !== EVENT.VEHICLE_BLOCKED, reason: lastBlocked?.reason } : null
  const required = load.equipment || []
  const supplied = truck?.equipment || []
  const equipment = { required: required.length > 0, satisfied: required.every((x) => supplied.includes(x)) }
  const weight = axleWeightCompliance({
    payloadKg: load.payloadKg,
    vehicle: { tareKg: truck?.tareKg, grossLimitKg: truck?.grossLimitKg, axleLimitsKg: truck?.axleLimitsKg },
    measuredAxlesKg: truck?.axleWeightsKg,
  })
  const origin = SITE_BY_ID[load.originId]
  const destination = SITE_BY_ID[load.destinationId]
  // Deadhead: the empty drive from the truck's current position to the load
  // origin. It is added to the driving budget so HOS feasibility accounts for
  // the pickup leg, not just the laden leg (plan: budget deadhead against HOS).
  const deadhead = deadheadKm(truck, origin)
  const deadheadMs = Number.isFinite(deadhead) ? deadhead / 70 * H : 0
  const distanceKm = origin && destination ? haversine(origin.coord, destination.coord) * 1.2 : null
  const travelMs = (Number.isFinite(distanceKm) ? distanceKm / 70 * H : 0) + deadheadMs
  const assignment = {
    drivingMs: travelMs,
    onDutyMs: travelMs + (load.serviceTimeMs || 0),
    elapsedMs: travelMs + (load.serviceTimeMs || 0),
  }
  const decision = gateAssignment({
    duty, vehicle,
    route: { edges: [], known: Boolean(origin && destination) },
    equipment, weight, assignment, now,
  })
  return { ...decision, deadheadKm: deadhead ?? null }
}

function currentStopState(events, shipmentId, stopId) {
  const map = {
    [EVENT.STOP_ARRIVED]: 'arrived', [EVENT.STOP_CHECKED_IN]: 'checked_in',
    [EVENT.STOP_SERVICE_STARTED]: 'service_started', [EVENT.STOP_SERVICE_COMPLETED]: 'service_completed',
    [EVENT.STOP_DEPARTED]: 'departed',
  }
  return events.filter((e) => e.shipmentId === shipmentId && e.stopId === stopId && map[e.type])
    .reduce((state, e) => map[e.type] || state, 'none')
}

function currentClaimState(events, claimId) {
  const states = {
    [EVENT.DETENTION_ELIGIBLE]: 'eligible', [EVENT.DETENTION_CALCULATED]: 'calculated',
    [EVENT.DETENTION_REVIEWED]: 'reviewed', [EVENT.DETENTION_ADJUSTED]: 'adjusted',
    [EVENT.DETENTION_WAIVED]: 'waived', [EVENT.DETENTION_EXPORTED]: 'exported',
    [EVENT.DETENTION_RECONCILED]: 'reconciled',
  }
  return events.filter((e) => e.claimId === claimId && states[e.type]).reduce((_, e) => states[e.type], null)
}

function forbidden(error) {
  return { ok: false, forbidden: true, error }
}
