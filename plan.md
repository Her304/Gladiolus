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

The second addition is **empty miles**. A truck running without freight is the
industry's most expensive habit, and the corridor's geometry is what lets us
attack it cheaply: the 401 is a line, every site carries a chainage, so the
distance between dropping one load and collecting the next is a scalar
subtraction rather than a geo query. Minimising the total of those gaps has a
closed form — sort trucks and open loads by chainage and match them in order,
which is provably optimal because any crossing pair of empty legs can be
uncrossed without increasing total distance. The naive dispatch everyone assumes
is happening — first free truck takes the next load — is the baseline we beat,
and we beat it with a sort rather than a solver.

Those two additions are one decision, not two. A truck that finishes its
ten-hour reset in the wrong rest area has already spent tomorrow's empty
kilometres. Parking choice *is* a dispatch choice, and saying that out loud is
what makes Corridor more than a parking app.

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
                                  ▲  ▲                │
             511 / TomTom ────────┘  └─── dispatch ◀──┘
             (live edge weights)       (assignments are events too)
```

Dispatch sits on the same loop as everything else: it is a pure function of the
world that appends `load.assigned` events back to the log. It holds no state of
its own, so a replay reproduces every assignment decision, and the empty-mile
number on the dashboard is reconstructible rather than asserted.

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
  LOAD_POSTED: 'load.posted',
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
// Load:
//   { id, originId, destId, originChainage, destChainage, readyAt, dueAt,
//     status('open'|'assigned'|'delivered'), truckId }
//
// World:
//   { clock, trucks:{[id]:Truck}, loads:{[id]:Load},
//     sites:{[id]:{occupants[],claims[],visits}},
//     dwells:[{truckId,siteId,minutes,at}],
//     ladenKm, deadheadKm, idleKm, emptyKm }
//
// emptyKm is derived: deadheadKm + idleKm. One bucket hides the half we can
// actually fix — see trap 14.
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
planAssignments(world, date, policy)-> [{ truckId, loadId, emptyKm }]
  policy: 'corridor' (default) | 'naive' — the baseline we measure against
hosStatus(truck) -> 'ok'|'warn'|'critical'|'violation'
clockLeftMs(truck) -> ms

export function mockWorld() { /* 6 trucks + 3 sites + 4 loads, frozen */ }
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
2. `data/loads.js` — a seeded day's freight between the stop sites, deliberately
   asymmetric (the westbound lane is thinner, which is what creates empty miles
   in the first place). Loads enter the world as `load.posted` events, not as a
   fixture the dispatcher reads directly — otherwise replay stops reproducing
   assignment decisions and the log is no longer the source of truth.
3. `engine/geo.js` — haversine, bearing, `measurePath`, `positionAt`,
   `headingAt`, `chainageOf`. Roughly 80 lines, no library. `measurePath` is the
   cheap stand-in for the shortcut pre-processing a real router does: build the
   expensive structure once, query it many times.
4. `engine/events.js` — the log, `applyEvent` (total: an unknown type advances
   the clock and nothing else), `rebuild(events)` for replay, and `createStore`.
5. `engine/geofence.js` — enter/exit with hysteresis.
6. `engine/hos.js` — Canadian federal cycle simplified to the two limits that
   drive the parking decision: 13 h driving, 14 h on-duty, 10 h reset. Plus
   `reachableKm`, the scalar that turns an HOS clock into a point on the map.
7. `engine/parking.js` — the differentiator. See traps 2 and 8. The site score
   also carries a small deadhead term — distance from the rest area to the
   origin of the load this truck most likely takes next — weighted low enough
   that availability still dominates. We never trade a legal park for a shorter
   empty leg; we break ties with it.
8. `engine/dispatch.js` — the empty-mile engine, ~50 lines. Cost of pairing a
   truck to a load is `|load.originChainage − truck.chainage|`, plus a backtrack
   multiplier when the pickup is behind the truck, plus a wait-versus-drive term
   (holding a truck 40 minutes beats driving it 90 km empty). Feasibility gate:
   the empty leg must fit inside `reachableKm(truck)`. With pure distance and
   equal counts the optimal matching is the sorted one; with the constraints on
   it, fall back to globally-sorted greedy and a 2-opt uncross pass, which is
   the same non-crossing argument applied locally. Also exports the `naive`
   policy — first free truck takes the next load — because the baseline has to
   run on the same seed to mean anything. See traps 13 and 14.
9. `engine/simulator.js` — three-state machine per truck
   (`driving`/`dwelling`/`resting`), capacity-aware claims, forced roadside stops.
10. `scripts/smoke.mjs` — the gate. Runs 8 sim hours headlessly and asserts:
    replay reproduces the live world; exits never outnumber enters; no truck
    drives more than an hour past the 13 h limit; every parking estimate is
    bounded by capacity; a recommendation is always ahead of the truck and
    inside its reach; no load is assigned to two trucks at once;
    `deadheadKm + idleKm` equals `emptyKm` after replay; and the corridor
    policy's empty kilometres are strictly below the naive policy's on the
    same seed.

**Lane A is not done until `node scripts/smoke.mjs` exits 0.**

Loads and dispatch add roughly 25 minutes to this lane, which the two hours do
not contain for free. It is paid for out of Lane C's `services/llm.js` — see
that lane for what shrinks.

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
- `DispatchBoard.jsx` — map + feed + parking panel + sim speed control, plus a
  live empty-mile readout (laden / deadhead / idle) and the policy toggle. The
  toggle is the demo: flip it and the number moves.
- `DriverView.jsx` — one truck: load, next stop, HOS clock, parking
  recommendation with alternatives. Show the next pickup and the empty
  kilometres to reach it, so the driver sees the same number dispatch is
  optimising.
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
- `services/llm.js` — drafted customer emails, board queries, and a plain-English
  narration of the assignment `engine/dispatch.js` already made. It explains, it
  does not decide: the solver is deterministic and provable, an LLM is neither,
  and this is what pays for Lane A's extra 25 minutes. Every call wrapped, every
  call with a cached fallback.
- `auth/AuthContext.jsx` — seeded users, PIN for drivers, email/password for
  dispatch, signed link for customers. Deliberately not production-grade; say so
  plainly in the README and if a judge asks.
- `views/Dashboard.jsx` — Recharts: dwell league table, empty-kilometre trend,
  utilisation. The trend carries two lines on the same seed, naive and corridor,
  and the headline number is the gap between them. Split the empty bar into
  deadhead and idle: the second is the addressable half and the one that should
  visibly shrink.
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
13. **Greedy per-truck assignment is itself the trap.** Walking the truck list
    and giving each one its nearest open load looks reasonable and is measurably
    worse, because the first truck takes a load a later truck was sitting on top
    of. Assign globally or not at all. On a line the fix is free — sort both
    sides by chainage, match in order — so there is no excuse for the greedy
    version except as the baseline we deliberately keep around to beat.
14. **One `emptyKm` bucket hides the half we can fix.** Empty movement toward a
    committed pickup is repositioning and largely irreducible; empty movement
    with no load assigned is waste. Folded into a single number they cannot be
    told apart and the chart cannot show progress. Split at the fold: `laden ?
    ladenKm : loadId ? deadheadKm : idleKm`, and keep `emptyKm` as the derived
    sum so nothing downstream breaks.
15. **A load must never be assigned twice.** `planAssignments` is re-run every
    tick against a world that already contains last tick's assignments, so it
    must filter on `status === 'open'` and the fold must reject a
    `load.assigned` for a load already held. Without both, a load ping-pongs
    between trucks and the empty-kilometre count quietly inflates.

---

## Integration (70–90) and deploy (90–105)

1. Lane A merges first. `node scripts/smoke.mjs` must pass.
2. Swap `mockWorld()` for the real store in `App.jsx`. Bind React with
   `useSyncExternalStore` against `store.subscribe` / `store.getVersion` so the
   40-truck map does not re-fold on every render.
3. Wire the sim loop: `setInterval(() => sim.advance(500), 500)`, default 30×.
   Run `planAssignments` on the same tick, before `commit()`, so assignments and
   telemetry land in one batch and the views see a consistent world.
4. Feed live services in: `sim.setIncidents()` and `sim.setFlow()`.
5. `npm run build && npx vite preview` before pushing anywhere.
6. Deploy, then open the URL on an actual phone. Minutes 105–120 are buffer.

---

## Verification

- **Engine:** `node scripts/smoke.mjs` exits 0. This is the merge gate for Lane A.
- **Replay invariant:** `rebuild(store.events)` must reproduce the live world —
  same dwell count, same empty km, same truck count, same load statuses. If this
  breaks, the log has stopped being the source of truth.
- **Empty-mile invariant:** on one fixed seed and one fixed load set, the
  corridor policy must come in under the naive policy. If it does not, the bug
  is in the cost function, not in the sim — say so rather than reseeding until
  the number looks good.
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
- **The empty-mile improvement is a claim about two algorithms, not about real
  fleets.** We control both the policy and the load generator, so a headline
  percentage is not evidence on its own. What is defensible: the load set and
  the seed are held fixed and only the policy varies, which makes the delta a
  real property of the matching. Say that before a judge asks, not after. The
  same caveat goes in the README.
- Auth is seeded and compared in the browser. Prototype-scoped, not an oversight.
- The LLM key ships to the client. Acceptable on a throwaway key for a demo;
  in production this belongs behind a function. Flag it in the README.
- Ontario 511 field casing is unverified against a live response. Normalise
  defensively and check one real payload before demo day.
  