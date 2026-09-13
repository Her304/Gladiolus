import { CORRIDOR } from '../data/corridor.js'
import { positionAt } from '../engine/geo.js'
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

/**
 * TomTom flow data (Phase C): the key lives on the server. The browser calls the
 * server proxy (/api/traffic/flow), which samples the fixed corridor points and
 * forwards to TomTom with the server-side key. Caches for three minutes.
 *
 * getToken is imported lazily inside fetchFlow so the simulator (which imports
 * flowFactorAt) doesn't pull in the React AuthContext (.jsx).
 */
const TTL_MS = 3 * 60_000
const SAMPLE_COUNT = 8

const SAMPLES = Array.from({ length: SAMPLE_COUNT }, (_, i) => {
  const km = ((i + 0.5) / SAMPLE_COUNT) * CORRIDOR.length
  return { km, coord: positionAt(CORRIDOR, km) }
})

/** Plausible cached response, used when the key is absent or the call fails. */
const FALLBACK = SAMPLES.map((s, i) => ({
  km: s.km,
  currentSpeed: [98, 94, 101, 88, 61, 96, 74, 83][i],
  freeFlowSpeed: 100,
}))

let cache = { at: 0, data: FALLBACK, source: 'cached' }

export const INITIAL_FLOW = FALLBACK

export async function fetchFlow({ force = false } = {}) {
  const now = Date.now()
  if (!SERVER_ENABLED) return { ...cache, source: 'cached', reason: 'no server (local sim)' }
  if (!force && now - cache.at < TTL_MS && cache.source === 'live') return cache
  const { getToken } = await import('../auth/AuthContext.jsx')
  try {
    const res = await fetch(apiUrl('/api/traffic/flow'), {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`server responded ${res.status}`)
    const r = await res.json()
    // The server returns sample points; map them onto our chainage SAMPLES.
    const data = r.data && r.data.length ? SAMPLES.map((s, i) => {
      const f = r.data[i]
      return {
        km: s.km,
        currentSpeed: Number(f?.currentSpeed) || FALLBACK[i].currentSpeed,
        freeFlowSpeed: Number(f?.freeFlowSpeed) || FALLBACK[i].freeFlowSpeed,
      }
    }) : FALLBACK
    cache = { at: now, data: r.source === 'live' ? data : FALLBACK, source: r.source || 'cached' }
  } catch (err) {
    cache = { at: now, data: FALLBACK, source: 'cached', error: String(err) }
  }
  return cache
}

/** Interpolated live speed ratio at a chainage, 0-1. */
export function flowFactorAt(km, flow) {
  if (!flow?.length) return 1
  let nearest = flow[0]
  for (const f of flow) {
    if (Math.abs(f.km - km) < Math.abs(nearest.km - km)) nearest = f
  }
  return Math.max(0.2, Math.min(1, nearest.currentSpeed / (nearest.freeFlowSpeed || 100)))
}
