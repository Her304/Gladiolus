import { EVENT, BREAKDOWN_CATEGORIES } from '../contract.js'
import { vendorsNear } from '../data/corridor.js'

/**
 * Breakdowns, as a fold over the log.
 *
 * The valuable half of this feature is not the vendor list — it is that one tap
 * puts position, load and remaining hours in front of a dispatcher at the
 * moment a truck stops moving. A driver on a live shoulder is not going to
 * compose a description, and a dispatcher who has to ask "where are you" has
 * already lost the first ten minutes.
 */

export const CATEGORY_BY_ID = Object.fromEntries(BREAKDOWN_CATEGORIES.map((c) => [c.id, c]))

/** The open breakdown for a truck, or null once it has been cleared. */
export function openBreakdown(events, truckId) {
  const mine = events.filter(
    (e) => (e.type === EVENT.BREAKDOWN || e.type === EVENT.BREAKDOWN_CLEARED) && e.truckId === truckId,
  )
  const last = mine.at(-1)
  return last?.type === EVENT.BREAKDOWN ? last : null
}

/** Every truck currently down. The dispatch board's version of the same fold. */
export function fleetBreakdowns(events) {
  const ids = new Set(events.filter((e) => e.type === EVENT.BREAKDOWN).map((e) => e.truckId))
  return [...ids].map((id) => openBreakdown(events, id)).filter(Boolean)
}

/**
 * Who to call for this fault at this point on the corridor.
 *
 * Returns the vendor the carrier would actually pay first, plus backups —
 * a second name matters when the first cannot come out, and a driver stuck at
 * midnight should not discover that by phoning a shop that shut at seven.
 */
export function respondersFor(categoryId, chainage) {
  const service = CATEGORY_BY_ID[categoryId]?.service || 'mechanical'
  const matched = vendorsNear(chainage, service)
  // Towing covers the whole corridor and is always a valid fallback, but it is
  // the expensive answer, so it never displaces a vendor who can fix it in place.
  const tow = vendorsNear(chainage, 'tow').filter((v) => !matched.includes(v))
  return { primary: matched[0] || tow[0] || null, backups: [...matched.slice(1), ...tow].slice(0, 2) }
}
