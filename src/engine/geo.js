// Hand-written spherical geometry. No library: the whole surface area we need
// is "how far apart are these two points" and "where am I along a polyline".

const R_KM = 6371.0088
const toRad = (d) => (d * Math.PI) / 180
const toDeg = (r) => (r * 180) / Math.PI

/** Great-circle distance in kilometres between two [lat, lon] points. */
export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.sqrt(h))
}

/** Initial bearing in degrees from a to b, used to rotate the truck icon. */
export function bearing(a, b) {
  const lat1 = toRad(a[0])
  const lat2 = toRad(b[0])
  const dLon = toRad(b[1] - a[1])
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/**
 * Pre-compute cumulative distance along a polyline so a distance-travelled
 * scalar converts to a coordinate cheaply. This is the small-scale stand-in for
 * the shortcut pre-processing a real router does: build the expensive structure
 * once, query it many times.
 */
export function measurePath(points) {
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]))
  }
  return { points, cum, length: cum[cum.length - 1] }
}

/** Coordinate at `km` along a measured path, clamped to both ends. */
export function positionAt(path, km) {
  const { points, cum, length } = path
  const d = Math.max(0, Math.min(km, length))
  let low = 1, high = cum.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (cum[mid] < d) low = mid + 1
    else high = mid
  }
  const i = low
  const span = cum[i] - cum[i - 1]
  const t = span === 0 ? 0 : (d - cum[i - 1]) / span
  const a = points[i - 1]
  const b = points[i]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/** Heading at `km` along the path, for icon rotation. */
export function headingAt(path, km) {
  const ahead = positionAt(path, Math.min(km + 0.5, path.length))
  const behind = positionAt(path, Math.max(km - 0.5, 0))
  return bearing(behind, ahead)
}

/**
 * Distance along the path of the point nearest to `coord`: coarse sweep, then
 * a local refine. Enough to place a fixed site onto the corridor without a
 * spatial index.
 */
export function chainageOf(path, coord, step = 2) {
  let best = { km: 0, dist: Infinity }
  for (let km = 0; km <= path.length; km += step) {
    const dist = haversine(positionAt(path, km), coord)
    if (dist < best.dist) best = { km, dist }
  }
  for (let km = Math.max(0, best.km - step); km <= best.km + step; km += 0.2) {
    const dist = haversine(positionAt(path, km), coord)
    if (dist < best.dist) best = { km, dist }
  }
  // positionAt clamps, so the refine sweep can settle on a km past the end and
  // still tie for nearest. Clamp on the way out or chainage escapes the path.
  return Math.max(0, Math.min(best.km, path.length))
}

/**
 * Empty-drive distance from a truck to a site, in km. Both carry a `chainage`
 * (km-offset along the corridor). This is the shared replacement for the inline
 * `Math.abs(site.chainage - truck.chainage)` idiom used by parking, scales, and
 * the driver model.
 *
 * Returns null when either position is unknown — consistent with the
 * feasibility layer's "unknown is not safe" rule: callers treat null as "no
 * deadhead signal," never as 0 km.
 */
export function deadheadKm(truck, site) {
  if (!truck || !site || truck.chainage == null || site.chainage == null) return null
  return Math.abs(site.chainage - truck.chainage)
}
