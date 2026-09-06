# Corridor

Fleet telemetry for the Highway 401 corridor, Windsor to Toronto. Forty trucks,
four surfaces, one append-only event log.

```bash
npm install && npm run dev
```

Then open http://localhost:5173. No API keys, no `.env`, no network required —
every keyed service falls back to a bundled fixture.

**Demo credentials.** Dispatch: `dispatch@gladiolus.ca` / `corridor`. Driver:
any truck number `GLD-101`…`GLD-140` with its seeded PIN (the sign-in form
pre-fills a working pair). The customer tracking link is generated from the
dispatch topbar.

---

## The idea

A road network is a graph and a route is a shortest-path search where edge cost
is travel time, not distance. Google and Uber both build on that; they differ in
what they add on top. Corridor's addition is **parking**.

No live truck-parking occupancy feed exists for Ontario. So the fleet becomes
the sensor: our own trucks sitting inside a rest-area geofence are a sample of
everything parked there, scaled by our estimated share of corridor traffic and
blended with a historical time-of-day curve wherever that sample is thin. Live
signal plus learned pattern — the same shape as a traffic layer, at a scale
where forty trucks make it achievable by hand.

## Architecture

**The event log is the only source of truth.** Nothing writes application state
directly. Every view is a fold over the log, which means any view can be rebuilt
by replaying it, and a new metric needs a new fold rather than a migration. The
dashboard's three charts were added that way, with no schema change.

The simulator sits deliberately *outside* that. It holds the physical model —
trucks moving under their own rules — and emits only what is observable as
telemetry. Keeping the physics separate from the log is what makes the log an
honest telemetry record rather than a mirror of application state.

```
simulator (physics) ──emits──▶ event log ──fold──▶ world ──▶ views
                                   ▲
              511 / TomTom ────────┘   live edge weights
```

| Path | What lives there |
|---|---|
| `src/contract.js` | Event names, world/truck/pressure shapes, feed policy |
| `src/engine/geo.js` | Haversine, bearing, position along a measured path |
| `src/engine/events.js` | The log, the fold, `rebuild()`, the store |
| `src/engine/geofence.js` | Enter/exit with hysteresis |
| `src/engine/hos.js` | Canadian hours of service, and `reachableKm` |
| `src/engine/parking.js` | The fleet-as-sensor occupancy model |
| `src/engine/simulator.js` | The physical model |
| `src/engine/metrics.js` | Dashboard folds |
| `src/services/` | Ontario 511, TomTom, the LLM layer |

## Verification

```bash
node scripts/smoke.mjs
```

Runs eight simulated hours headlessly and asserts seventeen invariants — that
replaying the log reproduces the live world, that no truck drives past its legal
limit, that every parking estimate is bounded by capacity and never below what
we can directly see, that no geofence is further off the driven line than a
truck's approach reaches, and that the recommender returns nothing only when
nothing is genuinely reachable. **This is the merge gate for the engine.**

## Things that are true and worth saying out loud

- **The fleet share is an assumption, not a measurement.** `FLEET_SHARE = 0.06`
  says forty trucks are about 6% of corridor traffic. Every estimate that
  depends on it shows the raw observed count and a confidence figure beside it,
  because a number carrying this much weight should not hide behind a tidy
  percentage. Our own yards are counted exactly, never estimated.
- **Auth is seeded and compared in the browser.** The customer link is encoded,
  not signed. Scoped to the prototype on purpose; none of it should survive
  contact with production.
- **The LLM key would ship to the client.** Fine on a throwaway key for a demo,
  wrong in production, where this belongs behind a function. With no key set,
  every AI feature returns a cached response.
- **Ontario 511 does not reliably send CORS headers.** `vite.config.js` proxies
  `/api/511` in development. A static production build has no such proxy, so it
  runs on the bundled fixture unless you put a serverless function in front of
  it. Field casing in the response is normalised defensively — check one live
  payload before demo day rather than trusting the mapping.
- **Several rest areas sit closer to the highway than their own fence radius**,
  so passing trucks trip the geofence. That is real telematics behaviour. The
  log records all of it; the dispatcher's feed shows only arrivals the truck
  actually intended, and the dashboard reports the drive-throughs separately.
- **Forced roadside stops are a feature of the demo, not a bug.** When a driver's
  clock expires with no reachable lot, the truck stops on the shoulder and the
  event is logged loudly. That is the outcome this whole app exists to prevent.

## Optional keys

Copy `.env.example` to `.env`. All three are optional.

| Variable | Service | Without it |
|---|---|---|
| `VITE_TOMTOM_KEY` | Live speeds along the corridor | Cached flow sample |
| `VITE_LLM_KEY` | Backhaul reasoning, drafted emails, board queries | Cached responses |
| `VITE_ROUTING_KEY` | Reserved for predictive ETA | Unused today |

TomTom is sampled at eight fixed points every three minutes — roughly 1,280
calls a day against a 2,500 free-tier ceiling. Ontario 511 is free and key-free
and is cached for five minutes, well inside its ten-calls-a-minute limit.
