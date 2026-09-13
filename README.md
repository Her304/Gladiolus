# Corridor

Fleet telemetry for the Highway 401 corridor, Windsor to Toronto. Forty trucks,
five surfaces, one append-only event log.

```bash
npm install && npm run dev
```

Then open http://localhost:5173. No API keys, no `.env`, no network required —
every keyed service falls back to a bundled fixture.

**Demo credentials.** Dispatch: `dispatch@gladiolus.ca` / `corridor`. Admin:
`admin@gladiolus.ca` / `corridor`. Driver: any truck number `GLD-101`…`GLD-140`
with its seeded PIN (the sign-in form pre-fills a working pair). The customer
tracking link is generated from the dispatch topbar.

| Surface | Route | Who |
|---|---|---|
| Dispatch board | `#/board` | dispatch, admin |
| Dashboard | `#/dashboard` | dispatch, admin |
| Admin console | `#/admin` | admin |
| Driver | default | driver |
| Customer tracking | `#/t/<token>` | public, no sign-in |

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
| `src/engine/scales.js` | The same model, pointed at inspection stations |
| `src/engine/inspection.js` | Daily trip inspections, as a fold |
| `src/engine/breakdown.js` | Open breakdowns and the vendor book |
| `src/engine/simulator.js` | The physical model |
| `src/engine/metrics.js` | Dashboard folds |
| `src/services/` | Ontario 511, TomTom, the LLM layer |
| `src/admin/settings.js` | Administrator overrides on corridor configuration |
| `src/admin/audit.js` | Administrator actions, appended to the log like any other event |

### The admin console

