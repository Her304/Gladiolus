# Gladiolus Corridor — slide-ready product and competitive brief

Research date: 13 September 2026

## Slide 1 — Gladiolus Corridor

**Subtitle:** Shared dispatch, detention, and driver operations for Southern Ontario

**Talk track:** Corridor connects the decisions that change when a truck is delayed: who can take the next load, whether the driver can move legally, what the customer should see, and whether the carrier can recover detention.

## Slide 2 — The dispatcher is the manual integration layer

**Current pain point**

- Freight, driver hours, vehicle status, maps, customer updates, and billing often sit in separate systems.
- A delay at one facility changes the next assignment, the driver's legal hours, the customer's ETA, and the detention claim.
- Dispatchers reconcile those changes through repeated lookups, calls, texts, and duplicate entry.
- Billing teams later reconstruct evidence from timestamps and notes, which can leave eligible detention unbilled or disputed.

**Important caveat:** The project brief's estimates for missed work and monthly revenue loss remain hypotheses. The repository contains no carrier pilot that validates them.

**Talk track:** The problem is not a missing map. The problem is that one operational exception creates several disconnected decisions.

## Slide 3 — Detention consumes time that is legally constrained

- In ATRI's US 2023 study, drivers reported detention at 39.3% of stops. This establishes that detention is common in the studied sample, but it is not an Ontario prevalence estimate.
- Ontario rules cap driving at 13 hours per day, on-duty time at 14 hours, and driving after a 16-hour elapsed work-shift window. A dock delay can therefore remove a driver's ability to complete the next movement.
- Ontario 511 exposes traffic events, road conditions, truck rest areas, inspection stations, and other road data through its API.

**Talk track:** A late dock release is both a revenue problem and a dispatch feasibility problem. Corridor treats both consequences as part of the same event sequence.

**Sources:** ATRI, “New Research Documents Substantial Financial and Safety Impacts from Truck Driver Detention”; Ontario Ministry of Transportation, “Commercial vehicle safety requirements”; Ontario 511 API documentation.

## Slide 4 — What Corridor does today

1. A dispatcher enters a quote/load, or an authenticated order webhook posts it.
2. The shared load queue compares trucks and the server rechecks fresh HOS, vehicle availability, route, equipment, payload, gross weight, and axle groups.
3. The driver receives the same offer and accepts or rejects it. Atomic reservation prevents two users from assigning the same shipment.
4. ELD/GPS observations create separate arrival, check-in, service, and departure milestones.
5. The detention ledger calculates billable time under a versioned contract rule, flags inferred evidence, and requires review before export.
6. Dispatch, driver, customer, analytics, timeline, and administration views read the same durable event history.

**Talk track:** The product replaces a chain of manual handoffs with one reconstructible operational record.

## Slide 5 — How the system addresses the pain

| Pain | Corridor response | Intended outcome |
| --- | --- | --- |
| Dispatcher checks several sources before assigning | One feasibility decision uses HOS, vehicle, route, equipment, and weight inputs | Fewer infeasible offers and less manual checking |
| Two dispatchers can act on the same load | Versioned, idempotent reservation and explicit conflicts | No silent double booking |
| GPS arrival gets confused with delivery | Arrival, service completion, and gate-out remain separate milestones | More defensible status and detention evidence |
| Detention evidence gets rebuilt after the fact | Contract-based calculation, review state, evidence export, and billing export | Faster claim preparation and fewer missing claims |
| Customers call for status | Signed, expiring, shipment-scoped tracking link | Fewer status calls without exposing the next shipment |
| Exceptions remain in someone's inbox | Open, acknowledged, assigned, and resolved exception states | Clear ownership and resolution history |

**Talk track:** These are implemented workflow controls. Their business impact still requires a live carrier pilot.

## Slide 6 — Competitive comparison

