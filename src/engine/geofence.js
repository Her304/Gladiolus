import { haversine } from './geo.js'
import { SITES } from '../data/corridor.js'

/**
 * Exit uses a slightly larger radius than entry. Without that hysteresis a
 * truck idling on the fence line emits an enter/exit pair every ping.
 */
const EXIT_SLACK = 1.15

/** Nearest site whose fence contains `coord`, or null. */
export function fenceContaining(coord) {
  let hit = null
  let bestDist = Infinity
  for (const site of SITES) {
    const d = haversine(coord, site.coord) * 1000
    if (d <= site.radiusM && d < bestDist) {
      bestDist = d
      hit = site
    }
  }
  return hit
}

export function stillInside(coord, site) {
  return haversine(coord, site.coord) * 1000 <= site.radiusM * EXIT_SLACK
}

/**
 * Compare a truck's previous fence to its current position and return the
 * transition. Pure, so it can be tested against a replayed log.
 */
export function transition(prevSiteId, coord) {
  const prev = prevSiteId ? SITES.find((s) => s.id === prevSiteId) : null
  if (prev) {
    return stillInside(coord, prev)
      ? { kind: 'stay', site: prev }
      : { kind: 'exit', site: prev }
  }
  const now = fenceContaining(coord)
  return now ? { kind: 'enter', site: now } : { kind: 'none', site: null }
}
