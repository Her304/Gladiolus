import { SITES, SITE_BY_ID } from '../data/corridor.js'

/**
 * Administrator overrides on corridor configuration.
 *
 * The honest shape of the problem: this app's configuration lives in module
 * constants (`SITES`, `FLEET_SHARE`, `DRIVE_LIMIT_MS`), which is the right call
 * for a prototype with no backend and the wrong one the moment a human needs to
 * change a value without a redeploy. This module is the seam where that changes
 * — overrides live here, persist to `localStorage`, and are applied to the site
 * objects the engine already reads.
 *
 * Capacity is genuinely live: `pressureFor` reads `site.spaces` on every call,
 * so an edit here moves the parking board, the map colours and the recommender
 * on the next tick. Fence radius is deliberately *not* editable — the simulator
 * derives its sub-step budget from the smallest fence on the corridor when it is
 * constructed, so changing a radius underneath it would silently let trucks
 * tunnel through geofences. That needs a simulator restart, not a text input.
 *
 * In production none of this belongs in the browser. The pattern survives; the
 * storage does not.
 */

const KEY = 'corridor.admin.overrides'

/** Seeded capacities, captured before anything is applied over them. */
export const BASE_SPACES = Object.fromEntries(
  SITES.filter((s) => s.kind === 'parking').map((s) => [s.id, s.spaces]),
)

export const CAPACITY_RANGE = { min: 1, max: 400 }

const listeners = new Set()
let overrides = read()
let version = 0

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return { spaces: parsed?.spaces && typeof parsed.spaces === 'object' ? parsed.spaces : {} }
  } catch {
    // Private windows and blocked site data both throw here.
    return { spaces: {} }
  }
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides))
  } catch {
    /* non-fatal: the override simply does not survive a reload */
  }
}

/** Push the current overrides onto the objects the engine reads. */
function apply() {
  for (const [id, base] of Object.entries(BASE_SPACES)) {
    const site = SITE_BY_ID[id]
    if (site) site.spaces = overrides.spaces[id] ?? base
  }
  version++
  for (const l of listeners) l()
}

/** Version counter, so React can bind through `useSyncExternalStore`. */
export const getVersion = () => version

export function getOverrides() {
  return overrides
}

export function capacityOf(siteId) {
  return overrides.spaces[siteId] ?? BASE_SPACES[siteId]
}

export function isOverridden(siteId) {
  return Object.hasOwn(overrides.spaces, siteId)
}

export function overrideCount() {
  return Object.keys(overrides.spaces).length
}

/**
 * Set a parking site's capacity. Returns the clamped value actually applied, or
 * null if the input was not a usable number — the caller decides how to
 * complain, this module does not guess.
 */
export function setCapacity(siteId, spaces) {
  if (!(siteId in BASE_SPACES)) return null
  const n = Math.round(Number(spaces))
  if (!Number.isFinite(n)) return null
  const clamped = Math.max(CAPACITY_RANGE.min, Math.min(CAPACITY_RANGE.max, n))
  if (clamped === BASE_SPACES[siteId]) delete overrides.spaces[siteId]
  else overrides.spaces[siteId] = clamped
  write()
  apply()
  return clamped
}

export function clearCapacity(siteId) {
  if (!Object.hasOwn(overrides.spaces, siteId)) return false
  delete overrides.spaces[siteId]
  write()
  apply()
  return true
}

export function resetAll() {
  const n = overrideCount()
  overrides = { spaces: {} }
  write()
  apply()
  return n
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Applied at module load so a persisted override is in place before
// `startRuntime()` bootstraps the simulator in App's first effect.
apply()
