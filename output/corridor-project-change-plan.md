# Corridor Project Change Plan

Source assessment: `output/corridor-project-assessment.md`  
Prepared: 13 September 2026

## 1. Required product change

Corridor should change from a browser-local Highway 401 telemetry and parking
prototype into a **shared city-dispatch exception workflow** for Southern
Ontario.

The product's central workflow must become:

> shipment intake → feasibility check → assignment → driver acknowledgment →
> stop execution → delay/exception response → detention calculation → billing
> export

Parking remains part of the product, but as a safety and recovery tool when a
dock delay, closure, or low-hours condition threatens the plan. It should no
longer be the primary organizing idea.

The first complete demonstration should answer one operational question:

> If a stop takes longer than expected, what happens to the driver's hours, the
> next assignment, the customer ETA, the detention claim, and the safe stopping
> plan?

## 2. What to retain, change, and defer

### Retain

- The separation between physical simulation and observable events.
- The append-only event model and replayable projections.
- Geofence hysteresis and subdivided movement.
- The current driver portal interaction patterns.
- Ontario 511, traffic-flow, parking, inspection, and breakdown work as
  supporting signals.
- Explicit labels for live, cached, estimated, and fixture data.

### Change immediately

- Make shipments, stops, offers, assignments, visits, detention claims, and
  exceptions durable domain records.
- Move the authoritative event log and decision logic out of each browser and
  behind a shared server API.
- Separate arrival, check-in, service start, service completion, delivery, and
  gate-out semantics.
- Make HOS, major defects, and closures authoritative feasibility blockers.
- Replace random self-assignment with an open-load queue and controlled
  assignment lifecycle.
- Bind customer tracking to a shipment, not to whichever destination a truck
  currently has.
- Expand the map and route model to the brief's Southern Ontario region.

### Defer until the trustworthy FTL workflow is complete

- Full LTL manifest, cube, pallet-position, stackability, and freight-access
  optimization.
- Claims that Corridor is a certified ELD or a full accounting/TMS replacement.
- Automated detention for every customer contract without human review.
- Guaranteed parking availability.
- ROI claims that are not supported by a measured carrier baseline and pilot.

## 3. Non-negotiable system rules

These rules should be agreed before implementation because they determine the
contract, projections, UI states, and tests.

1. **The server is authoritative.** Browsers are clients, not separate fleet
   worlds. Dispatcher and driver sessions must observe the same event sequence.
2. **Every operational command is idempotent.** Retries must not create a
   second visit, assignment, charge, or driver request.
3. **Observations preserve provenance.** Store provider/event identifier,
   schema version, observed time, received time, and source.
4. **Unknown is not safe.** Missing or stale HOS, vehicle, route, contract, or
   appointment data produces an unresolved decision, never an affirmative
   feasible result.
5. **Presence is not completion.** A geofence crossing may support a milestone;
   it must not silently mean delivered or billable.
6. **Safety gates act before movement and assignment.** HOS exhaustion, a major
   defect, an immobilizing breakdown, or an impassable route must prevent the
   transition rather than create an alert after it.
7. **Commercial rules are versioned.** Appointment history, free time, rates,
   rounding, exclusions, waivers, and contract versions remain reconstructible.
8. **Automation is explainable and reversible.** Assignment, detention, ETA,
   and parking recommendations show their inputs, confidence, and blocking
   reasons; corrections retain the original record and actor.
9. **One shipment cannot be double-booked.** Reservation and assignment use
   atomic version checks.
10. **The simulation is a data source, not a shortcut.** It emits the same
    commands and observations expected from real integrations.

## 4. Target domain contract

Freeze a second version of the contract before changing screens. At minimum it
needs the following records.

| Record | Minimum responsibility |
| --- | --- |
| `Shipment` | Stable customer-facing identity, FTL/LTL kind, commercial terms, status, and proof references. |
| `Stop` | Shipment-linked ordered pickup/delivery, appointment history, equipment/service requirements, and current milestone. |
| `LoadOffer` | Candidate driver/truck, expiry, feasibility snapshot, response, and reason. |
| `Assignment` | Atomic reservation and committed driver, tractor, trailer, route, version, actor, and status. |
| `FacilityVisit` | Queue arrival, gate/check-in, service start, service complete, and gate-out with evidence and uncertainty. |
| `DetentionRule` | Contract version, charge boundary, free time, rate, rounding, exclusions, and currency. |
| `DetentionClaim` | Calculated minutes and amount, evidence, review state, adjustments, waiver, export, and payment reconciliation. |
| `DutySnapshot` | Driving, on-duty, elapsed, daily off-duty, cycle totals, regime, source, and freshness. |
| `VehicleAvailability` | Inspection/defect/breakdown state and the reason the unit is available or blocked. |
| `RoutePlan` | Ordered traversable edges, service/travel/rest budget, closures, legal approaches, and plan version. |
| `ExceptionCase` | Shared operational issue, affected records, severity, owner, acknowledgment, resolution, and audit history. |
| `TrackingGrant` | Signed, shipment-scoped, expiring/revocable customer access. |

