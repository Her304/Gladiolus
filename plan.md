# Corridor — build plan

## Context

Corridor is a hackathon prototype for a 40-truck fleet running the Highway 401
corridor between Windsor and Toronto. It has to be built by three people in a
two-hour window and demoed to judges opening it on their own phones.

The underlying idea is the one behind every routing product: a road network is a
graph, and a route is a shortest-path search where edge cost is travel time, not
distance. Google and Uber both sit on that foundation and differ in what they
add on top. Corridor's addition is **parking**. No live truck-parking occupancy
feed exists for Ontario, so the fleet itself becomes the sensor: our own trucks
inside a rest-area geofence are a sample of everything parked there, blended
with a historical time-of-day curve where the sample is thin. That blend — live
signal plus learned pattern — is the same shape as a traffic layer, at a scale
where forty trucks make it achievable by hand.

The intended outcome is a deployed, shareable URL showing four surfaces
(dispatch, driver, dashboard, customer) driven by a single append-only event log.

**Starting state:** an earlier spike wrote ~1,340 lines of engine plus a headless
smoke test. That is being discarded and rebuilt. The bugs it surfaced are not
discarded — they are in **Known traps** below, and avoiding them is worth
roughly 40 minutes of the two hours.

---

## Step 0 — clear the decks (2 min, before anyone starts)

Delete the spike so nobody builds against half of it:

```bash
rm -rf src scripts && git add -A && git commit -m "reset: discard engine spike"
```

Keep: `package.json`, `vite.config.js`, `index.html`, `.gitignore`,
`.env.example`, `node_modules/`. Dependencies are already installed and correct
(react 19, react-dom, leaflet, react-leaflet 5, recharts, vite).

---

## Architecture

One rule, and it decides everything else:

**The event log is the only source of truth.** Nothing writes application state
directly. Every view is a fold over the log, so any view can be rebuilt by
replaying it, and a new metric needs a new fold rather than a migration.

The simulator is deliberately *outside* that. It holds the physical model —
trucks that move under their own rules — and emits only what is observable as
telemetry. Keeping the physics separate from the log is what makes the log an
honest telemetry record instead of a mirror of app state, and it is the sentence
to say out loud when a judge asks how this maps to real trucks.

```
simulator (physics) ──emits──▶ event log ──fold──▶ world ──▶ views
                                   ▲
              511 / TomTom ────────┘  (edge weights: live speed factors)
```

---

## The contract (first 10 minutes, then frozen)

This is the whole trick for three-way parallelism. One person writes
`src/contract.js` **first**, everyone agrees on it, and it does not change
without all three saying yes. Lanes B and C then build against `mockWorld()`
immediately, without waiting for Lane A.

```js
// src/contract.js
export const EVENT = {
  PING: 'truck.ping',
  FENCE_ENTER: 'fence.enter',      FENCE_EXIT: 'fence.exit',
  LOAD_ASSIGNED: 'load.assigned',  LOAD_DELIVERED: 'load.delivered',
  BREAK_START: 'hos.break.start',  BREAK_END: 'hos.break.end',
  PARKING_CLAIM: 'parking.claim',  PARKING_RELEASE: 'parking.release',
  FORCED_STOP: 'hos.forced_stop',  INCIDENT: 'traffic.incident',
}

// Truck (the observable subset — this is what views may read):
//   id, plate, driverId, driverName, coord:[lat,lon], heading, chainage,
//   direction(1=east|-1=west), speedKph, odometerKm, laden, loadId,
//   destinationId, state('driving'|'dwelling'|'resting'),
//   drivingMs, onDutyMs, insideSiteId, claimedSiteId, parked
//
// World:
//   { clock, trucks:{[id]:Truck}, sites:{[id]:{occupants[],claims[],visits}},
//     dwells:[{truckId,siteId,minutes,at}], ladenKm, emptyKm }
//
// Pressure (one per parking site):
//   { site, observed, claims, inbound[], historical, confidence,
//     estimatedUtil, occupied, free, projectedFree, level }
//   level: 'open'|'filling'|'tight'|'full'

createStore()  -> { events, append(type,at,payload), commit(), getWorld(),
                    getVersion(), subscribe(fn), feed(limit), reset() }
createSimulator(store, {startHour}) -> { bootstrap(), advance(realDtMs),
                    setIncidents(), setFlow(), setSpeed(n), getClock(), getTruck(id) }
pressureBoard(world, date)          -> Pressure[]
recommendParking(truck, world, date)-> { best, alternatives, reach, viable } | null
hosStatus(truck) -> 'ok'|'warn'|'critical'|'violation'
clockLeftMs(truck) -> ms

export function mockWorld() { /* 6 hand-written trucks + 3 sites, frozen */ }
```

