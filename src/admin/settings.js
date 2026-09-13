/**
 * Compatibility exports for server-backed capacity configuration.
 *
 * Capacity is no longer stored in browser localStorage. The admin surface sends
 * an authorized command and browsers rebuild values from durable
 * `config.changed` events.
 */
import { BASE_SITE_CAPACITIES, SITE_BY_ID } from '../data/corridor.js'

export const BASE_SPACES = BASE_SITE_CAPACITIES
export const CAPACITY_RANGE = Object.freeze({ min: 1, max: 400 })

export function capacityOf(siteId) {
  return SITE_BY_ID[siteId]?.spaces ?? BASE_SITE_CAPACITIES[siteId]
}

export function isOverridden(siteId) {
  return capacityOf(siteId) !== BASE_SITE_CAPACITIES[siteId]
}

export function overrideCount() {
  return Object.keys(BASE_SITE_CAPACITIES).filter(isOverridden).length
}
