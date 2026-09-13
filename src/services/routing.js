const cache = new Map()
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

const rounded = ([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`
const osrmCoordinate = ([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`

/**
 * Road-snapped routing (Phase C). The browser calls the server proxy
 * (/api/route?from=lat,lon&to=lat,lon); the server fetches OSRM so the provider
 * choice and cross-origin policy stay out of the client. A deployed build with
 * no server falls back to the bundled Highway 401 trace (the caller handles the
 * throw). getToken is imported lazily to avoid pulling React into non-browser
 * consumers.
 */
export async function roadRoute(from, to, { signal } = {}) {
  const key = `${rounded(from)};${rounded(to)}`
  if (cache.has(key)) return cache.get(key)
  if (!SERVER_ENABLED) throw new Error('no server (local sim)')
  const { getToken } = await import('../auth/AuthContext.jsx')
  const response = await fetch(
    apiUrl(`/api/route?from=${osrmCoordinate(from)}&to=${osrmCoordinate(to)}`),
    { headers: { Authorization: `Bearer ${getToken()}` }, signal },
  )
  if (!response.ok) throw new Error(`Routing request failed with ${response.status}`)
  const data = await response.json()
  if (!data?.ok || !data.route?.coordinates) throw new Error('No road route returned')
  const points = data.route.coordinates.map(([lon, lat]) => [lat, lon])
  cache.set(key, points)
  return points
}