Also written in this window, by the same person: `src/App.jsx` as a bare shell
with role routing and nothing else in it. It is the one file all three lanes
touch, so it gets created once, early, and edited only at integration.

---

## Three lanes (minutes 10–70)

File ownership is exclusive. No two lanes edit the same file.

### Lane A — engine and data
Owns `src/engine/*`, `src/data/*`, `scripts/smoke.mjs`.

1. `data/corridor.js` — ~14-vertex polyline for the 401 (Windsor → Scarborough,
   ordered west to east so chainage increases eastbound), 8 stop sites, 6 rest
   areas with real space counts. Each site carries its `chainage` so route
   projection is a scalar comparison, not a geo query.
2. `engine/geo.js` — haversine, bearing, `measurePath`, `positionAt`,
   `headingAt`, `chainageOf`. Roughly 80 lines, no library. `measurePath` is the
   cheap stand-in for the shortcut pre-processing a real router does: build the
   expensive structure once, query it many times.
3. `engine/events.js` — the log, `applyEvent` (total: an unknown type advances
   the clock and nothing else), `rebuild(events)` for replay, and `createStore`.
4. `engine/geofence.js` — enter/exit with hysteresis.
5. `engine/hos.js` — Canadian federal cycle simplified to the two limits that
   drive the parking decision: 13 h driving, 14 h on-duty, 10 h reset. Plus
   `reachableKm`, the scalar that turns an HOS clock into a point on the map.
6. `engine/parking.js` — the differentiator. See traps 2 and 8.
7. `engine/simulator.js` — three-state machine per truck
   (`driving`/`dwelling`/`resting`), capacity-aware claims, forced roadside stops.
8. `scripts/smoke.mjs` — the gate. Runs 8 sim hours headlessly and asserts:
   replay reproduces the live world; exits never outnumber enters; no truck
   drives more than an hour past the 13 h limit; every parking estimate is
   bounded by capacity; a recommendation is always ahead of the truck and inside
   its reach.

**Lane A is not done until `node scripts/smoke.mjs` exits 0.**

### Lane B — map and the two live surfaces
Owns `src/components/*`, `src/views/DispatchBoard.jsx`, `src/views/DriverView.jsx`,
`src/views/CustomerView.jsx`.

- `MapPane.jsx` — Leaflet + OSM tiles. 40 rotated truck markers coloured by HOS
  status, geofence circles, incident markers, corridor polyline. Remember
  `import 'leaflet/dist/leaflet.css'` and fix the default marker-icon paths, or
  markers render blank under Vite.
- `ParkingPanel.jsx` — the pressure board, ordered by chainage. Show `observed`
  and `confidence` in the UI, not just the estimate: the fleet-share assumption
  is load-bearing and should not be invisible.
- `EventFeed.jsx` — reverse-chronological, human-readable, `FORCED_STOP` styled
  loudly. That event is the failure the product prevents; it is the demo's best
  moment.
- `DispatchBoard.jsx` — map + feed + parking panel + sim speed control.
- `DriverView.jsx` — one truck: load, next stop, HOS clock, parking
  recommendation with alternatives.
- `CustomerView.jsx` — read-only single-load tracking at `/t/:token`.

Build all of it against `mockWorld()`.

### Lane C — services, auth, dashboard, deploy
Owns `src/services/*`, `src/fixtures/*`, `src/auth/*`, `src/views/Dashboard.jsx`,
`README.md`, hosting.

- `services/on511.js` — free, no key, 10 calls/min ceiling, so cache 5 min and
  never poll faster. Normalise defensively (field casing is unverified against a
  live response — check one before demo day). Filter to the corridor; 511 covers
  the province. Export `speedFactorAt(chainage, incidents, direction)` — this is
  the live edge weight, applied to our one long edge.
- `services/tomtom.js` — sample 8 fixed points along the corridor every 3 min,
  not per truck. That is ~1,280 calls/day against a 2,500 free-tier ceiling,
  with room for a second demo run.
- `services/llm.js` — backhaul reasoning, drafted customer emails, board queries.
  Every call wrapped, every call with a cached fallback.
- `auth/AuthContext.jsx` — seeded users, PIN for drivers, email/password for
  dispatch, signed link for customers. Deliberately not production-grade; say so
  plainly in the README and if a judge asks.
- `views/Dashboard.jsx` — Recharts: dwell league table, empty-kilometre trend,
  utilisation.
- Deploy to Vercel or Netlify. Static build.

---

## Known traps (from the discarded spike — all of these actually happened)

