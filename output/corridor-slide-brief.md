# Gladiolus Corridor — pitch deck

Research date: 13 September 2026

## Slide 1 — Gladiolus Corridor

**Tagline:** When a truck is delayed, everything downstream changes. We connect those decisions on one record.

**Subtitle:** Shared dispatch, detention, and driver operations for Southern Ontario regional carriers.

**Talk track:** Corridor connects the decisions that change when a truck is delayed: who can take the next load, whether the driver can still move legally, what the customer should see, and whether the carrier can recover detention. One exception — one operational record.

## Slide 2 — The problem: dispatchers are the manual integration layer

- Today, freight, driver hours, vehicle status, maps, customer updates, and billing live in separate systems.
- One dock delay ripples into the next assignment, the driver's legal hours, the customer's ETA, and the detention claim.
- Dispatchers hold it together with lookups, calls, texts, and duplicate entry.
- Billing later rebuilds evidence from timestamps and notes — leaving eligible detention unbilled or disputed.

**The core problem:** It's not a missing map. It's that one operational exception creates several disconnected decisions.

> Note: The brief's estimates of missed work and monthly revenue loss remain hypotheses, not yet validated by a carrier pilot. This deck sells the implemented workflow, not an unmeasured ROI.

## Slide 3 — Why this problem is expensive and time-constrained

- Detention is pervasive: in ATRI's US 2023 study, drivers reported detention at **39.3% of stops**.
- Hours are legally capped in Ontario: **13 hours driving, 14 hours on-duty, 16-hour work-shift window**. A dock delay can erase a driver's ability to complete the next move.
- Live road context exists: Ontario 511 exposes traffic events, road conditions, truck rest areas, and inspection stations via API.

**The takeaway:** A late dock release is both a revenue problem and a dispatch feasibility problem. Corridor treats both as part of the same event sequence.

**Sources:** ATRI; Ontario Ministry of Transportation, "Commercial vehicle safety requirements"; Ontario 511 API.

## Slide 4 — The solution: one reconstructible operational record

1. A dispatcher enters a quote/load, or an authenticated order webhook posts it.
2. The shared load queue compares trucks and the server rechecks fresh HOS, vehicle availability, route, equipment, payload, gross weight, and axle groups.
3. The driver receives the same offer and accepts or rejects it. **Atomic reservation** prevents two users from assigning the same shipment.
4. ELD/GPS observations create separate arrival, check-in, service, and departure milestones.
5. The detention ledger calculates billable time under a versioned contract rule, flags inferred evidence, and requires review before export.
6. Dispatch, driver, customer, analytics, timeline, and admin views all read the same durable event history.

**Talk track:** We replace a chain of manual handoffs with one operational record that every role can trust and replay.

## Slide 5 — How the pain becomes a controlled workflow

| Pain today | Corridor's response | Outcome |
| --- | --- | --- |
| Dispatcher checks several sources before assigning | One feasibility decision over HOS, vehicle, route, equipment, and weight | Fewer infeasible offers, less manual checking |
| Two dispatchers act on the same load | Versioned, idempotent reservation with explicit conflicts | No silent double booking |
| GPS arrival gets confused with delivery | Arrival, service completion, and gate-out stay separate milestones | Defensible status and detention evidence |
| Detention evidence rebuilt after the fact | Contract-based calculation, review state, evidence + billing export | Faster claims, fewer missed claims |
| Customers call for status | Signed, expiring, shipment-scoped tracking link | Fewer status calls without exposing the next shipment |
| Exceptions live in someone's inbox | Open, acknowledged, assigned, resolved states | Clear ownership and resolution history |

**Talk track:** These are implemented controls, not roadmap promises. Business impact is measured in the pilot.

## Slide 6 — Competitive landscape

| Product | Established strength | Corridor's position |
| --- | --- | --- |
| **Trimble TruckMate** | Order-to-settlement TMS, HOS-aware matching, automated detention/accessorial billing, accounting, driver pay | Broader and more mature. Corridor's only plausible edge is a simpler Ontario-specific exception view. |
| **Rose Rocket** | Modern cloud TMS: orders, dispatch, driver app, customer portal, accounting, accessorials | Stronger complete product. Corridor exposes a more explicit combined HOS/detention/parking decision. |
| **Axon** | Integrated dispatch, fleet, billing, payroll, fuel, maintenance, accounting | Stronger for back-office consolidation. Corridor is narrower by design. |
| **Motive** | ELD, telematics, GPS, HOS visibility, geofences, asset data, workflows | Stronger on hardware-backed telemetry. Corridor consumes ELD data and connects it to contract detention. |

