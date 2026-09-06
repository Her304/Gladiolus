# Dispatch — new locations and vehicle assignment

Supplements `plan.md`. Scope: making a newly-posted pickup location a thing the
dispatcher can see and act on, and making vehicle assignment a real decision
rather than something the simulator does to itself.

---

## Where we actually are

The question "are there new locations that need a vehicle assigned?" has a
precise answer in the current build: **no, and nothing could be.**

- **Freight is invented inside the truck.** `src/engine/simulator.js:281-291` —
  when a truck finishes dwelling, a 72% coin flip mints a random `L-xxxx`, marks
  the truck laden, and appends `load.assigned` naming itself. The truck assigns
  its own work.
- **Destinations are self-selected.** `pickDestination` (`simulator.js:115-121`)
  picks a random stop site more than 25 km ahead. No shipper asked for it.
- **There is no `Load`.** `emptyWorld()` (`engine/events.js:10`) has no `loads`
  map; `contract.js` has no `LOAD_POSTED`, no `Load` typedef, no `planAssignments`.
  A `loadId` is a string on a truck and nothing else.
- **The board has no freight surface.** `views/DispatchBoard.jsx` renders map,
  HOS alerts, parking pressure, feed, incidents. There is nothing to click.

So `load.assigned` events do flow past the dispatcher in the feed, which is why
it *looks* like dispatch is happening. It isn't. This is the part of `plan.md`
that was scoped — Lane A steps 2 and 8, traps 13, 14, 15 — and never landed.

Two of the project's headline claims rest on it: the empty-kilometre number, and
the naive-vs-corridor policy toggle that is meant to be the demo's best moment.

---

## The design, in one line

**A new location is a `load.posted` event, and the dispatcher's job is the queue
of posted loads that have no truck.**

Everything else follows from that. The load pool is a fold over the log like
every other view, so a replay reproduces every assignment, and the empty-km
number stays reconstructible rather than asserted.

---

## The one decision worth making deliberately

Who assigns — the solver, or the human?

**Recommendation: the solver assigns every tick; the dispatcher overrides.**

The demo's claim is that a matching algorithm beats the naive baseline. If a
human clicks every load, the measurement is meaningless and the replay stops
being deterministic. But a board where the dispatcher can only watch is not a
dispatch board.

The resolution: `planAssignments` runs on every tick and proposes. Loads that are
feasible get assigned automatically. The dispatcher can **pin** a load to a
specific truck, **hold** a load out of the pool, or **unassign** one — and those
are constraints the solver respects on the next tick, not writes that bypass it.
All three are `load.assigned` / `load.held` events carrying `by: 'corridor' |
'naive' | 'manual'` and an actor, so the audit fold already in place
(`events.js:114`) picks them up for free.

The alternative — every assignment requires a human click — is a legitimate
product, but it costs the policy toggle and the empty-km delta. Not worth it
here.

---

## Work items

Estimates assume one person who has read the codebase. Roughly two hours solo,
one hour if W2/W3 and W6/W7 are split across two people.

### W1 — extend the contract (`src/contract.js`) — 10 min

Do this first and freeze it, same rule as the original contract.

```js
EVENT.LOAD_POSTED    = 'load.posted'      // a new location needs a vehicle
EVENT.LOAD_HELD      = 'load.held'        // dispatcher pulls it from the pool
EVENT.LOAD_UNASSIGNED= 'load.unassigned'  // dispatcher takes a truck off a load

// Load:
//   { id, originId, destId, originChainage, destChainage,
//     readyAt, dueAt, status:'open'|'assigned'|'delivered'|'held',
//     truckId|null, pinnedTruckId|null, postedAt }
//
// World gains: loads:{[id]:Load}, deadheadKm, idleKm
//   emptyKm stays, derived = deadheadKm + idleKm  (trap 14)
```

`LOAD_POSTED` and `LOAD_UNASSIGNED` go in `FEED_TYPES` — a new location arriving
is the single most feed-worthy thing that happens. `mockWorld()` gains three open
loads so the freight panel renders before the engine exists.