1. **`chainageOf` overshoots the path end.** `positionAt` clamps, so the refine
   sweep can settle on a km past the end and still tie for nearest. Clamp the
   return to `[0, path.length]` or a site's chainage escapes the corridor.
2. **Naive occupancy blows past capacity.** `observed / FLEET_SHARE` with 16
   trucks observed at a 6% share implies 266 trucks in a 26-space lot. Count our
   own trucks *exactly* and estimate only the remainder:
   `occupied = clamp(sampled·confidence + historical·spaces·(1−confidence), observed, spaces)`,
   with `confidence = min(1, observed/5)`. Never estimate fewer than we can see.
3. **Tick distance must stay under the fence radius.** At 30× with 500 ms ticks a
   truck covers ~420 m per step against a 260 m fence radius, so it teleports
   through geofences. Sub-step movement to ≤100 m per iteration.
4. **A drive-through is not a dwell.** Even with sub-stepping, a truck passing a
   rest area legitimately fires enter+exit. Record it as a transit, not a
   0-minute dwell — the spike's smoke test asserted "no zero-minute dwells" and
   was itself wrong. Assert "no dwell shorter than the stop threshold" instead.
5. **Ontario 511 has no reliable CORS headers.** Proxy `/api/511` in
   `vite.config.js` for dev. A static production build needs an equivalent
   serverless proxy or it runs on the fixture — decide which before deploying.
6. **Import fixtures as `.js`, not `.json`.** Node 24 needs an import attribute
   for JSON; Vite does not. A `.js` module exporting the array loads identically
   under both, which is what lets the smoke test run headlessly.
7. **Guard `import.meta.env?.X`.** Unguarded, it throws under plain Node and the
   smoke test cannot import anything that touches a service.
8. **The recommender must never return `null` when options exist.** When every
   reachable site is projected full, return the least-bad one and mark
   `viable: false`. "Putnam at 88%, and it is your only chance" is actionable;
   `null` is not. Reserve `null` for genuinely nothing reachable — that is the
   real alert.
9. **Check capacity on arrival, not just at claim time.** Otherwise the whole
   fleet piles into one rest area. If the space is gone, release the claim and
   re-plan while there is still clock left.
10. **Geofence hysteresis.** Exit radius ~1.15× entry radius, or a truck idling
    on the fence line emits an enter/exit pair every ping.
11. **Ping budget.** 40 trucks pinging every tick is unusable. Ping each truck
    once per ~90 sim seconds, and keep a separate capped feed array so the human
    feed is O(1) rather than a backwards scan across tens of thousands of pings.
12. **Seed everything deterministically** (mulberry32). The demo must look
    identical on every judge's phone.

---

## Integration (70–90) and deploy (90–105)

1. Lane A merges first. `node scripts/smoke.mjs` must pass.
2. Swap `mockWorld()` for the real store in `App.jsx`. Bind React with
   `useSyncExternalStore` against `store.subscribe` / `store.getVersion` so the
   40-truck map does not re-fold on every render.
3. Wire the sim loop: `setInterval(() => sim.advance(500), 500)`, default 30×.
4. Feed live services in: `sim.setIncidents()` and `sim.setFlow()`.
5. `npm run build && npx vite preview` before pushing anywhere.
6. Deploy, then open the URL on an actual phone. Minutes 105–120 are buffer.

---

## Verification

- **Engine:** `node scripts/smoke.mjs` exits 0. This is the merge gate for Lane A.
- **Replay invariant:** `rebuild(store.events)` must reproduce the live world —
  same dwell count, same empty km, same truck count. If this breaks, the log has
  stopped being the source of truth.
- **UI:** `npm run dev`, then check each surface — dispatch board renders 40
  trucks and a populated parking panel on the first frame; driver PIN login
  reaches a single-truck view with a live HOS clock; dashboard renders all three
  charts; customer link opens read-only without auth.
- **Degradation:** run once with no `.env` at all. Every keyed service must fall
  back to its cached fixture and the app must be fully demoable offline.
- **Production build:** `npm run build && npx vite preview`, then load on a phone
  over the network, not just localhost.

---

## Stated assumptions

- `FLEET_SHARE = 0.06` (40 trucks ≈ 6% of corridor traffic) is an assumption, not
  a measurement. It is surfaced in the UI on purpose.
- Auth is seeded and compared in the browser. Prototype-scoped, not an oversight.
- The LLM key ships to the client. Acceptable on a throwaway key for a demo;
  in production this belongs behind a function. Flag it in the README.
- Ontario 511 field casing is unverified against a live response. Normalise
  defensively and check one real payload before demo day.
  