**Talk track:** Consolidation and detention automation already exist. We don't claim category novelty — we compete on exception resolution for a specific region.

**Sources:** Trimble TruckMate; Rose Rocket; Axon; Motive fleet telematics.

## Slide 7 — Our defensible edge

- **Ontario-first decision model:** Canadian HOS limits, a Southern Ontario road graph, Ontario 511 data, and regional parking context.
- **One exception record** connects dispatch feasibility, stop milestones, detention, customer visibility, and safe stopping decisions.
- **Safety by default:** missing or stale safety data returns an "unresolved" result instead of a feasible recommendation.
- **Replayable evidence:** the event history preserves source, observed time, received time, and idempotency keys — decisions and billing evidence can be replayed.
- **Pilot-ready:** the simulator emits the same observation format as real integrations, so demonstrations are repeatable and preparations are honest.

**Talk track:** Our strongest claim is workflow focus. Corridor makes the operational consequence of a dock delay visible in one place — for one region, done properly.

## Slide 8 — What Corridor is not (and why that's the strategy)

We are honest about scope so the pilot is credible:

- No production carrier deployment or measured ROI yet.
- Order and ELD connectors are sample boundaries that still need vendor credentials and field mapping.
- No full accounting, payroll, driver settlement, fuel/IFTA, maintenance, EDI, POD, brokerage, or mature LTL workflow.
- No proprietary ELD hardware, certified logging device, camera, or field support network.
- Parking availability is an estimate (fleet observations + time-of-day prior), not a reservation.
- Axle distribution is estimated unless scale weights arrive.
- The bundled two-hour detention rule is demo data; each carrier needs contract-specific rules.

**Talk track:** Corridor is not a full TMS or telematics suite today — and it shouldn't pretend to be. We integrate with those systems rather than replace them.

## Slide 9 — Market position and go-to-market

**Positioning:** An exception-control layer for Southern Ontario regional carriers that connects the existing TMS, ELD, and billing system.

**Use case:** *"A stop is taking longer than planned. Which driver and load decisions now fail, what can still move safely, what should the customer see, and what detention evidence can billing use?"*

**Why this position wins**

- Sells the implemented cross-domain workflow, not a risky full-system replacement.
- Integrates with established systems instead of forcing migration.
- Creates a measurable pilot around dispatcher effort, safe feasibility, and collected detention.

**Talk track:** Compete on exception resolution first. Broader replacement follows only after integrations and field evidence exist.

## Slide 10 — The plan: prove "better" on a live pilot

Run a matched baseline period and assisted period for the same lanes, weekdays, freight type, and fleet exposure.

**Primary measures**

- Manual touches and status calls per load
- Median and 90th-percentile quote response time
- Feasible loads accepted vs. infeasible recommendations by cause
- Eligible detention found, invoiced, disputed, and collected
- Minutes required to prepare each detention claim
- Avoidable empty kilometres at constant service level
- ETA error and late customer updates
- Failed parking arrivals and time remaining at a verified safe stop
- Event loss, duplication, freshness, and reconciliation backlog

**Decision rule:** Claim an advantage only when the assisted period improves these measures after software, integration, and support costs.

**Talk track:** We won't declare victory on features. We'll declare it on a matched pilot — and that's what makes the claim worth buying.

## Source links for slide notes

- Local product summary and honest limits: `README.md`
- Local end-to-end production-boundary proof: `test/system-boundaries.test.mjs`
- Local pilot measurement framework: `src/domain/pilot.js`
- ATRI detention research summary: https://truckingresearch.org/2024/09/new-research-documents-substantial-financial-and-safety-impacts-from-truck-driver-detention/
- Ontario commercial vehicle safety and HOS: https://www.ontario.ca/page/commercial-vehicle-safety-requirements
- Federal HOS regulation, section 13: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/section-13.html
- Ontario 511 developer API: https://511on.ca/developers/doc
- Trimble TruckMate capabilities: https://transportationinfo.trimble.com/brochure/truckmate-tms/capabilities-benefits
- Rose Rocket roles and product modules: https://help.roserocket.com/user-roles-and-permissions
- Rose Rocket dispatch workflow: https://help.roserocket.com/dispatching-an-order
- Axon transportation management system: https://axonsoftware.com/transportation-management-system/
- Motive fleet telematics: https://gomotive.com/products/features/fleet-telematics/
