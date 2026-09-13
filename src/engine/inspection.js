import { EVENT, INSPECTION_VALID_H, INSPECTION_BY_ID } from '../contract.js'

/**
 * Daily trip inspections, as a fold over the log.
 *
 * Ontario requires a driver to record an inspection before the first drive of
 * the day and again at the end of it (O. Reg. 199/07, Schedule 1), and to carry
 * the report for 24 hours. That makes this the one driver feature the portal
 * cannot treat as optional — a fleet app without it is not usable on a real
 * road — and it makes the append-only log exactly the right home for it, since
 * the legal artefact *is* an immutable dated record.
 *
 * Nothing here rewrites an inspection. A driver who got it wrong records a new
 * one; the old one stays, the same way a corrected duty status does.
 */

const H = 3_600_000

export function inspections(events, truckId) {
  return events.filter((e) => e.type === EVENT.INSPECTION && (!truckId || e.truckId === truckId))
}

/** The inspection in force, or null when none is within its 24-hour life. */
export function currentInspection(events, truckId, now) {
  const last = inspections(events, truckId).findLast((e) => e.phase === 'pre-trip')
  if (!last) return null
  return now - last.at <= INSPECTION_VALID_H * H ? last : null
}

/**
 * What the portal should do about inspections right now.
 *
 * `blocking` is the load-bearing field: it means the driver may not legally
 * start driving, so the Today screen leads with it instead of the next stop.
 * A major defect blocks too — an out-of-service defect does not become drivable
 * because the paperwork is filed.
 */
export function inspectionState(events, truckId, now) {
  const all = inspections(events, truckId)
  const pre = currentInspection(events, truckId, now)
  const lastAny = all.at(-1) || null
  const openMajor = all.findLast((e) => e.major) || null
  const cleared = openMajor
    ? all.some((e) => e.at > openMajor.at && !e.major && e.phase === 'pre-trip')
    : false

  const expiresAt = pre ? pre.at + INSPECTION_VALID_H * H : null
  const dueIn = expiresAt ? expiresAt - now : 0
  const major = openMajor && !cleared ? openMajor : null

  // An empty log means this portal has never seen an inspection for this truck
  // — not that the driver failed to do one. The rest of this codebase refuses to
  // infer history it does not have, and asserting a legal violation from absent
  // data would be the worst possible place to start. So a truck with no record
  // is prompted; only a record we hold and can see has expired blocks driving.
  const everRecorded = all.length > 0
  const expired = everRecorded && !pre

  return {
    pre,
    lastAny,
    major,
    expiresAt,
    dueIn,
    // Under four hours left is worth surfacing before it becomes a blocker mid-shift.
    expiringSoon: Boolean(pre && dueIn <= 4 * H),
    blocking: Boolean(major) || expired,
    prompt: !everRecorded,
    reason: major
      ? 'A major defect is recorded against this truck.'
      : expired
        ? 'Your last inspection is more than 24 hours old.'
        : null,
  }
}

/** Defect ids resolved to their Schedule 1 labels, for display. */
export function defectLabels(defects = []) {
  return defects.map((id) => INSPECTION_BY_ID[id]?.label || id)
}

/** Whether any of these defect ids puts the vehicle out of service. */
export function hasMajor(defects = []) {
  return defects.some((id) => INSPECTION_BY_ID[id]?.major)
}

/**
 * Trucks across the fleet carrying an open major defect. The dispatch board
 * wants this as a fold, not as a driver-by-driver query.
 */
export function fleetDefects(events, now) {
  const byTruck = new Map()
  for (const e of inspections(events)) byTruck.set(e.truckId, e)
  const out = []
  for (const truckId of byTruck.keys()) {
    const state = inspectionState(events, truckId, now)
    if (state.major || state.blocking) out.push({ truckId, ...state })
  }
  return out
}
