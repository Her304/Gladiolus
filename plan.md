# Corridor — build plan

> Revised against *Hackathon Project Brief: City Dispatch Workflow & Fleet
> Automation*. The brief moves the target in ways this plan did not previously
> account for; the gap table below is the honest accounting, and it is the part
> to read first.

## What the brief actually asks for

A **City Dispatch / Regional Freight Platform** for Southern Ontario whose
headline claim is *consolidation*: a dispatcher today pays for and switches
between roughly five disjoint systems — load board, ELD, TMS, quoting, and
maintenance/accounting — and the resulting context-switching costs a single
desk an estimated $15,000–$50,000 a month in missed quotes.

That reframes our pitch. We have been leading with **parking**, which the brief
never asks for. Parking and empty miles are strong differentiators, but they sit
*on top of* a required base, and a judge scoring "does this replace five tools"
will not find that base unless we build it. Lead with consolidation; land
parking as the thing nobody else thought of.

The seven judging criteria, verbatim in substance:

1. **Workflow speed & financial value** — does it eliminate manual overhead, in
   dollars ($15k–$50k/month recovery)?
2. **Geofencing & detention precision** — timestamped arrival/departure records
   driving automated post-2-hour detention billing on FTL runs.
3. **Problem discovery & innovation** — subtle edge cases and hidden pain points.
4. **Mapping & track-and-trace depth** — Southern Ontario coverage, **satellite
   mode**, route breadcrumbs, distance tracking, speed telemetry.
5. **HOS & regulatory logic** — Canadian 13h/14h logbook checks.
6. **Simulation engine & real-time sync** — realism of movement, speed
   variation, dock waits, geofence triggers.
7. **UI/UX** — can it actually replace the fragmented legacy tools?

Two pieces of vocabulary the brief expects us to use correctly: **FTL** is a
full trailer running origin to destination with no intermediate handling;
**LTL** is consolidated part-loads requiring multi-stop routing and terminal
transfers. Our load model is FTL-shaped only. Detention applies to FTL.

---

## Where we stand against the brief

Built and working, as of the current tree: five surfaces, seven engine modules,
`scripts/smoke.mjs` green on seventeen invariants, production build passing.
Measured against the brief, that is a strong simulation engine, a good HOS core,
and roughly half of the dispatcher dashboard.

| # | Brief requirement | Judged under | Status |
|---|---|---|---|
| 1 | Interactive Southern Ontario map | 4 | **Wrong extent** — see geography below |
| 2 | **Satellite view toggle** | 4 | **Missing.** Named twice. ~10 lines |
| 3 | Historical breadcrumbs | 4 | Missing — the data is already in the ping log |
| 4 | Distance/odometer per leg and shift | 4 | Partial — odometer logged, not per-leg |
| 5 | Speed telematics, live and historical | 4 | Partial — logged, never surfaced |
| 6 | Geofence arrival/departure timestamps | 2 | **Have it.** `fence.enter`/`fence.exit` |
| 7 | **Detention billing past 2 h (FTL)** | 2 | **Missing.** Brief calls it *critical* |
| 8 | Automated load matching / backhaul | 1 | Missing — specified here, never built |
| 9 | HOS 13 h driving / 14 h on-duty | 5 | Have it |
| 10 | HOS 16 h elapsed window | 5 | Missing |
| 11 | 10 h off-duty incl. 8 h core rest | 5 | Partial — 10 h reset, no core-rest rule |
| 12 | Cycle 1 (70 h/7 d) / Cycle 2 (120 h/14 d) | 5 | Missing |
| 13 | Axle-weight compliance pre-dispatch | 5 | Missing — no weight model at all |
| 14 | Separated simulation engine | 6 | **Have it.** Our strongest piece |
| 15 | Event generator: delays, dock waits, duty | 6 | Have it |
| 16 | Driver load *acceptance* + duty log | — | Partial — view exists, cannot accept |
| 17 | Multi-system consolidation framing | 1, 7 | Partial — built, never named as such |
| 18 | Financial value in dollars | 1 | **Missing.** No dollar figure anywhere |
| 19 | Edge case: HOS expires in dock queue | 3 | Missing — explicitly invited by brief |
| 20 | Edge case: unexpected 401 closure | 3 | Partial — incidents feed `speedFactorAt` |

