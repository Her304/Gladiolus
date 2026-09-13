import {
  CORRIDOR, SITE_BY_ID, STOP_SITES, PARKING_SITES, MIN_FENCE_M,
} from '../data/corridor.js'
import { positionAt, headingAt } from './geo.js'
import { transition } from './geofence.js'
import { EVENT } from './events.js'
import { APPROACH_KM, DWELL_THRESHOLD_MIN } from '../contract.js'
import { clockLeftMs, RESET_MS } from './hos.js'
import { recommendParking, pressureFor } from './parking.js'
import { seedFleet, mulberry32 } from '../data/seed.js'
import { speedFactorAt, closureEdges } from '../services/on511.js'
import { flowFactorAt } from '../services/tomtom.js'
import { haversine, deadheadKm } from './geo.js'
import { NODES, shortestPath } from '../data/regional-graph.js'
// v2 domain layer — the simulator now routes its flagged transitions through
// the authoritative semantics (arrival ≠ delivery, pre-movement HOS guard,
// load queue instead of random self-assignment, contract-driven detention).
import { EVENT as V2_EVENT, DEFAULT_DETENTION_RULE, VERDICT } from '../domain/contract.js'
import { gateMovement, rankCandidates } from '../domain/command.js'
import { calculateDetention, foldVisit } from '../domain/detention.js'
import { createLoadBoard, createLoad } from '../domain/loadboard.js'
import { boundedReach } from '../domain/feasibility.js'

/** Sim time between telemetry pings per truck. 40 trucks pinging every tick is
 *  unusable; once every 90 sim seconds keeps the log a manageable size. */
const PING_INTERVAL_MS = 90_000

/** How much clock is left when a driver starts looking for a space. */
const CLAIM_THRESHOLD_MS = 75 * 60_000

/**
 * A truck must never advance further than a fraction of the smallest geofence
 * radius in one movement step, or it teleports straight through the fence and
 * the enter/exit pair is never observed. At 30x with 500 ms ticks a truck
 * covers ~420 m per tick against a 260 m radius, so movement is sub-stepped.
 */
const MAX_SUBSTEP_KM = MIN_FENCE_M / 2600

/**
 * The physical model. Trucks exist here and move under their own rules; the
 * event log records what we can *observe* about them. Keeping those two apart
 * is the point — it is why the log stays an honest telemetry record rather than
 * a mirror of application state.
 */
