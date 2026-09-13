import { CORRIDOR, STOP_SITES } from './corridor.js'

/** Deterministic PRNG. The demo must look identical on every judge's phone. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST = [
  'Amrit', 'Bev', 'Cal', 'Dev', 'Eli', 'Fern', 'Gus', 'Hana', 'Iva', 'Jules',
  'Kwame', 'Lior', 'Mo', 'Nils', 'Ola', 'Pris', 'Quinn', 'Rae', 'Sam', 'Tam',
]
const LAST = [
  'Basra', 'Cormier', 'Duong', 'Ellis', 'Fontaine', 'Grewal', 'Halton',
  'Ivanov', 'Jarvis', 'Kaur', 'Leblanc', 'Mensah', 'Novak', 'Okafor',
  'Pereira', 'Quirion', 'Roy', 'Sandhu', 'Tremblay', 'Uddin',
]

export const FLEET_SIZE = 40

/**
 * Trucks are spread along the corridor with a mix of directions, clock states
 * and laden flags, so the board is interesting on the first frame rather than
 * ten minutes in. Every value derives from the seeded PRNG.
 */
export function seedFleet() {
  const rnd = mulberry32(20260906)
  const trucks = []
  const drivers = []

  for (let i = 0; i < FLEET_SIZE; i++) {
    const id = `GLD-${101 + i}`
    const driverId = `D-${101 + i}`
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`
    const direction = rnd() < 0.5 ? 1 : -1
    const chainage = 8 + rnd() * (CORRIDOR.length - 16)
    const cruiseKph = 88 + Math.round(rnd() * 14)
    const laden = rnd() < 0.68

    // Spread the clocks: most drivers mid-shift, a handful close to the limit
    // so the parking logic has something to chew on from the first frame.
    const drivingH = rnd() < 0.15 ? 11.4 + rnd() * 1.4 : 2 + rnd() * 8.5

    // Consume one deterministic draw so removing credentials does not change
    // the seeded fleet geometry. Driver PINs are generated server-side only.
    rnd()
    drivers.push({
      id: driverId,
      name,
      truckId: id,
    })

    trucks.push({
      id,
      plate: `ON ${String.fromCharCode(65 + Math.floor(rnd() * 26))}${String.fromCharCode(65 + Math.floor(rnd() * 26))} ${1000 + Math.floor(rnd() * 8999)}`,
      driverId,
      driverName: name,
      direction,
      chainage,
      cruiseKph,
      speedKph: cruiseKph,
      odometerKm: Math.round(rnd() * 400_000),
      equipment: ['dry-van'],
      tareKg: 15_500,
      grossLimitKg: 39_500,
      laden,
      loadId: laden ? `L-${4000 + i}` : null,
      destinationId: STOP_SITES[Math.floor(rnd() * STOP_SITES.length)].id,
      insideSiteId: null,
      state: 'driving',
      drivingMs: drivingH * 3600_000,
      onDutyMs: (drivingH + 0.6 + rnd() * 0.9) * 3600_000,
      elapsedMs: (drivingH + 1.1) * 3600_000,
      cycleMs: (28 + (i % 30)) * 3600_000,
      dailyOffDutyMs: 10 * 3600_000,
      regime: 'cycle1',
      dwellLeftMs: 0,
      restLeftMs: 0,
      claimedSiteId: null,
      forcedStop: false,
    })
  }
  return { trucks, drivers }
}

export const { trucks: SEED_TRUCKS, drivers: SEED_DRIVERS } = seedFleet()

// NOTE: SEED_USERS (the password-bearing account list) has moved to
// server/seed-users.js — it is server-only so plaintext passwords never enter
// the browser bundle. The server hashes them on first boot; this file exports
// only the truck/driver fleet (no passwords), which is safe for the browser.