The pattern is worth naming: we are strong exactly where the brief is least
prescriptive (simulator, event log) and weak exactly where it is most explicit
(detention, satellite, dollars). Rows 2, 7 and 18 are cheap and directly scored.
They are the first things to build.

---

## The geography problem — needs a decision

This is the one item that cannot be resolved by working harder.

**The brief's region is two-dimensional.** Hubs at London and Milton; bounds at
Barrie (north), Peterborough and Pickering (east), London (west), Niagara Falls
(south); runs distributed across the 401, 403 and 400.

**Our corridor is a line from Windsor to Scarborough.** Windsor, Tilbury,
Chatham, Ridgetown and West Lorne all sit *west of London*, which the brief sets
as the western boundary — so roughly half our corridor is outside the judged
region, and the 403, the 400, the QEW to Niagara and the eastern leg to
Peterborough are all absent.

It also has a consequence we already collided with: the 511 filter was just
tightened to `/\b401\b/` because incidents from the 403, 400 and QEW were
polluting the corridor. **Under the brief those are in scope, not noise.** That
fix is correct for the plan as written and wrong for the brief — whichever way
this decision goes, `on511.js` changes again.

| | A — stay on the 401 spine | B — extend to the brief's region |
|---|---|---|
| Work | Trim west of London, ~30 min | Multi-corridor model, ~2–3 h |
| Chainage architecture | Untouched | Survives *per corridor*, plus junctions |
| Empty-mile matching | Sorted matching stays provably optimal | Sorted per corridor, graph search between |
| 511 filter | Keep the 401-only match | Widen to 401/403/400/QEW |
| Judged under criterion 4 | Scores badly — half the region missing | Scores as asked |
| Honest pitch | "A corridor product, deliberately scoped" | "The region the brief specified" |

**Recommendation: B, structured so it is not a rewrite.** Each highway becomes
its own `measurePath`, sites carry `{corridorId, chainage}` instead of a bare
scalar, and junctions are sites belonging to two corridors. Everything in
`geo.js`, `geofence.js`, `hos.js` and `parking.js` keeps working unchanged
because they all operate on one corridor at a time. What genuinely changes is
load matching: within a corridor it stays a sort, and between corridors it
becomes a short search over junctions.

Note what B costs us rhetorically, because it should be said rather than
discovered on stage: **"the corridor is a line, so the optimal assignment is a
sort" stops being true region-wide.** It remains true per corridor, which is
still a good line, but the clean version of that claim only holds under A.

Until this is decided, everything below assumes the current single corridor and
is written so it does not depend on the answer.

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

This is also the answer to the brief's *System Component 2*, which asks for a
**separated** simulation engine — an independent service emitting coordinates,
speed, distance and HOS state rather than a UI faking motion. Ours is separated
by construction, and the separation is load-bearing rather than decorative: the
simulator cannot read application state, so every number on every surface came
through the log as telemetry. Criterion 6 is the one place we are already ahead
of what is being asked, and it is worth two sentences in the demo rather than
letting it pass as an implementation detail.

---

## The contract

Written first and frozen: the engine implements it, the views read it, and
neither side needs the other to exist to start work. It has already been frozen
once and shipped; the additions below (`Load`, detention, weight, the extra HOS
clocks) are a **deliberate second freeze**, not a drift. Agree them in one pass
rather than one at a time, because every one of them touches the fold.

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
  DOCK_ARRIVE: 'dock.arrive',      DOCK_DEPART: 'dock.depart',
  DETENTION_START: 'billing.detention.start',
  LOAD_ACCEPTED: 'load.accepted',  LOAD_REJECTED: 'load.rejected',
}

