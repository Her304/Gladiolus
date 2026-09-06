/**
 * Hours of service, Canadian federal cycle, simplified to the two limits that
 * actually drive the parking decision: 13 hours driving and 14 hours on-duty in
 * a day, then a 10-hour reset. A driver who runs out of clock 40 km short of a
 * rest area is the problem this whole app exists to prevent.
 */
export const H = 3600_000
export const DRIVE_LIMIT_MS = 13 * H
export const DUTY_LIMIT_MS = 14 * H
export const RESET_MS = 10 * H

export function remaining(truck) {
  return {
    driving: Math.max(0, DRIVE_LIMIT_MS - (truck.drivingMs || 0)),
    duty: Math.max(0, DUTY_LIMIT_MS - (truck.onDutyMs || 0)),
  }
}

/** Milliseconds of driving left before either limit forces a stop. */
export function clockLeftMs(truck) {
  const r = remaining(truck)
  return Math.min(r.driving, r.duty)
}

export function hosStatus(truck) {
  const left = clockLeftMs(truck)
  if (left <= 0) return 'violation'
  if (left <= 30 * 60_000) return 'critical'
  if (left <= 90 * 60_000) return 'warn'
  return 'ok'
}

/**
 * How far this truck can still legally travel at its current speed: the scalar
 * that turns an hours-of-service clock into a point on the map.
 */
export function reachableKm(truck) {
  const speed = Math.max(truck.speedKph || 0, 40)
  return (clockLeftMs(truck) / H) * speed
}

export function fmtClock(ms) {
  if (ms <= 0) return '0:00'
  const mins = Math.floor(ms / 60_000)
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}