export function createSimulator(store, { startHour = 14 } = {}) {
  const rnd = mulberry32(915234)
  const { trucks: seeded } = seedFleet()
  const trucks = new Map(seeded.map((t) => [t.id, { ...t }]))

  const start = new Date()
  start.setHours(startHour, 0, 0, 0)

  let clock = start.getTime()
  let incidents = []
  let flow = []
  let speedMultiplier = 30 // sim seconds per real second

  // A shared open-load queue. Trucks no longer invent freight or self-assign
  // after a dwell (assessment §8: "Load generation is not load matching"); they
  // draw from this queue, which carries origin, destination, revenue, and
  // equipment so feasibility can be checked before an offer is accepted.
  //
  // Backhaul pairing (the brief's financial premise): a delivery load is posted
  // together with a return load whose origin is the delivery's destination —
  // Milton→London pairs with London→Kitchener. The return is ready when the
  // truck arrives. This is what reduces deadhead, not random load invention.
  const loadBoard = createLoadBoard()
  let loadCounter = 9000

  // Map corridor site ids → regional-graph node ids (by coordinate proximity).
  // The two use different id namespaces; this bridge lets loads carry graph
  // destinations so shortestPath can route them.
  const SITE_TO_NODE = new Map()
  for (const s of STOP_SITES) {
    let best = null, bestD = Infinity
    for (const n of NODES) {
      const d = haversine(s.coord, n.coord)
      if (d < bestD) { bestD = d; best = n }
    }
    SITE_TO_NODE.set(s.id, best.id)
  }
  // Reverse: graph node id → nearest corridor site id.
  const NODE_TO_SITE = new Map()
  for (const [siteId, nodeId] of SITE_TO_NODE) {
    if (!NODE_TO_SITE.has(nodeId) || haversine(SITE_BY_ID[siteId].coord, NODES.find(n => n.id === nodeId).coord) < haversine(SITE_BY_ID[NODE_TO_SITE.get(nodeId)].coord, NODES.find(n => n.id === nodeId).coord)) {
      NODE_TO_SITE.set(nodeId, siteId)
    }
  }

  /**
   * Find a return destination for a delivery — a graph neighbor of the
   * delivery's destination node, mapped back to a corridor site. This is the
   * backhaul: the truck delivers to London, then picks up London→Kitchener.
   */
  function returnDestinationFor(deliveryDestSiteId) {
    const destNode = SITE_TO_NODE.get(deliveryDestSiteId)
    if (!destNode) return null
    // Pick a graph destination reachable from destNode (not destNode itself).
    const candidates = ['kitchener', 'barrie', 'niagara-falls', 'peterborough', 'pickering', 'milton', 'cambridge', 'mississauga', 'scarborough', 'windsor']
      .filter((id) => id !== destNode)
      .map((id) => ({ id, path: shortestPath(destNode, id) }))
      .filter((c) => c.path && c.path.km > 0 && c.path.km < 200)
    if (!candidates.length) return null
    const pick = candidates[Math.floor(rnd() * candidates.length)]
    return { siteId: NODE_TO_SITE.get(pick.id) || pick.id, nodeId: pick.id, km: pick.path.km }
  }

  /**
   * Feasibility check for a load candidate: can this truck reach the load's
   * destination on its remaining HOS? Uses the graph distance (shortestPath)
   * and boundedReach (no 40km/h floor). Returns a gateAssignment-shaped result
   * so rankCandidates can filter and rank.
   *
   * The deadhead leg (truck's current position → load origin) is added to the
   * driving distance the truck must cover, so HOS reach has to cover the empty
   * drive to pickup plus the laden leg — not just the laden leg (plan: budget
   * deadhead against HOS).
   */
  function feasibilityForLoad(load, t) {
    const destNode = SITE_TO_NODE.get(load.destinationId)
    const truckNode = SITE_TO_NODE.get(SITE_BY_ID[t.destinationId]?.id || t.insideSiteId) || SITE_TO_NODE.get(SITE_BY_ID[t.destinationId]?.id)
    const route = (destNode && truckNode) ? shortestPath(truckNode, destNode) : null
    const deadhead = deadheadKm(t, SITE_BY_ID[load.originId]) ?? 0
    const distanceKm = (route?.km || Math.abs((SITE_BY_ID[load.destinationId]?.chainage || 0) - t.chainage)) + deadhead
    const duty = { drivingMs: t.drivingMs, onDutyMs: t.onDutyMs, elapsedMs: t.elapsedMs, cycleMs: t.cycleMs, dailyOffDutyMs: t.dailyOffDutyMs, regime: t.regime, observedAt: clock, source: 'simulated' }
    const reach = boundedReach(duty, t.speedKph || 90)
    const feasible = reach && reach.km >= distanceKm
    return {
      ok: feasible,
      verdict: feasible ? VERDICT.FEASIBLE : VERDICT.INFEASIBLE,
      blockers: feasible ? [] : ['hos.driving'],
      inputs: ['hos', 'route'],
    }
  }

  /**
   * Post a delivery load AND its paired return load. The return's origin is the
   * delivery's destination; its readyAt is the delivery's ETA. This is the
   * backhaul pairing that makes the deadhead-reduction premise real.
   */
  function postPairedLoads(originSiteId, destSiteId, revenue) {
    const deliveryId = `L-${loadCounter++}`
    const eta = clock + 3 * 3600_000 // rough: ready when the truck arrives
    loadBoard.postLoad(createLoad({
      id: deliveryId, shipmentId: `SHP-${deliveryId}`, originId: originSiteId, destinationId: destSiteId,
      readyAt: clock, expiresAt: clock + 6 * 3600_000, revenue,
    }))
    // Post the return load (backhaul): dest → a graph neighbor of dest.
    const ret = returnDestinationFor(destSiteId)
    if (ret) {
      const returnId = `L-${loadCounter++}`
      loadBoard.postLoad(createLoad({
        id: returnId, shipmentId: `SHP-${returnId}`, originId: destSiteId, destinationId: ret.siteId,
        readyAt: eta, expiresAt: eta + 6 * 3600_000, revenue: 700 + Math.floor(rnd() * 500),
      }))
    }
    return deliveryId
  }
  // Seed the queue with paired loads along the corridor.
  const seedPairs = [['milton-intermodal', 'london-dc'], ['cambridge-dc', 'london-dc'], ['london-dc', 'milton-intermodal'], ['mississauga-dc', 'cambridge-dc']]
  for (const [orig, dest] of seedPairs) postPairedLoads(orig, dest, 800 + Math.floor(rnd() * 600))

  /**
   * The site this truck is currently heading off the highway for, if any: the
   * one it is inside, else whichever of its claimed rest area and its delivery
   * destination is nearest.
   */
  function intendedSite(t) {
    if (t.insideSiteId) return SITE_BY_ID[t.insideSiteId] ?? null
    let best = null
    for (const id of [t.claimedSiteId, t.destinationId]) {
      const site = id ? SITE_BY_ID[id] : null
      if (!site) continue
      const gap = Math.abs(site.chainage - t.chainage)
      if (gap <= APPROACH_KM && (!best || gap < best.gap)) best = { site, gap }
    }
    return best?.site ?? null
  }

  /**
   * Position on the map. A truck runs the corridor polyline, but sites sit a
   * few hundred metres off it, so as it closes on a site it intends to visit
   * its position blends off the mainline toward that site — the off-ramp. At
   * the site's own chainage the truck is exactly on the site, which is what
   * puts it inside the geofence. Without this, every fence is unreachable and
   * none of them ever fire.
   */
  function pos(t) {
    const base = positionAt(CORRIDOR, t.chainage)
    const site = intendedSite(t)
    if (!site) return base
    const w = 1 - Math.min(1, Math.abs(site.chainage - t.chainage) / APPROACH_KM)
    if (w <= 0) return base
    return [
      base[0] + (site.coord[0] - base[0]) * w,
      base[1] + (site.coord[1] - base[1]) * w,
    ]
  }

  function observable(t) {
    return {
      id: t.id,
      plate: t.plate,
      driverId: t.driverId,
      driverName: t.driverName,
      coord: pos(t),
      heading: headingAt(CORRIDOR, t.chainage),
      chainage: t.chainage,
      direction: t.direction,
      speedKph: Math.round(t.speedKph),
      odometerKm: t.odometerKm,
      laden: t.laden,
      loadId: t.loadId,
      shipmentId: t.shipmentId ?? null,
      destinationId: t.destinationId,
      state: t.state,
      drivingMs: t.drivingMs,
      onDutyMs: t.onDutyMs,
      elapsedMs: t.elapsedMs,
      cycleMs: t.cycleMs,
      dailyOffDutyMs: t.dailyOffDutyMs,
      regime: t.regime,
      equipment: t.equipment,
      tareKg: t.tareKg,
      grossLimitKg: t.grossLimitKg,
      insideSiteId: t.insideSiteId,
      claimedSiteId: t.claimedSiteId,
      parked: t.state === 'resting',
      forcedStop: Boolean(t.forcedStop),
    }
  }

  function emitPing(t) {
    // The ping carries the active shipmentId at the top level so a customer's
    // shipment-scoped SSE stream can match it. When the truck is empty/
    // repositioning (no shipment), shipmentId is null — the customer's stream
    // goes quiet, so their marker holds its last position rather than
    // following the next load (assessment §8/C11).
    store.append(EVENT.PING, clock, { truckId: t.id, shipmentId: t.shipmentId ?? null, truck: observable(t) })
    t.lastPingAt = clock
  }

  /**
   * Pick a destination for an empty truck. Uses the regional graph: find the
   * nearest graph node to the truck's current position, route to a random
   * reachable destination, and map back to a corridor site. This replaces the
   * old 1D bounce (Windsor↔Scarborough) with graph-routed movement — a truck
   * at London might head to Kitchener, Barrie, or back to Milton.
   */
  function pickDestination(t) {
    // Find the nearest graph node to the truck's current corridor site.
    const truckSite = SITE_BY_ID[t.insideSiteId] || STOP_SITES.find((s) => Math.abs(s.chainage - t.chainage) < 30)
    const truckNode = truckSite ? SITE_TO_NODE.get(truckSite.id) : null
    if (truckNode) {
      // Route to a random graph destination reachable from here.
      const dests = ['kitchener', 'barrie', 'niagara-falls', 'peterborough', 'pickering', 'milton', 'cambridge', 'mississauga', 'scarborough', 'windsor', 'london']
        .filter((id) => id !== truckNode)
        .map((id) => ({ id, path: shortestPath(truckNode, id) }))
        .filter((c) => c.path && c.path.km > 0 && c.path.km < 250)
      if (dests.length) {
        const pick = dests[Math.floor(rnd() * dests.length)]
        const siteId = NODE_TO_SITE.get(pick.id)
        if (siteId) {
          // Set direction based on whether the destination is ahead or behind.
          const dest = SITE_BY_ID[siteId]
          if (dest) t.direction = dest.chainage >= t.chainage ? 1 : -1
          return siteId
        }
      }
    }
    // Fallback: the old 1D ahead-selection (keeps the sim moving if the graph
    // has no reachable destination from this position).
    const ahead = STOP_SITES.filter((s) => (s.chainage - t.chainage) * t.direction > 25)
    if (ahead.length) return ahead[Math.floor(rnd() * ahead.length)].id
    t.direction *= -1
    const back = STOP_SITES.filter((s) => (s.chainage - t.chainage) * t.direction > 25)
    return (back[Math.floor(rnd() * back.length)] || STOP_SITES[0]).id
  }

  function releaseClaim(t, reason) {
    if (!t.claimedSiteId) return
    store.append(EVENT.PARKING_RELEASE, clock, {
      truckId: t.id,
      siteId: t.claimedSiteId,
      siteName: SITE_BY_ID[t.claimedSiteId]?.name,
      reason,
    })
    t.claimedSiteId = null
  }

  function shouldRest(t, site) {
    // Out of clock: the truck stops here whatever the lot looks like.
    if (clockLeftMs(t) <= 0) return true
    if (t.claimedSiteId !== site.id) return false
    if (clockLeftMs(t) > CLAIM_THRESHOLD_MS) return false

    // The space we were counting on may be gone. Checking on arrival rather
    // than trusting the claim is what stops the whole fleet piling into one
    // rest area, and it is the real-world failure this app exists to catch.
    if (pressureFor(site, store.getWorld(), new Date(clock)).projectedFree > 0) {
      return true
    }
    releaseClaim(t, 'no space on arrival')
    return false
  }

  function handleFences(t) {
    const tr = transition(t.insideSiteId, pos(t))

    if (tr.kind === 'enter') {
      t.insideSiteId = tr.site.id
      t.enteredAt = clock
      // Did the truck mean to come here, or is it just passing close enough to
      // trip the fence? Only the former is worth a dispatcher's attention.
      const intended = tr.site.id === t.destinationId || tr.site.id === t.claimedSiteId
      store.append(EVENT.FENCE_ENTER, clock, {
        truckId: t.id, siteId: tr.site.id, siteName: tr.site.name, intended,
      })

      if (tr.site.kind === 'stop' && tr.site.id === t.destinationId) {
        t.state = 'dwelling'
        t.speedKph = 0
        // Dwell deliberately spans the detention boundary sometimes: one in three
        // visits exceeds the two-hour free time (the 150-min case), so the
        // detention ledger exercises a billable charge instead of always landing
        // under the threshold (assessment §5: the ordinary scenario never did).
        t.dwellLeftMs = rnd() < 0.33
          ? (125 + rnd() * 35) * 60_000 // 125–160 min: billable
          : (35 + rnd() * 80) * 60_000  // 35–115 min: within free time
        t.visitStart = clock
        if (t.laden) {
          // Arrival is NOT delivery (assessment §5: "The simulator conflates
          // arrival with delivery"). The load stays attached while service and
          // detention evidence accumulate. Delivery is the service-completion
          // milestone, emitted when the dwell expires — not at fence entry.
          t.stopId = `STP-${t.id}-${tr.site.id}`
          t.shipmentId = t.shipmentId || `SHP-${t.loadId}`
          store.append(V2_EVENT.SHIPMENT_POSTED, clock, {
            shipmentId: t.shipmentId, kind: 'ftl', stops: [t.lastOriginId || 'STP-pu', t.stopId],
          })
          store.append(V2_EVENT.STOP_ARRIVED, clock, {
            truckId: t.id, shipmentId: t.shipmentId, stopId: t.stopId,
            facilityId: tr.site.id, providerId: `sim-arr-${t.id}-${t.visitStart}`,
          })
          store.append(V2_EVENT.STOP_CHECKED_IN, clock + 5 * 60_000, {
            shipmentId: t.shipmentId, stopId: t.stopId, providerId: `sim-ci-${t.id}-${t.visitStart}`,
          })
          store.append(V2_EVENT.STOP_SERVICE_STARTED, clock + 10 * 60_000, {
            shipmentId: t.shipmentId, stopId: t.stopId, providerId: `sim-ss-${t.id}-${t.visitStart}`,
          })
        }
      } else if (tr.site.kind === 'parking' && shouldRest(t, tr.site)) {
        t.state = 'resting'
        t.speedKph = 0
        t.restLeftMs = RESET_MS
        store.append(EVENT.BREAK_START, clock, {
          truckId: t.id, siteId: tr.site.id, siteName: tr.site.name,
        })
      }
    } else if (tr.kind === 'exit') {
      store.append(EVENT.FENCE_EXIT, clock, {
        truckId: t.id,
        siteId: tr.site.id,
        siteName: tr.site.name,
        dwellMin: Math.round((clock - (t.enteredAt || clock)) / 60_000),
      })
      t.insideSiteId = null
      t.enteredAt = null
    }
  }

  function currentSpeed(t) {
    const incidentFactor = speedFactorAt(t.chainage, incidents, t.direction)
    return t.cruiseKph * Math.min(incidentFactor, flowFactorAt(t.chainage, flow))
  }

  function drive(t, dt) {
    let left = dt
    // Sub-stepped so no single movement exceeds the geofence budget.
    while (left > 0 && t.state === 'driving') {
      t.speedKph = currentSpeed(t)
      const stepMs = Math.min(
        left,
        Math.max((MAX_SUBSTEP_KM / Math.max(t.speedKph, 1)) * 3600_000, 250),
      )
      const km = (t.speedKph * stepMs) / 3600_000
      t.chainage += t.direction * km
      t.odometerKm += km
      t.drivingMs += stepMs
      t.onDutyMs += stepMs
      t.elapsedMs += stepMs
      t.cycleMs += stepMs

      if (t.chainage <= 1) {
        t.chainage = 1
        t.direction = 1
        t.destinationId = pickDestination(t)
      } else if (t.chainage >= CORRIDOR.length - 1) {
        t.chainage = CORRIDOR.length - 1
        t.direction = -1
        t.destinationId = pickDestination(t)
      }

      handleFences(t)
      left -= stepMs
    }
  }

  function planParking(t) {
    if (t.claimedSiteId || t.insideSiteId || t.state !== 'driving' || clock < (t.parkingOptOutUntil || 0)) return
    if (clockLeftMs(t) > CLAIM_THRESHOLD_MS) return
    const rec = recommendParking(observable(t), store.getWorld(), new Date(clock))
    if (!rec?.best) return
    t.claimedSiteId = rec.best.site.id
    store.append(EVENT.PARKING_CLAIM, clock, {
      truckId: t.id,
      siteId: rec.best.site.id,
      siteName: rec.best.site.name,
      etaMin: Math.round((rec.best.ahead / Math.max(t.speedKph, 40)) * 60),
      viable: rec.viable,
    })
  }

  const nearestParking = (t) =>
    PARKING_SITES.reduce((best, s) => {
      const km = Math.abs(s.chainage - t.chainage)
      return !best || km < best.km ? { site: s, km } : best
    }, null)

  /**
   * Clock exhausted between rest areas. The driver is legally required to stop
   * and there is nowhere to do it, so the truck parks on a ramp or shoulder.
   * This is the outcome the parking model exists to prevent, so it is logged
   * loudly rather than smoothed over.
   */
  function forceRoadsideStop(t) {
    releaseClaim(t, 'clock expired first')
    const near = nearestParking(t)
    t.state = 'resting'
    t.speedKph = 0
    t.restLeftMs = RESET_MS
    t.forcedStop = true
    store.append(EVENT.FORCED_STOP, clock, {
      truckId: t.id,
      coord: pos(t),
      chainage: t.chainage,
      nearestSiteId: near?.site.id,
      nearestSiteName: near?.site.name,
      shortfallKm: Math.round(near?.km ?? 0),
    })
  }

  function stepTruck(t, dt) {
    switch (t.state) {
      case 'dwelling': {
        t.dwellLeftMs -= dt
        t.onDutyMs += dt
        t.elapsedMs += dt
        t.cycleMs += dt
        if (t.dwellLeftMs <= 0) {
          // Service complete → delivery confirmed (NOT at fence entry). Then
          // gate-out. The load is cleared here, after evidence accumulated.
          if (t.laden && t.stopId) {
            const serviceCompleteAt = t.visitStart + (t.dwellLeftMs <= 0 ? (clock - t.visitStart) : 0)
            store.append(V2_EVENT.STOP_SERVICE_COMPLETED, clock, {
              shipmentId: t.shipmentId, stopId: t.stopId, facilityId: t.insideSiteId,
              providerId: `sim-sc-${t.id}-${t.visitStart}`,
            })
            store.append(V2_EVENT.STOP_DEPARTED, clock + 5 * 60_000, {
              shipmentId: t.shipmentId, stopId: t.stopId, providerId: `sim-dep-${t.id}-${t.visitStart}`,
            })
            // Detention calculation from the accumulated visit evidence.
            const visitEvents = store.events.filter((e) =>
              e.stopId === t.stopId && (e.type || '').startsWith('stop.'))
            const visit = foldVisit(visitEvents)
            const calc = calculateDetention(visit, DEFAULT_DETENTION_RULE)
            if (calc && calc.billableMinutes > 0) {
              const claimId = `CLM-${t.shipmentId}-${t.stopId}`
              store.append(V2_EVENT.DETENTION_ELIGIBLE, clock, {
                claimId, shipmentId: t.shipmentId, stopId: t.stopId, ruleId: DEFAULT_DETENTION_RULE.id,
              })
              store.append(V2_EVENT.DETENTION_CALCULATED, clock, {
                claimId, shipmentId: t.shipmentId, stopId: t.stopId, ruleId: DEFAULT_DETENTION_RULE.id,
                billableMinutes: Math.round(calc.billableMinutes),
              })
            }
            store.append(V2_EVENT.SHIPMENT_COMPLETED, clock, { shipmentId: t.shipmentId })
            t.laden = false
            t.loadId = null
            t.stopId = null
            t.shipmentId = null
          }
          t.state = 'driving'
          t.destinationId = pickDestination(t)
          // Draw the next load from the open queue — feasibility-ranked, not
          // random (assessment §8: "Load generation is not load matching"). The
          // sim offers the top feasible load to the driver, then accepts it.
          const openLoads = loadBoard.openQueue()
          if (openLoads.length) {
            // Deadhead-aware ranking: among feasible loads, pick the one whose
            // origin is nearest the truck (least empty running), breaking ties
            // by revenue. rankCandidates still filters infeasible first.
            const ranked = rankCandidates(
              openLoads,
              (load) => feasibilityForLoad(load, t),
              { positionFor: (load) => deadheadKm(t, SITE_BY_ID[load.originId]) },
            )
            const load = ranked.feasible[0] || null
            if (!load) {
              store.append(V2_EVENT.EXCEPTION_OPENED, clock, {
                severity: 'warn', affectedTruck: t.id,
                reason: 'no feasible load candidate',
                blockers: ranked.exceptions.flatMap((x) => x.blockers || []),
                deadline: clock + 30 * 60_000,
              })
              break
            }
            // Offer then accept (the loadBoard requires offered→accepted).
            loadBoard.offerLoad(load.id, t.driverId, 'sim', clock)
            const accept = loadBoard.acceptOffer(load.id, t.driverId, t.id, `sim-accept-${load.id}-${t.id}`, clock)
            if (accept.ok) {
              t.laden = true
              t.loadId = load.id
              t.shipmentId = load.shipmentId
              t.lastOriginId = t.insideSiteId
              t.destinationId = load.destinationId
              store.append(V2_EVENT.SHIPMENT_POSTED, clock, {
                shipmentId: t.shipmentId, kind: 'ftl', stops: [t.lastOriginId || 'STP-pu', t.destinationId],
                providerId: `sim-post-${t.shipmentId}`,
              })
              store.append(EVENT.LOAD_ASSIGNED, clock, {
                truckId: t.id, loadId: t.loadId, siteId: t.insideSiteId,
                destinationId: t.destinationId, destinationName: SITE_BY_ID[t.destinationId]?.name,
              })
              // Replenish the queue with a paired delivery+return load so the
              // backhaul pairing continues.
              const ret = returnDestinationFor(load.destinationId)
              if (ret) postPairedLoads(load.destinationId, ret.siteId, 800 + Math.floor(rnd() * 600))
            }
          }
        }
        handleFences(t)
        break
      }
      case 'resting': {
        t.restLeftMs -= dt
        t.elapsedMs += dt
        t.dailyOffDutyMs += dt
        if (t.restLeftMs <= 0) {
          t.state = 'driving'
          t.drivingMs = 0
          t.onDutyMs = 0
          t.elapsedMs = 0
          t.dailyOffDutyMs = 10 * 3600_000
          t.claimedSiteId = null
          store.append(EVENT.BREAK_END, clock, {
            truckId: t.id,
            siteId: t.insideSiteId,
            siteName: t.insideSiteId ? SITE_BY_ID[t.insideSiteId]?.name : 'roadside',
            wasForced: Boolean(t.forcedStop),
          })
          t.forcedStop = false
        }
        handleFences(t)
        break
      }
      default: {
        // Pre-movement safety gate (assessment §6: the v1 sim checked HOS
        // *after* driving and let a truck roll ~375m before a forced stop).
        // This runs BEFORE drive(): if HOS is exhausted or the vehicle is
        // blocked, the truck holds and an exception is opened with a resolution
        // deadline — no movement occurs.
        const guard = gateMovement({
          truck: {
            id: t.id, drivingMs: t.drivingMs, onDutyMs: t.onDutyMs,
            elapsedMs: t.elapsedMs, cycleMs: t.cycleMs, regime: t.regime, state: t.state,
          },
          vehicle: { available: !t.majorDefect, reason: t.majorDefect ? 'vehicle.defect' : null },
          route: { impassable: Boolean(t.routeImpassable) },
          assignmentId: t.shipmentId ? `ASN-${t.shipmentId}` : null,
          now: clock,
        })
        if (guard.blocked) {
          // Hold: don't drive. Emit the guard's events (exception opened +
          // assignment withdrawn) so the dispatcher sees a resolution item.
          if (guard.events) for (const e of guard.events) store.append(e.type, e.observedAt ?? clock, e)
          t.state = 'resting'
          t.speedKph = 0
          t.restLeftMs = RESET_MS
          t.forcedStop = true
        } else {
          drive(t, dt)
          planParking(t)
          // Checked after the fence pass so a truck that just rolled into a rest
          // area is recorded as parked there, not as a roadside stop.
          if (t.state === 'driving' && clockLeftMs(t) <= 0) forceRoadsideStop(t)
        }
      }
    }
    if (clock - (t.lastPingAt || 0) >= PING_INTERVAL_MS) emitPing(t)
  }

  return {
    /** Emit a first ping for every truck so the map is populated on frame one. */
    bootstrap() {
      for (const t of trucks.values()) emitPing(t)
      store.commit()
    },
    advance(realDtMs) {
      const eventCount = store.events.length
      const dt = realDtMs * speedMultiplier
      clock += dt
      for (const t of trucks.values()) stepTruck(t, dt)
      // Most 500 ms physics steps do not emit observable telemetry. Avoid
      // publishing an identical world and rerendering every React surface.
      if (store.events.length !== eventCount) store.commit()
    },
    setIncidents: (list) => {
      incidents = list || []
      // A full mainline closure makes the route edge impassable (assessment §8:
      // "route remains traversable" was the bug). Trucks whose planned path
      // crosses a closure edge are blocked at the pre-movement guard.
      const edges = closureEdges(incidents)
      for (const t of trucks.values()) {
        t.routeImpassable = edges.some((e) => Math.abs(e.chainage - t.chainage) < 14)
      }
    },
    setFlow: (list) => { flow = list || [] },
    setSpeed: (n) => { speedMultiplier = Math.max(1, Math.min(240, n)) },
    getSpeed: () => speedMultiplier,
    getClock: () => clock,
    getTruck: (id) => trucks.get(id),
    /** Driver choices update the physical model and emit the same events as automation. */
    driverParking(truckId, siteId) {
      const t = trucks.get(truckId)
      if (!t) return { ok: false, error: 'Truck is unavailable.' }
      if (siteId) {
        const site = SITE_BY_ID[siteId]
        const ahead = site && (site.chainage - t.chainage) * t.direction
        if (!site || site.kind !== 'parking' || ahead <= 0 || ahead / Math.max(t.speedKph, 40) * 3600000 > clockLeftMs(t)) return { ok: false, error: 'This stop is not reachable on your remaining hours.' }
        if (t.claimedSiteId === siteId) return { ok: true }
        releaseClaim(t, 'driver changed planned stop')
        t.claimedSiteId = siteId
        store.append(EVENT.PARKING_CLAIM, clock, { truckId, siteId, siteName: site.name, etaMin: Math.round(ahead / Math.max(t.speedKph, 40) * 60) })
      } else {
        releaseClaim(t, 'driver released claim')
        t.parkingOptOutUntil = clock + 5 * 60000
      }
      emitPing(t)
      store.commit()
      return { ok: true }
    },
  }
}