The event vocabulary should distinguish at least:

- shipment posted, changed, cancelled, and completed;
- stop arrived, checked in, service started, service completed, and departed;
- offer created, expired, accepted, and rejected;
- assignment reserved, committed, unassigned, and conflicted;
- duty state updated and marked stale;
- vehicle blocked and cleared;
- route invalidated and replanned;
- detention eligibility detected, calculated, reviewed, adjusted, waived,
  exported, and reconciled;
- exception opened, acknowledged, assigned, and resolved.

Do not preserve `load.delivered` at fence entry. Delivery/service completion
must be its own confirmed milestone, and the load must stay associated with its
stop while detention evidence is being accumulated.

## 5. Delivery phases

### Phase 0 — Freeze semantics and protect the existing foundation

**Goal:** prevent new UI work from depending on incorrect event meanings.

Changes:

- Add a versioned domain/event contract in `src/contract.js` or a dedicated
  shared contract module.
- Document state machines for shipment, stop, assignment, visit, claim, duty,
  vehicle availability, and exceptions.
- Add deterministic fixtures for normal delivery, 119-minute dwell,
  150-minute dwell, early arrival, waiver, dock HOS expiry, closure, major
  defect, duplicate event, delayed event, and assignment race.
- Split event time from receipt time and define ordering/correction rules.
- Stop treating old planning documents as evidence of shipped capability; mark
  this file as the implementation source of truth.

Acceptance gate:

- Every state transition has allowed predecessors, required data, idempotency
  behavior, and an explicit failure result.
- Existing smoke tests still run, and new failing tests reproduce the unsafe or
  incorrect cases identified by the assessment.

### Phase 1 — Durable shared runtime

**Goal:** make one authoritative fleet visible from separate dispatcher and
driver sessions.

Changes:

- Add a server-side application boundary for commands, events, projections,
  authentication, and integration secrets.
- Store operational events and versioned reference/configuration records in a
  durable database. Use PostgreSQL for a pilot deployment; a local development
  adapter may use SQLite if it preserves the same constraints.
- Add unique provider-event and idempotency keys, optimistic versions, and
  transactions for conflicting commands.
- Publish committed changes to clients using WebSocket or server-sent events;
  reconnect from the last acknowledged sequence.
- Move simulator execution to a single service process that writes through the
  same ingestion API as external telemetry.
- Replace localStorage configuration mutation with server-side versioned
  configuration events.
- Show connection state and data age on every decision surface.

Acceptance gate:

- A dispatcher and driver in different browser sessions see the same assignment
  and exception.
- Refresh/restart preserves shipments, visits, claims, configuration, and audit
  history.
- Retried and out-of-order observations do not duplicate or regress state.
- Two clients racing to reserve one shipment produce one winner and one visible
  conflict.

### Phase 2 — Shipment, stop, and detention workflow

**Goal:** deliver the brief's highest-value end-to-end workflow.

Changes:

- Add shipment intake and ordered FTL stops with stable identifiers.
- Change the simulator so arrival, queue, check-in, service, completion, and
  departure occur independently.
- Make long visits deliberate in normal deterministic scenarios, including one
  that exceeds the configured free time.
- Implement contract-driven detention calculation with an explicit default
  two-hour live-FTL demonstration rule.
- Show evidence, calculated boundary, free minutes, billable minutes, rate,
  rounding, amount, and uncertainty in a detention ledger.
- Add review, correction, waiver, approval, export, and reconciliation states.
- Exclude parking/rest stays, carrier-caused delays, transits, and uncertain
  visits from automatic charging until reviewed.
- Preserve appointment changes and every manual edit with actor and reason.

Dispatcher UI:

- Add an exception queue led by stops approaching free time, claims awaiting
  review, and missing evidence.
- Add a shipment/stop timeline that joins GPS evidence, duty state, driver
  actions, appointment changes, and billing events.
- Add an exportable detention evidence package suitable for the selected billing
  destination.

Driver UI:

- Replace the isolated dock timer with the main shipment visit.
- Show the operational milestone, elapsed visit time, remaining free time, HOS
  risk, requested action, and dispatch acknowledgment.
- Never let the countdown hide a more urgent safety instruction.

Acceptance gate:

- A 119-minute qualifying visit creates no billable time.
- A 150-minute qualifying visit creates 30 billable minutes before the stated
  rounding rule.
- The record survives refresh and can be exported with its evidence.
- Early arrival, service completion before gate-out, an approved waiver, and a
  parking/rest stay each produce the contract-correct result.

