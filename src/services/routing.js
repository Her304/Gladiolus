const cache = new Map()

const rounded = ([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`

/**
 * Ask the development routing proxy for an OSM road-snapped route. The proxy
 * keeps cross-origin policy and provider choice out of the driver client. A
 * deployed static build simply falls back to the bundled Highway 401 trace.
 */
export async function roadRoute(from, to, { signal } = {}) {
  const key = `${rounded(from)};${rounded(to)}`
  if (cache.has(key)) return cache.get(key)
  const response = await fetch(`/api/route/route/v1/driving/${key}?overview=full&geometries=geojson&steps=false`, { signal })
  if (!response.ok) throw new Error(`Routing request failed with ${response.status}`)
  const data = await response.json()
  const coordinates = data?.routes?.[0]?.geometry?.coordinates
  if (data?.code !== 'Ok' || !Array.isArray(coordinates) || coordinates.length < 2) throw new Error('No road route returned')
  const points = coordinates.map(([lon, lat]) => [lat, lon])
  cache.set(key, points)
  return points
}
