/**
 * Server-side proxy for external services (Phase C).
 *
 * The browser never holds an API key. LLM, TomTom, 511, and OSRM calls are
 * proxied through here, reading keys from server env. Each handler degrades
 * gracefully — a missing key or failed fetch returns a cached/fallback so the
 * app keeps working without external dependencies.
 */
import { INITIAL_INCIDENTS } from '../src/services/on511.js'

const LLM_URL = 'https://api.anthropic.com/v1/messages'
const TOMTOM_URL = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json'
const ON511_URL = 'https://511on.ca/api/v2/get/event?format=json&lang=en'

/** POST /api/llm/ask — proxy to Anthropic. Dispatch/admin only (enforced in app.js). */
export async function handleLlm(req, res, { key, body }) {
  if (!key) {
    return { ok: false, source: 'cached', reason: 'no LLM_KEY', text: cachedLlm(body?.kind) }
  }
  try {
    const r = await fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body?.model || 'claude-sonnet-5',
        max_tokens: body?.maxTokens || 400,
        messages: [{ role: 'user', content: body?.prompt || '' }],
      }),
    })
    if (!r.ok) return { ok: false, source: 'cached', reason: `LLM ${r.status}`, text: cachedLlm(body?.kind) }
    const data = await r.json()
    const text = data?.content?.[0]?.text || ''
    return { ok: true, source: 'live', text }
  } catch (e) {
    return { ok: false, source: 'cached', reason: String(e?.message || 'fetch failed'), text: cachedLlm(body?.kind) }
  }
}

/** GET /api/traffic/incidents — proxy to Ontario 511. */
export async function handleIncidents(_req, _res, {}) {
  try {
    const r = await fetch(ON511_URL, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return { ok: false, source: 'cached', data: INITIAL_INCIDENTS }
    const data = await r.json()
    return { ok: true, source: 'live', data }
  } catch {
    return { ok: false, source: 'cached', data: INITIAL_INCIDENTS }
  }
}

/** GET /api/traffic/flow — proxy to TomTom flow. */
export async function handleTrafficFlow(_req, _res, { key, points }) {
  if (!key) return { ok: false, source: 'cached', data: [] }
  try {
    // Sample the fixed corridor points (tomtom.js SAMPLES) server-side.
    const samples = await Promise.all((points || []).map(async (p) => {
      const url = `${TOMTOM_URL}?point=${p[0]},${p[1]}&key=${key}`
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) return null
      const d = await r.json()
      return {
        coord: p,
        currentSpeed: d?.flowSegmentData?.currentSpeed,
        freeFlowSpeed: d?.flowSegmentData?.freeFlowSpeed,
        currentTravelTime: d?.flowSegmentData?.currentTravelTime,
      }
    }))
    return { ok: true, source: 'live', data: samples.filter(Boolean) }
  } catch {
    return { ok: false, source: 'cached', data: [] }
  }
}

/** GET /api/route — proxy to OSRM road-snapped routing. */
export async function handleRoute(req, _res, { osrmUrl }) {
  const url = new URL(req.url, 'http://localhost')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (!from || !to) return { ok: false, error: 'from and to required' }
  try {
    const base = osrmUrl || 'https://router.project-osrm.org'
    const r = await fetch(`${base}/route/v1/driving/${from};${to}?overview=full&geometries=geojson`)
    if (!r.ok) return { ok: false, error: `OSRM ${r.status}` }
    const d = await r.json()
    return { ok: true, route: d?.routes?.[0]?.geometry || null }
  } catch (e) {
    return { ok: false, error: String(e?.message || 'fetch failed') }
  }
}

// The cached LLM fallbacks mirror src/services/llm.js FALLBACKS so the server
// and client degrade identically.
function cachedLlm(kind) {
  const F = {
    backhaul: `Windsor Cross-Dock is releasing two loads eastbound this afternoon. GLD-118 unloads at Chatham Produce at 14:10 and would otherwise run 214 km empty to Milton. Repositioning it 31 km back to Windsor collects the second load and cuts the empty leg to 38 km — roughly 176 empty kilometres saved.`,
    email: `Subject: Delivery update — your shipment on GLD-118\n\nYour shipment is on Highway 401 near Woodstock and is now tracking to arrive at 15:40, about 25 minutes later than the original window. The delay is a lane closure east of Cambridge, which we have routed around where possible.`,
    query: `Three trucks are projected to run out of hours before the next rest area with confirmed space: GLD-107, GLD-122 and GLD-139. GLD-107 is tightest at 34 minutes of clock and 61 km to ONroute Trafalgar, which is already at 94% estimated occupancy. Recommend diverting it to Putnam, 22 km back.`,
  }
  return F[kind] || F.query
}
