/**
 * The AI layer. Every call is wrapped and every call has a cached fallback, so
 * a dead connection or a missing key degrades the feature rather than the demo.
 *
 * Browser-key warning: this calls the API directly from the page, so the key
 * ships to the client. Acceptable for a scoped prototype on a throwaway key;
 * in production this belongs behind a function.
 */
const KEY = import.meta.env?.VITE_LLM_KEY
const MODEL = 'claude-sonnet-5'

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
  if (!KEY) return { text: fallback, source: 'cached', reason: 'no VITE_LLM_KEY' }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`Anthropic responded ${res.status}`)
    const json = await res.json()
    const text = json?.content?.map((c) => c.text).filter(Boolean).join('\n') || fallback
    return { text, source: 'live' }
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
