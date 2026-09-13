import { BLOCKER, VERDICT } from './contract.js'

/**
 * Configurable five-axle tractor/semitrailer pre-dispatch check. These are
 * carrier policy limits, not a substitute for an Ontario permit/configuration
 * table: a carrier can supply measured axle-group weights and lower certified
 * limits for a specific unit. Unknown payload or tare remains unresolved.
 */
export const DEFAULT_WEIGHT_CONFIG = Object.freeze({
  tareKg: 15_500,
  grossLimitKg: 39_500,
  axleLimitsKg: Object.freeze({ steer: 9_000, drive: 17_000, trailer: 17_000 }),
  // Conservative estimated loaded distribution when scale weights are absent.
  distribution: Object.freeze({ steer: 0.16, drive: 0.42, trailer: 0.42 }),
})

export function axleWeightCompliance({ payloadKg, vehicle = {}, measuredAxlesKg } = {}) {
  const tareKg = vehicle.tareKg
  const grossLimitKg = numberOr(vehicle.grossLimitKg, DEFAULT_WEIGHT_CONFIG.grossLimitKg)
  if (!Number.isFinite(payloadKg) || payloadKg < 0 || !Number.isFinite(tareKg)) {
    return { verdict: VERDICT.UNRESOLVED, overload: false, blockers: [BLOCKER.WEIGHT_UNKNOWN] }
  }

  const grossKg = tareKg + payloadKg
  const limits = { ...DEFAULT_WEIGHT_CONFIG.axleLimitsKg, ...(vehicle.axleLimitsKg || {}) }
  const distribution = { ...DEFAULT_WEIGHT_CONFIG.distribution, ...(vehicle.distribution || {}) }
  const axleGroupsKg = measuredAxlesKg || {
    steer: grossKg * distribution.steer,
    drive: grossKg * distribution.drive,
    trailer: grossKg * distribution.trailer,
  }
  const violations = []
  if (grossKg > grossLimitKg) violations.push({ group: 'gross', actualKg: grossKg, limitKg: grossLimitKg })
  for (const group of ['steer', 'drive', 'trailer']) {
    if (!Number.isFinite(axleGroupsKg[group])) {
      return { verdict: VERDICT.UNRESOLVED, overload: false, blockers: [BLOCKER.WEIGHT_UNKNOWN] }
    }
    if (axleGroupsKg[group] > limits[group]) {
      violations.push({ group, actualKg: Math.round(axleGroupsKg[group]), limitKg: limits[group] })
    }
  }
  return {
    verdict: violations.length ? VERDICT.INFEASIBLE : VERDICT.FEASIBLE,
    overload: violations.length > 0,
    blockers: violations.length ? [BLOCKER.WEIGHT] : [],
    grossKg,
    grossLimitKg,
    axleGroupsKg,
    axleLimitsKg: limits,
    measured: Boolean(measuredAxlesKg),
    violations,
  }
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