The fifth surface sits *above* dispatch rather than beside it. Dispatch answers
"what should this truck do in the next hour"; the console answers "what is this
system configured to be", so nothing on it dispatches anything. Five tabs:
**Access** (the seeded directory and roles), **Fleet** (all forty trucks, the
board's six in full), **Sites** (corridor configuration), **Integrations**
(feed sources, key presence, engine constants), **Audit** (the administrator
trail and a filterable inspector over the raw log).

It writes exactly one class of thing — parking capacity — and that write is
genuinely live: `pressureFor` reads `site.spaces` on every call, so an edit
moves the parking board, the map colours and the recommender on the next tick.
Overrides persist to `localStorage` and are applied in `runtime.js` before the
simulator boots.

Every administrator action is appended to the event log rather than applied as a
side effect, which is not decoration — a config change that mutated state
without an event would be the one thing in the system nobody could reconstruct
by replaying. It also means the audit trail costs a fold rather than a table,
and the dispatcher sees config changes land in the same feed as everything else.

Fence radii, HOS limits and `FLEET_SHARE` are shown but deliberately read-only.
The simulator sizes its sub-step from the smallest fence when it is constructed,
so editing a radius underneath a running sim would silently let trucks step over
geofences; the rest are frozen constants that `scripts/smoke.mjs` asserts
invariants in terms of. A console that offered those inputs anyway would be
lying about what it controls.

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
- **The admin console is gated by a client-side `if`.** The role comes from a
  seeded account object compared in the browser and kept in `localStorage`, so
  anyone who can open devtools can reach it. It is a layout of what an admin
  surface would own, not an access control — and the console says so on its own
  first screen rather than only here. The first thing production needs is the
  role decided server-side, next to the data it guards. The audit trail has the
  same problem from the other direction: the log is in memory, so it survives
  exactly as long as the tab, and an administrator can clear their own trail
  with F5.
- **The LLM key would ship to the client.** Fine on a throwaway key for a demo,
  wrong in production, where this belongs behind a function. With no key set,
  every AI feature returns a cached response.
- **Ontario 511 does not reliably send CORS headers.** `vite.config.js` proxies
  `/api/511` in development. A static production build has no such proxy, so it
  runs on the bundled fixture unless you put a serverless function in front of
  it. Field casing has been verified against a live payload: all nine fields the
  normaliser reads are present and PascalCase across all 469 province-wide
  records.
- **Corridor filtering needs the road name, not just proximity.** The 401 runs
  within a few kilometres of HWY 3, HWY 4, the 403 and the QEW, so distance to
  the polyline alone admits other highways' incidents — 93 records pass the
  12 km test where only 49 are on the 401. Both tests are applied.
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
| `VITE_ROUTING_KEY` | Reserved for future predictive ETA | Driver road routing still works |

TomTom is sampled at eight fixed points every three minutes — roughly 1,280
calls a day against a 2,500 free-tier ceiling. Ontario 511 is free and key-free
and is cached for five minutes, well inside its ten-calls-a-minute limit.

### Interactive driver portal

Open `/#/driver-demo/today` for the interactive tour or `/#/driver` for the
seeded truck/PIN sign-in. The scenario selector covers rolling, load offers,
dock waits, low hours, rest, start of shift and a breakdown. Each scenario starts a fresh, isolated session;
it never changes the main fleet. Demo actions and telemetry live in the event
log and reset on refresh. Notification preferences are saved per truck on this
device. Driver requests are recorded in an in-app event feed, not sent by email
or SMS. Document storage is not connected.

The signed-in driver portal reads the main fleet telemetry. Parking choices
update the simulator and shared event log; a manual release pauses automatic
reclaiming for five simulated minutes. The existing live engine has no load-offer
queue, elapsed clock or cycle total: those are demonstrated by the isolated
scenario model, and unavailable live counters are shown as unavailable.
Every driver page uses the same swipeable content-and-navigation island: pull it
down for the full map, or up for the page view. On desktop that island stays on
the right while the map uses the full canvas. Route geometry is road-snapped by
the local `/api/route` OSRM proxy in development, with a bundled detailed Highway
401 trace as the offline/static-build fallback.

#### Beyond parking

Four things sit alongside parking under the **Ahead** tab and the duty log.

**Facilities** are static reference data on each rest area — washrooms, showers,
food, overnight, pull-through. They qualify a stop rather than list one, because
a driver settles parking first and amenities second, so they render as chips on
the stop card and as a tail on the parking row.

**Inspection stations** reuse the parking trick. No feed says whether an MTO
scale is open, but an open station is visible in our own telemetry: every truck
that passes one must enter it. The estimator counts trucks decelerating within
3 km of a station — but only *relative to the ambient speed of the fleet on the
same stretch*. That control is the whole point. Congestion slows trucks too, and
a bare speed threshold would report every traffic jam as an open scale; when
ambient speed itself collapses, nothing is inferred, because in gridlock the
signal genuinely is not there. Confidence, sample size and the time-of-day prior
are all shown on the detail screen for the same reason `FLEET_SHARE` is.

**Roadside service** is a short vendor book keyed to stretches of corridor, not a
"repair shops near me" search. A driver on a live shoulder needs the one number
the carrier will pay, not ten options to evaluate. The feature that matters is
the breakdown report: one tap puts position, load and remaining hours in front of
a dispatcher, and routes to a vendor who covers that kilometre for that fault,
with a backup for when the first cannot come out. Every category at every
kilometre of the corridor reaches somebody — the smoke suite asserts it, because
a dead end there is a dead end where a driver can least afford one.

**Daily trip inspections** (Schedule 1, O. Reg. 199/07) are the one driver
feature a fleet app cannot treat as optional. A major defect puts the truck out
of service and the Today screen leads with it. One deliberate restraint: a truck
with *no* record is prompted, never blocked. An empty log means this portal has
not seen an inspection, not that the driver failed to do one, and asserting a
legal violation from absent data would be the worst possible place to start —
the same discipline as "no earlier history is inferred" in the duty log.

**Incidents** were already fetched, already filtered to the 401 and already
folded into the simulator's edge weights. The driver was simply never shown them.

Fuel is deliberately absent. A tractor does not use gas stations, fleet fuelling
is a card-network and tax decision made by dispatch rather than a driver, and a
363 km corridor is inside a single tank either way.

`node scripts/driver-smoke.mjs` checks load acceptance/rejection/expiry,
parking claims and releases, request validation and event replay, including
parking actions against the main simulator. It also covers facility data
integrity, the prompt-versus-block inspection rule and major-defect clearing,
vendor coverage across every fault and kilometre, the scale estimator's
congestion control and carriageway filter, and incident direction filtering.