### Phase 3 — Authoritative feasibility and safety

**Goal:** ensure unsafe or unknown states cannot be recommended or executed.

Changes:

- Replace the two-counter HOS helper with a supported Canadian regime model:
  driving, on-duty, elapsed shift window, daily off-duty/core rest, Cycle 1 or
  Cycle 2, applicable exemptions, source, and freshness.
- Return `feasible`, `infeasible`, or `unresolved`; do not default missing fields
  to zero.
- Estimate an assignment using travel, loading/unloading, queue uncertainty,
  appointments, and travel to a verified safe stopping place.
- Add a pre-movement guard to the simulator and command handler. Remove the
  transition that begins driving and only stops on the next tick.
- Make major defects and immobilizing breakdowns remove the vehicle from
  available capacity until an authorized resolution is recorded.
- Represent a full mainline closure as an impassable route edge. Distinguish
  direction, schedule, ramp, lane, and mainline effects from Ontario 511.
- Remove optimistic speed floors from legal reach calculations; use bounded
  forecasts with confidence and contingency.
- Validate parking direction/legal approach and describe availability as an
  estimate, not a reservation.

Acceptance gate:

- Missing HOS history never produces a feasible assignment.
- Elapsed or cycle exhaustion blocks an offer even when driving hours remain.
- A driver whose duty expires at a dock does not move; the affected assignment
  is withdrawn or escalated and a resolution is recorded.
- A major defect prevents movement and assignment.
- A mainline closure invalidates the route, while a ramp-only closure is applied
  only when the planned access uses it.

### Phase 4 — Real load queue and assignment lifecycle

**Goal:** replace random self-created loads with actual dispatch work.

Changes:

- Add an open shipment/load queue with ready time, appointment, service time,
  equipment, payload, revenue/contribution inputs, and origin/destination.
- Stop trucks from inventing freight or assigning themselves after a dwell.
- Implement feasibility filtering first, then rank only feasible candidates.
- Create expiring offers, atomic reservations, driver accept/reject, manual hold,
  reassignment, cancellation, and dispatcher override with audit reasons.
- Prevent assignment churn; a committed truck stays committed until an explicit
  transition changes it.
- Split empty distance into committed deadhead and uncommitted idle/repositioning
  distance.
- Surface loads with no feasible candidate as exceptions rather than leaving
  them silently open.
- Connect the existing driver offer experience to this main-fleet lifecycle and
  remove the isolated scenario as evidence of live capability.

Acceptance gate:

- One posted load appears in dispatch, receives a versioned offer, is accepted
  by the driver in another session, and becomes one committed assignment.
- A second dispatcher cannot double-book it.
- Travel plus service plus safe-shutdown feasibility is recorded with the
  decision.
- Replay reproduces the load, offer, assignment, and kilometre buckets exactly.

### Phase 5 — Regional map, history, and customer truth

**Goal:** cover the geography and investigation workflows explicitly required by
the brief.

Changes:

- Replace the single chainage line with a small road graph covering London and
  Milton hubs and routes toward Barrie, Peterborough/Pickering, and Niagara
  Falls using the 401, 403, 400, QEW, and required connectors.
- Keep per-corridor measured paths where useful, but use graph routing between
  corridors and junctions.
- Widen and correct traffic normalization for documented direction variants,
  geometry, schedules, restrictions, and roadway type.
- Add a satellite basemap toggle with source attribution.
- Add historical truck breadcrumbs with time, speed, distance, source, and data
  age; support leg/shift drill-down.
- Store and display shipment-scoped ETA. Include planned stops, HOS/rest,
  service, traffic, and uncertainty; never claim inputs the model did not use.
- Sign, expire, revoke, and scope customer links to one shipment history.

Acceptance gate:

- The demonstration routes across the named Southern Ontario branches.
- A user can switch basemaps and investigate one historical leg and stop.
- Reassignment does not expose the truck's next customer's shipment.
- ETA qualifications match the inputs actually used.

### Phase 6 — Integration, security, and operational ownership

**Goal:** make the workflow pilotable without claiming to replace systems that
remain authoritative.

Changes:

- Integrate one order source, one authoritative ELD/vehicle source, and one
  billing export destination.
- Create explicit identity mapping for carrier, driver, tractor, trailer,
  shipment, stop, customer, and facility.
- Add ingestion health, freshness, deduplication, retry, correction, and
  reconciliation queues.
- Move credentials and optional LLM calls behind the server.
- Replace seeded browser auth with server-enforced roles and shipment-scoped
  customer authorization.
- Give every driver request and operational exception an acknowledgment, owner,
  status, deadline, and resolution.
- Ground AI output in the same per-record evidence used by the UI. If required
  evidence is absent, return an explicit limitation instead of named advice.

Acceptance gate:

