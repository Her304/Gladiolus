/**
 * Hours of service, Canadian federal cycle.
 *
 * Assessment §6 flagged two unsafe defaults here: missing driving/duty fields
 * defaulted to zero (so unknown history read as "13h available, ok"), and
 * reachableKm floored speed at 40km/h (so a 10km/h truck in congestion got
 * 40km of optimistic reach). Both are fixed: unknown HOS reads as 'unresolved',
 * not 'ok', and reach tracks the real speed with no floor. The full regime
 * (elapsed window, cycle, daily off-duty) lives in domain/feasibility.js; this
 * module remains the two-counter helper the v1 surfaces read, now honest about
 * unknowns.
 */
export const H = 3600_000
export const DRIVE_LIMIT_MS = 13 * H
export const DUTY_LIMIT_MS = 14 * H
export const RESET_MS = 10 * H

export function remaining(truck) {
  // Unknown is not safe (assessment §6): if driving/duty history is absent, the
  // counters are undefined, not zero — so the status reads 'unresolved' rather
  // than fabricating a full 13-hour budget.
  const drivingMs = typeof truck?.drivingMs === 'number' ? truck.drivingMs : null
  const onDutyMs = typeof truck?.onDutyMs === 'number' ? truck.onDutyMs : null
  return {
    driving: drivingMs == null ? null : Math.max(0, DRIVE_LIMIT_MS - drivingMs),
    duty: onDutyMs == null ? null : Math.max(0, DUTY_LIMIT_MS - onDutyMs),
  }
}

/**
 * Milliseconds of driving left before either limit forces a stop. Returns 0
 * when HOS history is unknown — unknown is not safe, so a truck with no duty
 * record has no affirmative clock (consistent with domain/feasibility.js's
 * 'unresolved' verdict). Callers that compare with <= 0 work unchanged.
 */
export function clockLeftMs(truck) {
  const r = remaining(truck)
  if (r.driving == null || r.duty == null) return 0
  return Math.min(r.driving, r.duty)
}

export function hosStatus(truck) {
  // Distinguish "unknown history" (unresolved) from "exhausted but known"
  // (violation). Unknown is not safe, but it's not a proven violation either.
  const hasHistory = typeof truck?.drivingMs === 'number' && typeof truck?.onDutyMs === 'number'
  if (!hasHistory) return 'unresolved'
  const left = clockLeftMs(truck)
  if (left <= 0) return 'violation'
  if (left <= 30 * 60_000) return 'critical'
  if (left <= 90 * 60_000) return 'warn'
  return 'ok'
}

/**
 * How far this truck can still legally travel at its current speed: the scalar
 * that turns an hours-of-service clock into a point on the map. No speed floor
 * (assessment §6: a 10km/h truck gets proportional reach, not 40km/h-floored).
 */
export function reachableKm(truck) {
  const left = clockLeftMs(truck)
  if (left == null) return 0
  const speed = Math.max(truck.speedKph || 0, 0)
  return (left / H) * speed
}

export function fmtClock(ms) {
  if (ms == null) return '—'
  if (ms <= 0) return '0:00'
  const mins = Math.floor(ms / 60_000)
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}
