import { CORRIDOR } from '../data/corridor.js'
import { positionAt } from '../engine/geo.js'

/**
 * TomTom flow segment data: live speed against free-flow speed for a point.
 * The free tier allows 2,500 non-tile requests a day, so we sample eight fixed
 * points along the corridor rather than querying per truck, and cache for three
 * minutes. Eight points every three minutes is roughly 1,280 calls a day —
 * comfortably inside the ceiling, with room for a second demo run.
 */
const KEY = import.meta.env?.VITE_TOMTOM_KEY
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
  if (!KEY) return { ...cache, source: 'cached', reason: 'no VITE_TOMTOM_KEY' }
  if (!force && now - cache.at < TTL_MS && cache.source === 'live') return cache

  try {
    const data = await Promise.all(
      SAMPLES.map(async (s) => {
        const url =
          'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json' +
          `?point=${s.coord[0]},${s.coord[1]}&unit=KMPH&key=${KEY}`
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
        if (!res.ok) throw new Error(`TomTom responded ${res.status}`)
        const json = await res.json()
        return {
          km: s.km,
          currentSpeed: json?.flowSegmentData?.currentSpeed ?? 100,
          freeFlowSpeed: json?.flowSegmentData?.freeFlowSpeed ?? 100,
        }
      }),
    )
    cache = { at: now, data, source: 'live' }
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