// Truck (the observable subset — this is what views may read):
//   id, plate, driverId, driverName, coord:[lat,lon], heading, chainage,
//   direction(1=east|-1=west), speedKph, odometerKm, laden, loadId,
//   destinationId, state('driving'|'dwelling'|'resting'|'docked'),
//   drivingMs, onDutyMs, elapsedMs, cycleMs, insideSiteId, claimedSiteId,
//   parked, tareKg, axleLimitKg
//
// Load:
//   { id, kind('FTL'|'LTL'), originId, destId, originChainage, destChainage,
//     readyAt, dueAt, weightKg, revenue,
//     status('open'|'offered'|'assigned'|'delivered'), truckId }
//
// DockVisit — the detention record. Written from the geofence pair, which is
// why the timestamps are trustworthy rather than dispatcher-entered:
//   { id, truckId, loadId, siteId, arrivedAt, departedAt|null,
//     freeMin, billableMin, amount }
//
// World:
//   { clock, trucks:{[id]:Truck}, loads:{[id]:Load},
//     sites:{[id]:{occupants[],claims[],visits}},
//     dwells:[{truckId,siteId,minutes,at}], dockVisits:[DockVisit],
//     ladenKm, deadheadKm, idleKm, emptyKm,
//     detentionOwed, revenueBooked, missedQuotes }
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

// Detention. FREE_DOCK_MIN = 120 and DETENTION_RATE_PER_HR are the two numbers
// a judge will ask about, so they are named constants, not literals.
detentionFor(visit)      -> { freeMin, billableMin, amount }
detentionLedger(world)   -> { rows: DockVisit[], owed, unbilledRisk }

// Compliance gate. Runs before an assignment is offered, never after.
canAccept(truck, load, world) -> { ok, reasons[] }
  reasons: 'hos-driving'|'hos-duty'|'hos-elapsed'|'hos-cycle'|'axle-weight'