- A shipment imported from the selected source can be assigned using fresh ELD
  state and exported as a reviewed detention charge.
- Integration failure preserves last-known data with age and opens a visible
  reconciliation item.
- Unauthorized clients cannot read or change another role's or shipment's data.

### Phase 7 — Pilot validation and later differentiation

**Goal:** establish financial and operational value with evidence.

Changes:

- Run a matched baseline and assisted pilot by lane, weekday, freight type, and
  fleet exposure.
- Track manual touches/check calls per load, quote response time, feasible loads
  accepted, eligible detention found/invoiced/disputed/collected, claim-prep
  time, avoidable empty kilometres, failed parking arrival, and infeasible
  recommendations by cause.
- Report collected contribution and avoided operating cost separately from
  booked revenue or freed staff time.
- Calibrate parking estimates against independent observations before presenting
  them as a differentiated prediction feature.
- Start the fuller LTL model only after FTL state, safety, synchronization, and
  billing behavior are stable.

Acceptance gate:

- Product claims quote measured pilot results with sample, baseline, exposure,
  and limitations.
- No benefit is counted twice, and invoiced detention is separated from
  collected detention.

## 6. Recommended implementation structure

The exact server framework can be selected during Phase 0, but responsibilities
should be separated as follows:

```text
shared contract and state machines
        │
        ├── ingestion: simulator, ELD/vehicle, orders, traffic
        ├── command handlers: offers, assignments, visits, claims, exceptions
        ├── durable event store + versioned reference data
        ├── projections: dispatch, driver, billing, customer, audit
        ├── decision services: HOS, route, assignment, detention, ETA, parking
        └── realtime API: dispatcher, driver, admin, customer
```

Suggested repository changes:

- Keep deterministic domain functions under `src/engine/` only if they remain
  environment-independent.
- Add a shared schema/state-machine area rather than continuing to expand one
  loose event constant file.
- Add a `server/` boundary for database access, commands, authorization,
  integrations, secrets, and realtime delivery.
- Keep React surfaces as projections and command clients; they must not perform
  authoritative billing, HOS, or assignment decisions.
- Split test fixtures from live integration adapters so the UI can always state
  which source is in use.

## 7. Test and release gates

Every phase should add tests at four levels:

1. **Domain tests:** state transitions, HOS, detention, routing, feasibility,
   conflict rules, and corrections.
2. **Replay/property tests:** rebuilding produces the same projections; duplicate
   and out-of-order events remain safe.
3. **Connected scenario tests:** server, database, simulator/integration adapter,
   and two clients complete the workflow.
4. **Browser acceptance tests:** dispatcher, driver, billing/admin, and customer
   see the correct states and blocking reasons.

The primary release scenario is:

1. Post a Milton-to-London FTL delivery and a London-to-Kitchener return load.
2. Assign it using complete, fresh HOS and vehicle state.
3. Accept the offer from a separate driver session.
4. Delay the London stop beyond free time while the driver's duty clock becomes
   critical and a relevant closure affects the next route.
5. Hold movement before a violation, withdraw or replan the return assignment,
   update the qualified customer ETA, choose a legally reachable safe-stop or
   onsite-rest resolution, and create a reviewable detention claim.
6. Refresh all sessions and export the evidence without losing or duplicating
   any state.

No milestone is complete if its success depends on one browser tab, a canned AI
answer, a random favorable seed, or an alert that appears only after an unsafe
transition.

## 8. Priority summary

| Priority | Deliverable | Why it comes here |
| --- | --- | --- |
| P0 | Versioned semantics and deterministic failing cases | Prevents building on incorrect arrival, delivery, HOS, and charge meanings. |
| P0 | Durable shared server/event runtime | Required for multi-device assignment, evidence, audit, and billing. |
| P0 | Shipment/stop lifecycle and detention ledger | Closes the largest business-value and brief-alignment gap. |
| P0 | Authoritative HOS, defect, and closure gates | Prevents unsafe recommendations and transitions. |
| P1 | Open-load, offer, reservation, and acceptance lifecycle | Turns the map/feed into an actual dispatch product. |
| P1 | Regional graph, satellite, breadcrumbs, and truthful ETA | Meets mapping requirements and enables investigation/customer trust. |
| P1 | One order, ELD, and billing integration path plus server auth | Makes a carrier pilot credible. |
| P2 | Parking calibration and advanced LTL planning | Differentiation after the core workflow is trustworthy. |

## 9. Definition of the next product milestone

The next milestone is complete only when Corridor can demonstrate one durable
FTL shipment across two devices from intake through reviewed detention export,
while correctly blocking an infeasible post-dock movement and assignment.

That milestone should be presented as **a shared exception-focused dispatch
workflow with detention recovery and safe replanning**. Parking, telemetry, and
AI support the workflow; none of them substitutes for it.
