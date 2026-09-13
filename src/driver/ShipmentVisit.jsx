/**
 * Driver shipment-visit view (Phase 2 — driver surface).
 *
 * Replaces the isolated dock timer with the main shipment visit. Shows the
 * operational milestone, elapsed visit time, remaining free time, HOS risk,
 * requested action, and dispatch acknowledgment. The countdown never hides a
 * more urgent safety instruction (plan §5 Phase 2): a critical HOS or safety
 * blocker takes precedence over the detention countdown.
 */
import { useEvents } from '../useStore.js'
import { foldVisit } from '../domain/detention.js'
import { DEFAULT_DETENTION_RULE } from '../domain/contract.js'
import { clockLeftMs, hosStatus, fmtClock } from '../engine/hos.js'
import { fmtTime } from '../format.js'

const H = 3600_000
const MIN = 60_000

/**
 * @param {object} props
 * @param {object} props.truck    the driver's truck (for HOS)
 * @param {string} [props.stopId] the active delivery stop id (optional)
 */
export default function ShipmentVisit({ truck, stopId }) {
  const events = useEvents()

  // Fold the active visit from stop-milestone events for this stop (or the
  // truck's current facility).
  const targetStop = stopId || truck?.insideSiteId
  const visitEvents = (events || []).filter((e) =>
    e.type.startsWith('stop.') && (e.stopId === targetStop || (!targetStop && e.truckId === truck?.id))
  )
  const visit = visitEvents.length ? foldVisit(visitEvents) : null
  const rule = DEFAULT_DETENTION_RULE

  // The precedence rule: safety first. A critical HOS condition or an
  // immobilizing blocker leads; the detention countdown follows, never overrides.
  const hos = hosStatus(truck)
  const hosLeft = clockLeftMs(truck)
  const safetyFirst = hos === 'violation' || hos === 'critical'

  if (!visit || !visit.arrived) {
    return (
      <div className="shipment-visit empty">
        <p className="muted">No active facility visit.</p>
      </div>
    )
  }

  const now = truck?.clock ?? Date.now()
  const elapsedMs = now - visit.arrived
  const freeMs = rule.freeTimeMs
  const remainingFreeMs = freeMs - elapsedMs
  const inDetention = remainingFreeMs <= 0
  const detentionMs = inDetention ? -remainingFreeMs : 0

  return (
    <div className="shipment-visit">
      {/* Safety leads. The countdown never hides this. */}
      {safetyFirst && (
        <div className="visit-safety alarm">
          <strong>HOS {hos}.</strong> You have {fmtClock(hosLeft)} of drive time left.
          Do not move without a feasible safe-stop or onsite-rest resolution confirmed by dispatch.
        </div>
      )}

      <div className="visit-milestone">
        <span className="milestone-label">Milestone</span>
        <span className={`milestone m-${visit.milestone}`}>{label(visit.milestone)}</span>
      </div>

      <div className="visit-times">
        <div className="time-block">
          <span className="t-label">Elapsed visit</span>
          <span className="t-value">{fmtClock(elapsedMs)}</span>
        </div>
        {inDetention ? (
          <div className="time-block detention">
            <span className="t-label">Detention time</span>
            <span className="t-value">{fmtClock(detentionMs)}</span>
          </div>
        ) : (
          <div className="time-block free">
            <span className="t-label">Remaining free time</span>
            <span className="t-value">{fmtClock(remainingFreeMs)}</span>
          </div>
        )}
      </div>

      <div className="visit-hos">
        <span className="t-label">HOS drive/duty left</span>
        <span className={`t-value hos-${hos}`}>{fmtClock(hosLeft)}</span>
      </div>

      <div className="visit-action">
        <span className="t-label">Requested action</span>
        <span className="t-value">{requestedAction(visit, safetyFirst)}</span>
      </div>

      <div className="visit-ack">
        <span className="t-label">Dispatch acknowledgment</span>
        <span className="t-value muted">Awaiting</span>
      </div>
    </div>
  )
}

function label(m) {
  return ({
    none: 'Not arrived',
    arrived: 'Arrived',
    checked_in: 'Checked in',
    service_started: 'Service in progress',
    service_completed: 'Service complete',
    departed: 'Departed',
  })[m] || m
}

function requestedAction(visit, safetyFirst) {
  if (safetyFirst) return 'Hold for safe-stop / onsite-rest resolution'
  if (visit.milestone === 'service_completed') return 'Confirm departure and gate-out'
  if (visit.milestone === 'service_started') return 'Complete service'
  if (visit.milestone === 'arrived') return 'Check in at the dock'
  return 'Proceed to stop'
}
