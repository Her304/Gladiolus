import {
  CORRIDOR, SITE_BY_ID, STOP_SITES, PARKING_SITES, MIN_FENCE_M,
} from '../data/corridor.js'
import { positionAt, headingAt } from './geo.js'
import { transition } from './geofence.js'
import { EVENT } from './events.js'
import { APPROACH_KM } from '../contract.js'
import { clockLeftMs, RESET_MS } from './hos.js'
import { recommendParking, pressureFor } from './parking.js'
import { seedFleet, mulberry32 } from '../data/seed.js'
import { speedFactorAt } from '../services/on511.js'
import { flowFactorAt } from '../services/tomtom.js'

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
      destinationId: t.destinationId,
      state: t.state,
      drivingMs: t.drivingMs,
      onDutyMs: t.onDutyMs,
      insideSiteId: t.insideSiteId,
      claimedSiteId: t.claimedSiteId,
      parked: t.state === 'resting',
      forcedStop: Boolean(t.forcedStop),
    }
  }

  function emitPing(t) {
    store.append(EVENT.PING, clock, { truckId: t.id, truck: observable(t) })
    t.lastPingAt = clock
  }

  function pickDestination(t) {
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
        t.dwellLeftMs = (35 + rnd() * 85) * 60_000
        if (t.laden) {
          store.append(EVENT.LOAD_DELIVERED, clock, {
            truckId: t.id, loadId: t.loadId, siteId: tr.site.id, siteName: tr.site.name,
          })
          t.laden = false
          t.loadId = null
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
    if (t.claimedSiteId || t.insideSiteId || t.state !== 'driving') return
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
        if (t.dwellLeftMs <= 0) {
          t.state = 'driving'
          t.destinationId = pickDestination(t)
          if (rnd() < 0.72) {
            t.laden = true
            t.loadId = `L-${Math.floor(4000 + rnd() * 5000)}`
            store.append(EVENT.LOAD_ASSIGNED, clock, {
              truckId: t.id,
              loadId: t.loadId,
              siteId: t.insideSiteId,
              destinationId: t.destinationId,
              destinationName: SITE_BY_ID[t.destinationId]?.name,
            })
          }
        }
        handleFences(t)
        break
      }
      case 'resting': {
        t.restLeftMs -= dt
        if (t.restLeftMs <= 0) {
          t.state = 'driving'
          t.drivingMs = 0
          t.onDutyMs = 0
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
        drive(t, dt)
        planParking(t)
        // Checked after the fence pass so a truck that just rolled into a rest
        // area is recorded as parked there, not as a roadside stop.
        if (t.state === 'driving' && clockLeftMs(t) <= 0) forceRoadsideStop(t)
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
      const dt = realDtMs * speedMultiplier
      clock += dt
      for (const t of trucks.values()) stepTruck(t, dt)
      store.commit()
    },
    setIncidents: (list) => { incidents = list || [] },
    setFlow: (list) => { flow = list || [] },
    setSpeed: (n) => { speedMultiplier = Math.max(1, Math.min(240, n)) },
    getSpeed: () => speedMultiplier,
    getClock: () => clock,
    getTruck: (id) => trucks.get(id),
  }
}