### W2 — seeded freight (`src/data/loads.js`) — 15 min

A day's loads between `STOP_SITES`, deliberately asymmetric — thinner westbound,
which is what creates empty miles in the first place. Each load carries
`originChainage` and `destChainage` at construction so matching stays a scalar
subtraction.

Crucially: **loads post over time, not all at once.** Export
`postingsBetween(fromMs, toMs)` so the simulator drips them into the log. That
drip is literally the "new location appears" the question is about — without it
the pool is a fixture that drains and the board goes quiet after two minutes.

### W3 — fold the load lifecycle (`src/engine/events.js`) — 15 min

Add cases to `applyEvent`:

- `LOAD_POSTED` → `world.loads[id] = {...payload, status:'open', truckId:null}`
- `LOAD_ASSIGNED` → **reject if the load is already held by another truck**
  (trap 15 — this runs every tick against a world that already contains last
  tick's assignments). Otherwise set `load.truckId`, `load.status='assigned'`,
  and the truck's `loadId`.
- `LOAD_DELIVERED` → `status='delivered'`, clear both sides.
- `LOAD_HELD` / `LOAD_UNASSIGNED` → status and `truckId` transitions.

And split the kilometre buckets in the `PING` case (`events.js:42-52`), which
today does `laden ? ladenKm : emptyKm`:

```js
if (t.laden)      world.ladenKm    += delta
else if (t.loadId) world.deadheadKm += delta   // repositioning to a committed pickup
else               world.idleKm     += delta   // waste — the addressable half
world.emptyKm = world.deadheadKm + world.idleKm
```

`emptyWorld()` gains `loads: {}`, `deadheadKm: 0`, `idleKm: 0`. Nothing
downstream breaks because `emptyKm` survives as the derived sum.

### W4 — the matcher (`src/engine/dispatch.js`, ~60 lines) — 25 min

```js
planAssignments(world, date, policy) -> [{ truckId, loadId, emptyKm, reason }]
```

- **Candidate trucks:** `loadId === null`, state `driving` or `dwelling`, not
  resting, `clockLeftMs` above a floor.
- **Candidate loads:** `status === 'open'`, `readyAt <= world.clock`, not held.
- **Cost:** `|load.originChainage − truck.chainage|`, plus a backtrack multiplier
  when the pickup is behind the truck, plus a wait-versus-drive term (holding a
  truck 40 minutes beats driving it 90 km empty).
- **Feasibility gate:** the empty leg must fit inside `reachableKm(truck)`
  (`hos.js:37`) — *and* see trap 6 below, because the laden leg matters too.
- **`policy: 'corridor'`** — sort trucks and open loads by chainage, match in
  order, then a 2-opt uncross pass for the pairs the constraints displaced.
- **`policy: 'naive'`** — first free truck takes the next posted load. The
  baseline, kept deliberately so the delta means something.
- Pinned loads are honoured before anything else and removed from both pools.

Pure function, no state. It appends nothing — the caller does.

### W5 — rewire the simulator — 20 min

- **Delete `simulator.js:281-291`.** The truck stops inventing freight.
- On dwell end: if the truck has an assigned load whose origin is *this* site, it
  becomes laden and heads for `destChainage`. Otherwise it heads for its assigned
  pickup, or — with no assignment at all — idles toward the nearest yard,
  accruing `idleKm`. That accrual is the point, not a bug.
- `pickDestination` narrows to the no-assignment case only.
- Each tick: `postingsBetween(prevClock, clock)` → append `LOAD_POSTED`.
- Each tick, **before `store.commit()`** (`runtime.js:19`): run `planAssignments`
  and append the resulting `load.assigned` events, so telemetry and assignments
  land in one batch and every view sees a consistent world.

### W6 — the dispatcher's freight surface (`DispatchBoard.jsx`) — 20 min

This is what actually answers the question on screen.

- **"New freight" panel** above the parking board: open loads ordered by
  chainage, each showing origin site, ready-in, proposed truck and the empty km
  to reach it, with `Assign` / `Reassign` / `Hold`.
- **Origin markers on the map** for open loads — the new location literally
  appearing on the corridor is the visual the demo needs.
- **Policy toggle** and a live `laden / deadhead / idle` readout. Flip it, the
  number moves.
- Extend the existing "Needs a decision" block (`DispatchBoard.jsx:24-35`) with a
  second alert class: **a posted load with no feasible truck.** That is the real
  dispatcher escalation and it currently has no way to exist.

### W7 — the other three surfaces — 15 min

- `DriverView` — next pickup, and the empty km to reach it, so the driver sees
  the number dispatch is optimising.
- `Dashboard` — split the empty bar into deadhead and idle; two-line trend for
  naive vs corridor.
- `CustomerView` — the token can now point at a real `Load` instead of a truck's
  `loadId` string (`App.jsx:96-101`).

### W8 — extend the gate (`scripts/smoke.mjs`) — 15 min

Lane A is not done until these pass:

- No load is assigned to two trucks at once.
- `deadheadKm + idleKm === emptyKm` after replay.
- `rebuild(events)` reproduces the `loads` map exactly — same statuses, same
  `truckId`s. If this breaks, the log has stopped being the source of truth.
- No assignment whose empty leg exceeds `reachableKm(truck)`.
- Every posted load ends `delivered`, `assigned`, or `open` — never orphaned in
  a state nothing can move it out of.
- **Corridor `emptyKm` is strictly below naive `emptyKm` on the same seed and the
  same posting stream.** If it isn't, the bug is in the cost function, not the
  sim — say so rather than reseeding until the number looks good.

---

## New traps, specific to this work

1. **A manual override must be a constraint, not a write.** Set
   `pinnedTruckId` and have `planAssignments` skip the load. Otherwise the next
   tick's solver quietly reassigns it and the dispatcher's click does nothing —
   the most likely single failure in this whole feature.
2. **Assignments must not churn.** A truck already deadheading toward a pickup
   must not be re-matched every 500 ms to a marginally better load. Once
   assigned, it is committed until delivery or an explicit unassign. Without
   this the map thrashes and the deadhead number inflates.
3. **The posting rate has to be visible on demo timescale.** At 30× a load posted
   once an hour appears every two real minutes. Post in small bursts so a judge
   watching for ninety seconds sees at least two arrive.
4. **The policy toggle cannot fairly compare forward-only.** Flipping the switch
   mid-run compares two different stretches of the day, not two policies. Run
   both policies as folds over the *same* posted-load stream for the chart, and
   let the toggle change only live board behaviour. State this in the README —
   it is the difference between a measurement and a demo trick.
5. **A load with no feasible truck is a feature, not an error.** Surface it
   loudly; do not let it silently sit `open` forever. Same reasoning as parking
   trap 8: "nothing can take this" is actionable, silence is not.
6. **Feasibility must include the laden leg.** An empty leg that fits the clock
   but a delivery that doesn't just relocates the forced roadside stop. Gate on
   the empty leg *and* the existence of a reachable rest area near the pickup.

---

## Sequencing

`W1` → `W2` and `W3` in parallel → `W4` → `W5` → `W6` and `W7` in parallel →
`W8`. `W1` blocks everything; `W6` can be built against `mockWorld()`'s new loads
before `W4` exists.

**If time runs short, cut W7.** W1–W6 plus W8 is the whole demo moment: a load
posts, a marker appears on the corridor, the board proposes a truck with an empty
kilometre cost, the dispatcher clicks, and the readout moves.

---

## Stated assumptions

- The solver assigns and the dispatcher overrides — see "the one decision" above.
  If you want human-approval-per-load instead, W4 and W6 change materially and
  the policy toggle has to go.
- The load set is ours, so a headline empty-mile percentage is a claim about two
  algorithms, not about real fleets. Same caveat already in `plan.md`; it applies
  harder once the load generator is explicit.