export function mockWorld() { /* 6 trucks + 3 sites + 4 loads, frozen */ }
```

---

## The four portals

Every layout argument is settled by one rule: **each portal answers exactly one
question.** A widget that does not serve its portal's question belongs on a
different portal, however interesting it is.

| Portal | The question it answers | Who opens it |
|---|---|---|
| **Driver** | What do I do right now? | One driver, on a phone, in a cab |
| **Dispatcher** | What needs a human? | One desk, all forty trucks |
| **System** | What did the automation decide, and why? | Anyone auditing the engine |
| **Admin** | What is this system configured to be? | Whoever owns the carrier's setup |

Note what is *not* on that list: "where is everything". Nobody's job is
watching. A map is how you drill into a question, never the answer to one.

---

### 1. Driver portal — "what do I do right now?"

Phone first, one truck, one screen. Its distinguishing property is that **the
emphasis moves with the driver's state** — the same data, reordered, because
what matters at 08:00 is not what matters when the clock is nearly out.

**State A — rolling.** The load leads.

```
┌──────────────────────┐
│ GLD-118    Priya R.  │
│ ───────────────────  │
│ MG-4482              │
│ London → Kitchener   │
│ 110 km · due 15:30   │
│                      │
│ [ Accept ] [ Reject ]│   ← the driver's veto is real
│ ───────────────────  │
│ Driving   4:20/13:00 │
│ Duty     12:15/14:00 │
│ Elapsed  12:15/16:00 │
│ Cycle    48:00/70:00 │
│ ───────────────────  │
│ Rest ahead: Cambridge│   ← present but quiet
└──────────────────────┘
```

**State B — at a dock.** The detention clock leads, because it is the driver's
leverage: they are the one who can escalate while it still matters.

```
│ ⏱ London DC          │
│   Arrived 08:20      │
│   Free time ends     │
│   10:20              │
│   ▓▓▓▓▓▓░░░░  1:52   │
│   [ Report delay ]   │
```

**State C — clock low (under ~90 min).** Parking takes the top and the load
card drops. This is the state that answers the brief's own bonus question: a
driver out of hours needs somewhere legal to stop, and an HOS warning without a
parking answer is half a product.

```
│ 🔴 1:45 driving left │
│ You cannot reach     │
│ Milton.              │
│ ───────────────────  │
│ ONroute Trafalgar    │
│ 18 spaces · 94% full │
│ 1 projected free     │
│ Only option ahead.   │
│ Decide within 40 min │
│ [ Claim a space ]    │
│ ───────────────────  │
│ Behind you:          │
│ Cambridge North      │
```

Never blank this screen because the news is bad. "Trafalgar at 94%, and it is
your only option" is actionable; `null` is not — that is trap 8, on a phone.

Also here, because the brief requires it of the driver interface: the duty log
(ELD) as a readable day, not just four counters.

---

### 2. Dispatcher portal — "what needs a human?"

**The screen should be mostly empty.** A full queue means the automation
failed. That inverts every legacy TMS and it is the first thing to show a judge.

```
┌──────────────────────────────────────────────────────────────────┐
│ Corridor   Detention $1,240 ▲ · Empty km saved 2,610 · Quotes 3  │
├─────────────────────────────────┬────────────────────────────────┤
│ NEEDS YOU                   (0) │  Map            [Road][Sat] ◀── │
│                                 │                                │
│    ✓  Nothing needs you         │      ▰ ▰    ▰                  │
│                                 │        ▰  ▰      ▰   ▰         │
│    38 running · 2 resting       │    ▰      ▰    ▰               │
│    12 loads assigned today,     │       ▰      ▰      ▰  ▰       │
│    all cleared automatically    │                                │
│    → 3 quotes waiting           │                                │
├─────────────────────────────────┤                                │
│ MONEY IN MOTION                 │                                │
│ ⏱ GLD-118  London DC   1:52 ▲   │                                │
│    free time ends 10:20         │                                │
│ ⏱ GLD-127  Cambridge   0:41     │                                │
├─────────────────────────────────┴────────────────────────────────┤
│ FEED  13:05 GLD-118 departed London DC · 2:45 billable           │
└──────────────────────────────────────────────────────────────────┘
```

When something breaks, only the left column changes:

```
│ NEEDS YOU                   (1) │
│ ┌─────────────────────────────┐ │
│ │ 🔴 GLD-118 · Priya Raman    │ │
│ │ Cannot reach Milton.        │ │
│ │ 401 closure · HOS ends      │ │
│ │ 20:00 · ETA 20:30           │ │
│ │ Rest ahead: Trafalgar 94%   │ │
│ │ Milton delivery → 07:00     │ │
│ │ [ Notify customer ]         │ │
│ │ [ Reassign morning load ]   │ │
│ │ [ Override — give reason ]  │ │
│ └─────────────────────────────┘ │
```

Every region earns a criterion, which is how the layout was chosen:

| Region | Judged under |
|---|---|
| Top bar, in dollars | 1 — financial value |
| Needs-you queue | 1, 7 — workflow speed and UX |
| Money in motion (detention *accruing*) | 2 — the critical requirement |
| Map + satellite toggle | 4 |
| Truck drill-down: breadcrumbs, speed, odometer | 4 |
| Feed | 6 — real-time sync |

**Drill-down is where track & trace lives**, one click from a truck, not
crowding the front page: route breadcrumbs, per-leg and per-shift distance, a
speed trace whose flat section is the dock and whose dip is the closure, and the
closed dock record with its billable minutes.

**Two things to remove from what is currently built.** The parking panel — that
is the driver's problem at the driver's moment, and here it is a list nobody has
a reason to read; it should reach the dispatcher only inside a queue card. And
the road-conditions list — 49 rows is noise, so collapse it to a count plus map
markers. A closure earns attention when it breaks a delivery, at which point it
is a card, not a row. Both stay in the engine; they stop competing for the front
page.

On a phone the queue *is* the screen, with map and feed behind tabs. Judges will
open this on their own phones.

---

### 3. System portal — "what did the automation decide, and why?"

**This is the existing Dashboard, repurposed — not a sixth surface.** The other
three portals are workspaces for people. This one is the engine's own console:
it exists so that a claim the automation makes can be checked rather than
trusted. An automation nobody can audit is one nobody will adopt, and that is
the whole hesitation the brief describes carriers as having.

```
┌──────────────────────────────────────────────────────────────────┐
│ SYSTEM        Policy: [ Naive │ ▸Corridor ]   Seed 20260906-A    │
├──────────────────────────────────────────────────────────────────┤
│ EMPTY KILOMETRES                                                 │
│  km ┤                                    ╭─── naive     4,180    │
│     ┤                          ╭─────────╯                       │
│     ┤              ╭───────────╯   ╭──────── corridor   2,610    │
│     ┤   ╭──────────────────────────╯                             │
│     └────────────────────────────────────  saved 1,570 km        │
│        06:00      10:00      14:00      18:00   ≈ $2,355 @1.50   │
├──────────────────────────────────────────────────────────────────┤
│ DECISION LOG                          why this truck, not that   │
│ 13:05  MG-4482 → GLD-118   empty 0 km                            │
│        runner-up GLD-124, empty 62 km · rejected: further        │
│        GLD-131 excluded: HOS 0:40 left                           │
│        GLD-107 excluded: axle weight 21,200 > 19,500             │
│ 12:40  MG-4477 → GLD-124   empty 18 km                           │
├──────────────────────────────────────────────────────────────────┤
│ DETENTION LEDGER (closed)        │ DWELL LEAGUE   │ UTILISATION   │
│ GLD-118 London DC  2:45  $206 ▲  │ London DC 214m │ ▰ driving 31  │
│ GLD-127 Cambridge  0:00     —    │ Cambridge 96m  │ ▰ dock     7  │
│ Owed today               $1,240  │ Woodstock 41m  │ ▰ resting  2  │
└──────────────────────────────────────────────────────────────────┘
```

The decision log is the point. **Every assignment records the runners-up and the
exclusions**, so "why did truck 118 get that load" has an answer on screen
instead of in someone's head. It costs almost nothing — `planAssignments`
already computes the losing candidates on its way to the winner; it just has to
stop throwing them away.

The policy toggle belongs here rather than on the dispatcher's screen: it is an
argument about the engine, not a lever anyone operates during a shift.

---

### 4. Admin portal — "what is this system configured to be?"

Built already, five tabs — **Access**, **Fleet**, **Sites**, **Integrations**,
**Audit** — and the framing is right: it sits *above* dispatch rather than
beside it, and nothing on it dispatches anything.

What the brief adds is a clean rule for what may be edited:

> **Editable: commercial terms we chose. Read-only: law, physics, or a stated
> assumption.**

| Setting | | Why |
|---|---|---|
| Detention rate per hour | **edit** | A commercial term; a judge will ask where the dollars came from |
| Free dock window (2 h) | **edit** | The brief's default, but it is a contract term, not a law |
| Cost per empty km | **edit** | Ours; it prices the whole empty-mile claim |
| Missed-quote value | **edit** | The brief gives a $1,000–$7,000 range, not a number |
| **Cycle 1 (70 h/7 d) or Cycle 2 (120 h/14 d)** | **edit** | The brief names both — it is a *carrier-level* choice, which is exactly this console's job |
| Axle limit per truck | **edit** | Equipment fact, varies per unit |
| Parking capacity | **edit** | Already live; `pressureFor` reads it every call |
| HOS hour limits (13/14/16/10) | *read-only* | Federal law. An editable legal limit is a compliance product lying |
| Fence radii | *read-only* | The simulator sizes its sub-step from the smallest fence at construction; editing under a running sim lets trucks step over geofences (trap 3) |
| `FLEET_SHARE` | *read-only* | A stated assumption, surfaced so it is arguable, not tuned until the demo looks good |

A console that offered the read-only inputs anyway would be lying about what it
controls — and the console should say which of the two any given field is,
inline, rather than leaving the user to discover it by trying.

**Audit** stays as built: every administrator action appended to the log like
any other event, so the trail costs a fold rather than a table, and config
changes land in the dispatcher's feed alongside everything else. A config change
applied as a side effect would be the one thing in the system nobody could
reconstruct by replaying.

---

### The customer link — "where is my freight?"

Read-only, one load, no sign-in. Worth one deliberate decision: **if detention
is accruing, show the customer their own clock.** It is their dock causing it
and their invoice at the end, and a live counter turns a month-end billing
dispute into a fact both sides watched happen. That is a small feature with a
disproportionate amount of the brief's "hidden pain point" in it.

---

### The same fact, four framings

Detention appears on every surface and means something different each time.
This is the rule at the top of this section doing its work:

| Portal | How detention appears |
|---|---|
| Driver | A clock they can escalate against, while at the dock |
| Dispatcher | An alert the moment it *starts* costing, not when it ends |
| System | A closed ledger, totalled, auditable |
| Customer | Their own clock, running, before the invoice |

---

## Remaining work, ranked by judged value ÷ cost

The three-lane split that built this is spent — the code exists and file
ownership no longer needs policing. What follows is ordered by how much it moves
a judging criterion per minute spent, which is a different order from how
interesting the work is.

### Tier 1 — cheap and directly scored (do these first)

1. **Satellite toggle** (criterion 4, ~10 lines). Leaflet `LayersControl` with
   Esri World Imagery as the second base layer — no key, no new dependency. The
   brief names satellite mode twice, and the reason it gives is real: a
   dispatcher inspects dock layouts and yard access before routing a truck into
   an industrial park. Point the demo at a Milton yard and say that out loud.
2. **Detention billing** (criterion 2, the brief's one *critical requirement*,
   ~40 min). We already write the hard part: `fence.enter`/`fence.exit` at stop
   sites are exactly the timestamped arrival/departure records the brief asks
   for. What is missing is the arithmetic and the surface —
   `billableMin = max(0, dwellMin − 120)` at FTL docks, an amount, and a ledger
   panel. Two things to get right: detention applies at **stop sites, not rest
   areas** (a truck sleeping ten hours at an ONroute is not billable), and the
   ledger must show *accruing* visits, not just closed ones, because the money
   is lost by not noticing in time.
3. **Dollars on the dashboard** (criterion 1, ~20 min). Every existing metric
   has a price the brief supplies: detention owed, deadhead km × cost/km, and
   missed quotes at $1,000–$7,000 each. Criterion 1 is scored in dollars and we
   currently show none. Stat tiles, not a new chart.

Tier 1 is roughly 75 minutes and touches three of the seven criteria.

### Tier 2 — substantial and scored

4. **Load matching / backhaul** (criteria 1 and 3). Specified in the contract
   above and still unbuilt: `data/loads.js`, `engine/dispatch.js`, the
   `deadheadKm`/`idleKm` split, the naive-vs-corridor toggle. The brief asks for
   it by name — "proximity-based load matching that automatically queues a
   return LTL or FTL load" — and its example is precisely backhaul pairing: a
   Milton-to-London delivery matched with a London-to-Kitchener return. Note
   Kitchener is not in our site list; the brief's own example does not fit our
   current map, which is the geography problem in one sentence.
5. **Complete the HOS model** (criterion 5). We have 13 h driving and 14 h
   on-duty. The brief also specifies the **16-hour elapsed window** since the
   last 8-hour rest, the **8-consecutive-hour core** inside the 10 off-duty, and
   **Cycle 1 (70 h/7 d) / Cycle 2 (120 h/14 d)**. The elapsed window is the
   interesting one: it can expire while a truck is stationary, which no other
   clock we model does.
6. **Axle-weight gate** (criterion 5). Give trucks a `tareKg` and `axleLimitKg`,
   loads a `weightKg`, and refuse the assignment before it is offered. The brief
   pairs weight with HOS as one pre-dispatch audit; `canAccept` returns both
   kinds of reason from one call.
7. **Track & trace depth** (criterion 4). Breadcrumbs, per-leg distance, and a
   speed trace are all folds over pings we already store. This is the cheapest
   *looking* item in tier 2 and the one most likely to be judged on polish.

### Tier 3 — the bonus round

8. **Edge cases the brief explicitly invites** (criterion 3, "elevates your
   project score"). Two are named, and we are close on both:
   - *A driver runs out of HOS while sitting in a dock queue.* We model forced
     roadside stops but not this. It is the better story: the truck is legal,
     parked, and safe, and still becomes undispatchable because someone else's
     dock was slow. It also ties detention to compliance — the same wasted hour
     bills the shipper and burns the driver's clock, which is the kind of
     connection the brief means by "hidden pain point".
   - *An unexpected 401 closure.* Incidents already feed `speedFactorAt`. What
     is missing is the response: a full closure should re-plan, not just slow
     the truck down.
9. **Name the consolidation** (criteria 1 and 7). The brief's frame is five
   tools replaced by one. We have built load board, ELD, TMS and detention
   tracking into a single surface and never said so. A one-screen "what this
   replaces" panel, with the brief's own monthly costs beside it, is a
   twenty-minute build that speaks directly to the top-billed criterion.

### Explicitly not doing

Deployment, code-splitting, per-module unit tests, the 511 rest-area endpoint,
and a routing/ETA API (`VITE_ROUTING_KEY` is declared and unused — either wire
it or delete it, but do not leave a key named for a feature that does not
exist). None of these are scored. Deployment is the only one that would hurt to
skip, and only because a judge cannot open a URL that does not exist.

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
16. **Detention must not inherit trap 4's fix.** Trap 4 taught us to discard
    geofence pairs shorter than `DWELL_THRESHOLD_MIN` as drive-throughs. Apply
    that to docks and a genuine 8-minute unload vanishes from the billing
    record. The threshold exists to keep the *dwell league table* honest; the
    detention ledger wants every pair at a stop site, however short. Same
    events, two different folds, and only one of them may filter.
17. **Detention accrues before it is billable.** A visit sitting at 90 minutes
    owes nothing yet and is the most valuable row on the screen, because that is
    the last moment a dispatcher can still do something about it. A ledger that
    only lists closed, past-threshold visits reports history rather than
    preventing loss — which is the exact failure the brief is describing.
18. **The 16-hour elapsed window expires while parked.** Every other clock we
    model advances with driving or duty. This one runs on wall time since the
    last 8-hour rest, so a truck can sit legally in a dock queue and become
    undispatchable without moving. Any code that only recomputes HOS on
    movement will miss it — and missing it is precisely the edge case the brief
    invites us to find.
19. **Rest areas are not docks.** Detention, dwell league and parking pressure
    all read the same `fence.enter`/`fence.exit` stream but mean different
    things by it. Branch on `site.kind` in every one of them, or a ten-hour
    legal reset at an ONroute turns into a five-figure detention invoice.

---

## Integration notes (still current)

The wiring below already exists and is worth not breaking:

1. `App.jsx` binds React through `useSyncExternalStore` against
   `store.subscribe` / `store.getVersion`, so a 40-truck map does not re-fold on
   every render.
2. The sim loop is `setInterval(() => sim.advance(500), 500)` at 30× default.
   Anything new that writes events — `planAssignments`, detention accrual —
   runs on that same tick **before** `commit()`, so one batch produces one
   notify and the views never see a half-updated world.
3. Live services feed in through `sim.setIncidents()` and `sim.setFlow()`.
4. `npm run build && npx vite preview` before pushing anywhere. Then open it on
   an actual phone, not just localhost.

Deployment remains undone: no remote, no host, no URL. It is not a judging
criterion, but judges opening the demo on their own phones was the original
premise, and that premise currently fails.

---

## Verification

- **Engine:** `node scripts/smoke.mjs` exits 0. This is the merge gate, and it
  grows with each tier: detention arithmetic bounded and never negative; a
  ten-hour rest-area stay produces no detention row; a short dock visit still
  produces one; the 16 h elapsed window fires on a stationary truck; and
  `canAccept` refuses on every reason it claims to check.
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
- Ontario 511 field casing is **verified**, not assumed: a live pull returned 469
  province-wide records with all nine fields present and PascalCase. The
  lowercase fallbacks in the normaliser stay as insurance.
- Corridor filtering is geometry **and** road name. Proximity alone admitted 44
  incidents from HWY 3, HWY 4, the 403, the 427 and the QEW, which then became
  phantom speed penalties on the 401. **This is scoped to the current single
  corridor.** Under the brief's region the 403, 400 and QEW are in scope, and
  this filter has to widen rather than tighten.
- **Detention rates are illustrative.** The brief supplies the 2-hour free
  window; the hourly rate is ours. Show it as a named, editable constant in the
  admin console rather than burying it, so the arithmetic is inspectable even
  though the rate is invented.
- **"Database" in the brief means persistence; ours is a tab.** The brief asks
  repeatedly for timestamps recorded *in the database*. Our append-only log is
  in memory and dies with the page, which is fine for a demo and is exactly the
  question a judge will ask about detention records. The honest answer is that
  the log is the schema and persisting it is a storage adapter, not a redesign —
  worth being able to say in one sentence.
  