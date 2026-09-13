/**
 * The AI layer (Phase C). The LLM key lives on the server now; this calls the
 * server proxy (/api/llm/ask), which forwards to Anthropic with the server-side
 * key. No key ever ships to the browser bundle. Every call has a cached
 * fallback so a dead connection or missing key degrades the feature, not the
 * demo.
 *
 * getToken is imported lazily so this module can be analyzed without pulling in
 * the React AuthContext.
 */
const MODEL = 'claude-sonnet-5'
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

const FALLBACKS = {
  backhaul: `Windsor Cross-Dock is releasing two loads eastbound this afternoon.
GLD-118 unloads at Chatham Produce at 14:10 and would otherwise run 214 km empty
to Milton. Repositioning it 31 km back to Windsor collects the second load and
cuts the empty leg to 38 km — roughly 176 empty kilometres saved, and the driver
still reaches ONroute Woodstock inside the clock.`,

  email: `Subject: Delivery update — your shipment on GLD-118

Hello,

Your shipment is on Highway 401 near Woodstock and is now tracking to arrive at
15:40, about 25 minutes later than the original window. The delay is a lane
closure east of Cambridge, which we have routed around where possible.

We will send another update if the arrival time moves by more than 15 minutes.

Corridor Dispatch`,

  query: `Three trucks are projected to run out of hours before the next rest
area with confirmed space: GLD-107, GLD-122 and GLD-139. GLD-107 is tightest at
34 minutes of clock and 61 km to ONroute Trafalgar, which is already at 94%
estimated occupancy. Recommend diverting it to Putnam, 22 km back.`,
}

export async function ask(kind, prompt, { maxTokens = 400 } = {}) {
  const fallback = FALLBACKS[kind] ?? FALLBACKS.query
  // The LLM key lives on the server now (Phase C); the browser calls the
  // server proxy, which adds the key and forwards to Anthropic. No key ever
  // ships to the client.
  if (!SERVER_ENABLED) return { text: fallback, source: 'cached', reason: 'no server (local sim)' }
  const { getToken } = await import('../auth/AuthContext.jsx')
  try {
    const res = await fetch(apiUrl('/api/llm/ask'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ kind, prompt, maxTokens, model: MODEL }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`server responded ${res.status}`)
    const r = await res.json()
    return { text: r.text || fallback, source: r.source || 'cached' }
  } catch (err) {
    return { text: fallback, source: 'cached', error: String(err) }
  }
}

/** Compact board state for the prompt. Keeps the token cost predictable. */
export function summariseBoard(world, board) {
  const trucks = Object.values(world.trucks)
  return [
    `Fleet: ${trucks.length} trucks, ${trucks.filter((t) => t.laden).length} laden.`,
    `Empty km today: ${Math.round(world.emptyKm)}. Laden km: ${Math.round(world.ladenKm)}.`,
    'Parking:',
    ...board.map(
      (p) =>
        `- ${p.site.name}: ${p.occupied}/${p.site.spaces} occupied (${p.level}), ` +
        `${p.projectedFree} projected free, ${p.observed} of ours on site, ` +
        `${p.inbound.length} inbound on an expiring clock.`,
    ),
  ].join('\n')
}