| Product | What its official material establishes | Comparison with Corridor |
| --- | --- | --- |
| Trimble TruckMate | Order-to-settlement TMS, HOS-aware matching, multi-leg/LTL dispatch, automated detention/accessorial billing, accounting, driver pay, and integrations | TruckMate is much broader and more mature. Corridor's only plausible edge is a simpler Ontario-specific exception view, which has not been benchmarked. |
| Rose Rocket | Modern cloud TMS with orders, planning and dispatch, driver app, documents, customer portal, accounting, tariffs, accessorials, and integrations | Rose Rocket is stronger as a complete operational product. Corridor exposes a more explicit combined HOS/detention/parking decision in this prototype, but public documentation alone cannot prove a superior workflow. |
| Axon | Integrated dispatch, fleet management, billing, payroll, fuel, maintenance, and accounting | Axon is stronger for back-office consolidation. Corridor is narrower and does not yet replace those systems. |
| Motive | ELD, telematics, GPS, HOS visibility, geofences, dispatch support, asset data, and automated workflows | Motive is stronger for hardware-backed telemetry and fleet operations. Corridor can consume ELD data and connect it to contract detention, but has no certified device or field deployment. |

**Talk track:** Consolidation and detention automation already exist. Corridor should not claim category novelty or overall superiority.

**Sources:** Trimble TruckMate capabilities and benefits; Rose Rocket user roles and permissions; Axon transportation management system; Motive fleet telematics.

## Slide 7 — Corridor's defensible product edge

**Potential edge, not yet a measured market advantage**

- Ontario-first decision model: Canadian HOS limits, Southern Ontario road graph, Ontario 511 data, and regional parking context.
- One exception record connects dispatch feasibility, stop milestones, detention, customer visibility, and safe stopping decisions.
- Missing or stale safety data produces an “unresolved” result instead of a feasible recommendation.
- The event history preserves source, observed time, received time, and idempotency keys, so decisions and billing evidence can be replayed.
- The simulator emits the same observation format as real integrations, which supports repeatable demonstrations and pilot preparation.

**Talk track:** The strongest claim is workflow focus. Corridor makes the operational consequence of a dock delay visible in one place.

## Slide 8 — Where Corridor is not better

- No production carrier deployment or measured return on investment.
- Order and ELD connectors are sample boundaries that still require vendor credentials and field mapping.
- No complete accounting, payroll, driver settlement, fuel/IFTA, maintenance, EDI, document/POD, brokerage, or mature LTL workflow.
- No proprietary ELD hardware, certified logging device, camera, or field support network.
- Parking availability is an estimate from fleet observations and a time-of-day prior. It is not a reservation and has not been independently calibrated.
- Axle distribution is estimated unless measured weights arrive from a scale or provider.
- The bundled two-hour detention rule is demo data. Each carrier needs contract-specific rules and review policy.

**Conclusion:** Corridor is not better than mature platforms as a full TMS or telematics suite today.

## Slide 9 — Recommended market position

**Positioning statement:** An exception-control layer for Southern Ontario regional carriers that connects the existing TMS, ELD, and billing system.

**Use case:** “A stop is taking longer than planned. Which driver and load decisions now fail, what can still move safely, what should the customer see, and what detention evidence can billing use?”

**Why this position works**

- It sells the implemented cross-domain workflow rather than pretending to replace every back-office module.
- It can integrate with established systems instead of forcing a risky full-system migration.
- It creates a measurable pilot around dispatcher effort, safe feasibility, and collected detention.

**Talk track:** Compete on exception resolution first. Broader system replacement can follow only after integrations and field evidence exist.

## Slide 10 — Evidence required before claiming “better”

Run a matched baseline period and assisted period for the same lanes, weekdays, freight type, and fleet exposure.

**Primary pilot measures**

- Manual touches and status calls per load
- Median and 90th percentile quote response time
- Feasible loads accepted and infeasible recommendations by cause
- Eligible detention found, invoiced, disputed, and collected
- Minutes required to prepare each detention claim
- Avoidable empty kilometres at constant service level
- ETA error and late customer updates
- Failed parking arrivals and time remaining at a verified safe stop
- Event loss, duplication, freshness, and reconciliation backlog

**Decision rule:** Claim an advantage only when the assisted period improves these measures after software, integration, and support costs.

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

