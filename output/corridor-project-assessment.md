# Corridor Project Assessment

## 1. Overall assessment

**Corridor addresses a real downstream problem—finding somewhere to stop before a driver's hours expire—but it does not yet address the hackathon brief's central business problem end to end.** The current implementation is a functioning fleet-telemetry and driver-interface prototype. It is not yet a consolidated city-dispatch system that turns available freight into feasible assignments and turns facility delays into recoverable detention charges.

The strongest assets are the separated simulation module, event-based projections, geofence handling, visible data-source labels, parking planning, and the newer driver portal. The most consequential omissions are a persistent shipment-and-stop record, automated detention calculation, a real load queue and assignment engine, complete HOS feasibility, and shared state across dispatcher and driver devices. These are gaps in the workflow itself, beyond ordinary production hardening.

| Assessment dimension | Judgment |
| --- | --- |
| Relevance to an actual industry problem | Meaningful: delay, driver availability and parking are connected operational concerns. |
| Alignment with the brief's primary pain point | Partial and materially off-center: the brief prioritizes dispatch workload, detention recovery and load utilization. |
| Prototype engineering | Useful foundation with executable simulation, replayable projections and interactive surfaces. |
| Critical detention requirement | Not satisfied: a driver timer and dwell statistics exist, but no database-backed detention ledger or fee calculation. |
| Automated dispatch and backhaul | Not satisfied in the main fleet: assignments are generated randomly; load acceptance is demonstrated separately. |
| Real operational readiness | Not established: missing data can appear safe, some unsafe transitions remain possible, and sessions do not share a backend. |
| Demonstrated financial impact | None yet: no measured reduction in check calls, recovered invoices, profitable additional loads or failed parking attempts. |

**Recommended direction:** retain the existing telemetry and driver work, but make the next product milestone a complete shipment workflow: intake → feasibility → assignment → driver acknowledgment → facility evidence → exception resolution → detention charge/export. Parking should support that workflow, especially when dock delays threaten the driver's ability to leave safely.

The assessment covers the current working tree, including uncommitted driver-portal work, as inspected on 13 September 2026. The six-page project brief supplies the evaluation requirements; its instructions are treated as document content, and its market figures are treated as claims to assess. Planning documents are evidence of intended work, not completed capabilities. No application source was changed. The analysis distinguishes documented requirements, observed implementation, external evidence and recommendations.[^1]

## 2. The industry pain point

### A dispatcher's problem is maintaining a reliable plan

The underlying issue is the difficulty of keeping several decisions synchronized: whether a load is worth accepting, whether a driver and vehicle can perform it, whether the current stop will finish on time, whether the customer needs an update, and whether the carrier has evidence to collect its charges. When these answers live in different systems, the dispatcher becomes the manual reconciliation layer.

A useful system therefore needs more than a common screen. A shipment identifier must connect the rate, equipment requirement, driver assignment, stop sequence, GPS observations, duty history, delivery evidence and invoice. The operational benefit comes when information changes a decision and that decision reaches the affected people and systems. A map can reduce uncertainty about location while leaving this entire coordination burden intact.

Different participants experience the same failure differently. Dispatch loses time chasing status and rebuilding the plan. Drivers face unclear instructions, unpaid waiting and impossible downstream commitments. Billing staff lack the evidence or contract context to invoice. Customers receive optimistic ETAs or disputed accessorial charges. The carrier owner needs collected contribution and dependable service, rather than a larger count of tracked events.

### Evidence and its limits

ATRI's 2024 US detention study collected 587 driver and 245 carrier responses using convenience samples. Within its truckload dry-van driver analysis, 57.8% reported at least one late or cancelled subsequent appointment caused by detention in 2023, and 52% reported exhausting on-duty HOS at a customer facility. These are useful evidence for the causal chain described in the brief. They are not Ontario prevalence estimates; neither percentage describes all 587 drivers, and the study's economic analysis excluded LTL and owner-operators.[^2]

The US Department of Transportation's Inspector General also identified a measurement problem: electronic location data does not readily distinguish detention from legitimate loading and unloading work. Its 2018 finding is relevant to event interpretation, not a current estimate of Ontario market size.[^3]

Ontario's Southwestern transportation task force recommended reviewing rest-area capacity and amenities and considering additional parking opportunities. Parking is therefore a credible regional concern. That evidence does not establish it as the main bottleneck for the London/Milton city-dispatch customer described in the brief.[^4]

### FTL and LTL are different planning problems

| Operating question | Regional FTL | City LTL |
| --- | --- | --- |
| What is assigned? | A load/trip, tractor, trailer and driver; live or drop service. | Multiple shipments on a manifest with ordered pickups, deliveries and possible terminal transfers. |
| What makes capacity feasible? | Equipment, weight, appointments, service time and driver availability. | Those constraints plus cube, pallet positions, stackability, access to freight and changing capacity after each stop. |
| What counts as completion? | Completion of the relevant service and delivery evidence. | Completion of one shipment/stop without prematurely completing the remaining route. |
| What can disrupt the next job? | Dock delay, closure, equipment failure or unavailable driver. | Those events plus partial delivery, refusal, redelivery, missed crossdock and freight left at a terminal. |

This workflow comparison is analytical synthesis. Exact priorities must be established with the target carrier's actual lanes, equipment, contracts and operating procedures.

## 3. What the current project actually contains

Corridor is a React/Vite browser application. The main runtime creates a store and a simulator, seeds forty trucks, advances simulated time and projects events into the views. The simulated network is a coarse, fourteen-point Highway 401 path from Windsor to Scarborough. It includes London and Milton customer stops, but its owned yards are Windsor and Etobicoke. It does not model the brief's Barrie, Peterborough, Pickering and Niagara Falls branches.[C1][C2]

The separation between physical simulation and observed events is a useful architectural choice. It allows headless execution and makes derived metrics inspectable. Geofences use a larger exit boundary to reduce repeated entry/exit noise, and movement is subdivided to reduce missed crossings. These are substantive implementation details that improve the demonstration.[C3]

| Surface or subsystem | Current capability | Important boundary |
| --- | --- | --- |
| Dispatcher board | Fleet map, low-hours alerts, parking estimates, event feed, incidents and AI question. | No operational load queue, quote workspace, assignment controls or detention money view. |
| Dashboard | Fleet utilization, laden/empty kilometres, completed dwells and forced stops. | Descriptive simulation metrics; no baseline or revenue-recovery measurement. |
| Driver portal | Route display, duty view, parking choices, dock timer, requests, inspections and breakdown reports. | Main-fleet parking choices are connected; offer acceptance runs in an isolated scenario model. |
| Customer page | Shipment label, truck-derived status and ETA. | Token is unsigned; page follows the truck's current destination rather than a durable shipment lifecycle. |
| Admin console | Seeded directory, fleet/site reference, integration status and event inspection. | Capacity overrides persist locally; role enforcement and audit durability are prototype-only. |
| External services | Ontario 511 incidents; optional TomTom flow and LLM calls. | No load-board, certified ELD, TMS or accounting integration. |
| Event store | In-memory event array with projections and replay. | No durable operational database, device synchronization, provider-event deduplication or server authority. |

The current route imports the newer `src/driver/DriverPortal.jsx`. The older `src/views/DriverView.jsx` is not the active driver experience. Similarly, `plan.md` and `plan-dispatch.md` contain proposed loads, detention, weight and dispatch extensions; those proposals cannot be counted as shipped functionality.[C1][C4]

The simulation module is independent of React and can run headlessly, so it deserves partial credit for separation. However, the application runs it inside each browser page rather than as the independent backend service requested by the brief. A dispatcher and a driver on separate devices do not observe one shared authoritative fleet. An action appearing in a same-page event feed is not evidence of cross-device delivery.[C1]

## 4. Requirement-by-requirement fit

Status definitions: **Implemented** means executable behavior within the prototype; **Partial** means useful supporting behavior exists; **Missing** means the required workflow is absent. None of these labels certifies production readiness.

| Brief requirement | Status | Evidence and implication |
| --- | --- | --- |
| Southern Ontario dispatch map | Partial | Interactive Leaflet map, but only the Windsor–Scarborough 401 simulation network. Panning elsewhere does not create routes or operations there. |
| Satellite toggle for yard/dock inspection | Missing | A single OSM tile layer is configured; no satellite selection. |
| Historical route breadcrumbs | Missing in user workflow | Ping coordinates exist, but the displayed corridor/driver path is not a historical truck trace. |
| Distance and speed by leg/shift | Partial | Speed/odometer pings and fleet kilometre charts exist; no complete leg/shift investigation view. |
| Geofence arrival/departure capture | Implemented in simulation | Timestamped events, hysteresis and dwell records exist; they do not identify all operational milestones. |
| Database records for detention | Missing | Operational events are held in memory and lost on reload. |
| Automated detention fees after free time | Missing | Driver countdown exists; no contract, rate, billable amount, debtor or invoice calculation. |
| Separated simulator and event generation | Partial | Headless module with movement, delays and duty transitions; not a shared backend service. |
| Driver load acceptance | Partial | Working isolated scenario; no main-fleet offer/acceptance lifecycle. |
| Driver duty log | Partial | Session telemetry is rendered as duty segments; no complete RODS/ELD record. |
| Automated return-load matching | Missing | Random load creation and destination choice; no candidate inventory or feasibility ranking. |
| Canadian HOS pre-dispatch audit | Partial, insufficient | Two counters constrain parking calculations; no complete daily/shift/elapsed/cycle gate. |
| Axle-weight compliance | Missing | A demo weight label is not a vehicle/axle-distribution model. Scale-open inference does not perform weight compliance. |
| Multi-system consolidation | Missing operationally | Common internal event format, but no freight/ELD/TMS/accounting reconciliation. |
| HOS expires while waiting at dock | Detected incompletely; unresolved | Waiting burns duty, but departure is not blocked before movement and no relief/rescheduling workflow exists. |
| Unexpected 401 closure | Partial visibility; unresolved | Incident is shown and reduces speed; route remains traversable. |

Evidence: active application routes and runtime [C1]; geographic data [C2]; map and dashboard [C5]; event/simulator behavior [C3]; driver model [C4]; HOS [C6]; traffic integration [C8]. The source brief identifies detention recording and billing as critical and also explicitly scores workflow speed and financial value.[^1]

The judging implication is qualitative because the brief supplies no numeric weights: the project can earn credit for a functioning simulator, mapping, driver experience and problem discovery, but major holes remain in the explicitly scored detention, matching and regulatory workflows. A completion percentage would disguise the unequal importance of these requirements.

## 5. Detention: the largest business-value gap

### Presence is evidence, not a complete billing event

The project correctly demonstrates facility entry and exit. It also displays free dock time and time beyond two hours on the driver's screen. However, its stored dwell projection contains a truck, site, rounded duration and exit time—not a shipment-linked, contract-linked detention claim. There is no detention rate, invoice status, approval, export or payment reconciliation.[C3][C4]

The simulator conflates arrival with delivery. When a loaded truck enters its destination fence, it immediately emits `load.delivered`, clears the load and begins its dock wait. An eight-hour reproduction without incident/flow injection produced 37 delivery events; all 37 matched the corresponding fence-entry timestamp and site. The recorded delivery therefore precedes modeled unloading. That breaks the meaning of availability and removes the active load association just when detention evidence should be accumulated.[C3]

Default new dock waits are generated between 35 and 120 minutes, below the two-hour threshold before tick/exit effects. In that reproduction, 41 completed customer dwells had a maximum of 119 minutes. The ordinary scenario therefore does not deliberately exercise the critical prolonged-detention case. The driver dock scenario begins eight minutes into a visit and is a separate real-time demonstration.[C3][C4]

### The two-hour rule needs a defined contract boundary

Two hours is a reasonable explicit default for the brief's FTL demonstration. It is not a universal rule for every shipment. Maritime-Ontario's Tariff 520, effective 1 January 2026, uses weight-dependent free-time bands from 20 to 120 minutes; live truckload receives 120 minutes, while drop truckload receives 30. It distinguishes general/refrigerated freight, half-hour charging increments and trailer detention without power, and excludes delay attributable to carrier fault. This is one Canadian carrier's tariff, not a mandatory industry rate.[^5]

An operational detention record needs separate physical and commercial milestones: queue arrival, gate/check-in, service start, service complete and gate-out; shipment/stop/tractor/trailer identity; appointment and contract version; free-time and rounding rules; evidence and corrections; and charge review/export state. Not every carrier needs every milestone to calculate every charge, but the data model must not make them indistinguishable.

**Worked hypothetical:** a truck arrives at 08:00 for a 09:00 appointment, completes service at 11:30 and leaves at 12:00. A contract starting free time at appointment and ending chargeable service at completion yields 30 billable minutes after a two-hour allowance. A gate-to-gate implementation yields 120. Neither interpretation can be selected from GPS alone. Rates and contract terms must be explicit.

A stopped tractor may also have dropped its trailer, be queuing outside the fence, be resting after unloading, or be visiting an adjacent business. These cases need evidence review rather than automatic conversion of every long dwell into a fee. The OIG evidence reinforces that distinction.[^3]

**Verdict:** prerequisite telemetry exists; the brief's detention recovery outcome is missing. This should be the highest-priority workflow addition for brief alignment.

## 6. HOS, vehicle availability and the dock-queue edge case

Canadian feasibility cannot be represented by a single remaining-driving number. Under the federal south-of-60 regime, daily driving/duty limits coexist with limits since qualifying rest, a 16-hour elapsed window and daily off-duty requirements. Cycle 1 and Cycle 2 add cumulative limits and distinct resets. Applicability must be determined for the carrier and operation; the brief's primer is not a complete regulatory specification.[^6]

For the ordinary regime, the principal figures are 13 hours driving, 14 hours on duty, eight consecutive hours of core rest and ten daily off-duty hours. Cycle 1 limits on-duty time to 70 hours in seven days; Cycle 2 uses 120 in fourteen days plus its additional 70-hour/24-hour-rest condition. Cycle resets require 36 and 72 consecutive hours respectively. Special provisions require separate supported logic.[^6]

Ontario's local record-of-duty-status exemption is also relevant to city dispatch: eligibility depends on the qualifying 160-km radius, return to the starting location and other conditions. Required operator records and HOS compliance remain relevant. A short regional route is neither automatically ELD-required nor automatically exempt.[^7] A duty-chart interface is not a certified ELD; integrating an existing certified device is a separate product boundary.[^8]

### Demonstrated decision failures

| Test condition | Current result | Why it matters |
| --- | --- | --- |
| Missing driving and duty fields | 13 hours available; status `ok`. | Unknown history becomes affirmative availability. |
| Driving 5h, duty 8h, elapsed 17h, cycle 70h | 6 hours available; status `ok`. | Supplied elapsed/cycle exhaustion is ignored by the decision function. |
| Driver at 14h duty; dock wait expires | State becomes driving; a following tick moves about 375m at 90km/h before a forced stop. | The exact brief edge case is not prevented at the facility. |
| Actual speed 10km/h; 1h available | Reach is calculated as 40km. | A hard minimum speed creates optimistic reachability in congestion. |
| Major defect appended to a moving truck | Truck still moves about 375m on the next tested tick. | The displayed safety blocker is not authoritative vehicle availability. |

These are deterministic, isolated in-memory counterexamples, not observations of actual drivers. Their source locations are HOS calculations [C6], simulator transitions [C3] and inspection reporting [C9].

The main fleet emits driving and on-duty totals but not elapsed/cycle history. The driver log appropriately labels the missing totals as unavailable; the decision engine nevertheless proceeds using two counters. A fixed ten-hour rest that resets both counters cannot establish every daily, shift and cycle condition. An exhausted allowance should also be distinguished from a proven driving violation.

The dock screen gives precedence to the detention countdown over the critical-hours branch. A driver can therefore see free-time information while the more urgent question is whether service and safe departure remain possible. The missing workflow is a forecast of release time, remaining service work, travel to a verified safe stopping place and the deadline for intervention. When feasibility disappears, dispatch needs a hold, safe onsite-rest confirmation, relief or rescheduling—not an optimistic departure followed by a roadside-stop event.

Inspection handling needs similar precision. Ontario guidance describes a valid inspection within the preceding 24 hours, ongoing monitoring and repair before operation with a major defect; it does not support the code comment's universal pre- and post-trip legal requirement.[^9] The current checklist assigns severity to broad systems, although an individual system can contain different defect severities. A clean later pre-trip submission clears a major flag without a repair-resolution workflow, and reports lack several elements of a complete inspection record.[C9]

## 7. Parking: a worthwhile hypothesis with unproven accuracy

The parking work is the project's clearest original hypothesis. It combines the fleet's observed presence with an assumed share of corridor traffic and a time-of-day baseline, then recommends stops within the simplified hours budget. It distinguishes carrier yards from public parking, exposes the assumed 6% share and rechecks apparent space on arrival. The driver detail also explains that a claim communicates an intention rather than reserving a physical bay.[C7][C4]

Ontario 511 provides truck-rest-area information, but the examined endpoint's `TruckParking` field is a Y/N amenity indicator and the published schema does not document live occupied/free stall counts. That supports an occupancy-data gap in this integration. It does not prove the README's broader assertion that no live occupancy source exists anywhere in Ontario.[^10]

### Statistical limitations

The 6% traffic-share assumption does not establish a 6% sample of parked vehicles at each site and hour. A carrier's trucks share schedules, depots, preferred stops and dispatch policy. Long-staying trucks are more likely to be observed than brief visitors. Recommendations themselves move the fleet toward selected lots, changing the sample that informs the next recommendation.

The baseline curve is hard-coded, not learned from field observations. The displayed confidence is a blend weight based on observed count, not a measured probability of accuracy. At a true 6% parking share, a full 26-space lot would contain only 1.56 fleet trucks on average, well below the five-observation threshold for full model weight. This arithmetic does not validate the sampling assumption; it illustrates how sparse the expected evidence would be even if that assumption held.

The estimator counts all recorded geofence occupants, including passing trucks, rather than only confirmed parked vehicles. One claimed inbound truck is also counted both as a claim and as projected demand: an otherwise empty 24-space yard becomes 22 projected spaces in the tested case. A forecast can also include the same uncommitted truck at several possible lots. These effects need correction before evaluating model accuracy.[C7]

### Access and reference data already contradict operational use

The operator lists Cambridge North as westbound-access only with 35 commercial spaces; the seed has 26 spaces and no parking access-direction field. An eastbound truck one kilometre before that site was allowed to claim it in the isolated test. ONroute Woodstock lists eastbound access and 78 commercial spaces, compared with 34 in the seed. These are verified examples, not a comprehensive site audit.[^11][^12][C2]

The minimum-speed assumption, coarse route geometry and absence of entrance/search buffers further weaken legal reachability. A claimed space cannot guarantee entry, availability or permission to remain. Even a private-yard count is exact only if every occupying vehicle and unavailable bay is represented.

**Verdict:** preserve parking as advisory research. Validate against independent counts across site, time, weather and unseen days; prioritize the rate of arriving at a supposedly available but full lot, then occupancy error and forecast calibration. The current bounded outputs and confidence labels do not establish reliable real-world availability.

## 8. Load matching, traffic response and information quality

### Load generation is not load matching

The main simulator selects destinations randomly and creates a new load after a dwell with 72% probability. There is no inventory of available freight, pickup-ready time, customer commitment, equipment compatibility, residual capacity or margin model. Empty kilometres are measured, but no counterfactual demonstrates that the software reduces them.[C3]

The isolated driver offer scenario implements identity, expiry, accept/reject and a travel-only HOS check. This is worthwhile interaction work, but its hard-coded 110-km offer and displayed weight are not a main-fleet dispatch engine. It does not reserve a real load, audit axle distribution or budget loading, unloading, queues and safe shutdown. Non-parking actions in the main portal are generally recorded as events rather than changing simulator assignments.[C4]

A useful matcher must first determine feasibility, then rank the feasible options. For LTL, that means capacity after each stop and access to freight as well as total payload. A nearby return load can be commercially wrong if it jeopardizes a higher-value commitment. The project's statement that every empty kilometre is unpaid is too absolute: repositioning can be priced into an overall movement or be a rational part of a profitable tour.

### Closures need topology and schedule interpretation

A full closure currently applies a minimum speed multiplier of 0.25. Trucks continue along the same line. That models slow traffic, not an impassable edge, and does not solve the closure edge case.[C8]

Ontario 511 documents event direction variants, start/end times, affected lanes, recurring schedules, geometry and restrictions. The normalizer keeps only a subset. The speed filter recognizes `Both` plus east/west text, while the documented vocabulary includes `Both Directions` and `All Directions`. In addition, a ramp closure and a mainline closure cannot safely be treated as the same corridor penalty.[^13][C8]

The local preview successfully displayed 511 as live and TomTom flow as cached. That verifies one development fetch, not production reliability. The simulator uses accelerated time while external incidents use wall-clock information; temporal consistency must be explicit when demonstrating current traffic against simulated operations. Static production builds also lack Vite's development proxy.[C1][C8]

### AI and customer language exceed available evidence

The board's no-key response is canned text, labeled as cached. In the preview it named three risk trucks while the deterministic alert list showed another truck. More fundamentally, the live prompt supplies fleet aggregates and parking rows but omits the per-truck identity/location/HOS detail needed to justify specific truck advice. The stored backhaul and email examples are prose, not implemented assignment or communication workflows.[C10]

The customer ETA divides corridor distance by a speed floored at 40km/h. It omits rest, dwell and full HOS feasibility while claiming those hours are accounted for. An old tracking token can keep its original shipment label while showing the truck's next destination. Trustworthy shipment identity and explicitly qualified ETA are prerequisites to reducing check calls.[C11]

## 9. Operational edge-case register

The following register distinguishes verified current weaknesses from unimplemented cases that a pilot must exercise. Severity refers to consequences if used operationally, not to defects in a deliberately scoped visual mockup.

| Edge case | Current coverage | Required operational outcome |
| --- | --- | --- |
| GPS jitters at a fence | Partial: exit hysteresis exists. | Suppress chatter while retaining uncertain observations and legitimate short visits. |
| Sparse GPS; queue outside fence | Not modeled adequately. | Preserve uncertainty and check-in evidence; do not invent an exact crossing time. |
| Early arrival or appointment change | No appointment/contract model. | Select billable start using applicable terms and versioned appointment history. |
| Service complete, driver remains to rest | Arrival is already marked delivered; no service-complete milestone. | Separate unloading completion, off-duty status and gate departure. |
| Dropped trailer, tractor leaves | No trailer lifecycle. | Continue trailer detention independently of tractor movement. |
| Partial/refused LTL delivery | Single active load/destination model. | Keep remaining manifest, exception evidence, capacity and redelivery obligations. |
| Duty expires at dock | Reproduced unsafe release. | Hold before movement and coordinate a feasible resolution. |
| Missing/stale ELD history | Missing counters default to zero. | Show unresolved feasibility and obtain authoritative history. |
| Closure or severe congestion | Slowdown only; optimistic speed floor. | Invalidate the affected route and re-evaluate time windows, HOS and stopping options. |
| Wrong-side or full parking | Wrong-side claim reproduced; estimates are advisory. | Verify legal access, forecast uncertainty and a contingency before commitment. |
| Major defect or breakdown | Report/event exists; simulation can keep moving. | Remove affected vehicle from available capacity and track acknowledgment/resolution. |
| Payload legal but axle overloaded | No axle model. | Evaluate configuration, distribution and applicable route/permit limits. |
| Duplicate or delayed telemetry | No provider ID/deduplication or stale-ping guard. | Avoid duplicated visits/charges and regression of current location. |
| Odometer correction or device replacement | Negative deltas suppressed without reconciliation. | Separate correction/reset from actual distance and keep provenance. |
| Driver changes tractor or works for multiple carriers | Driver tied to seeded truck context. | Preserve driver duty history independently from vehicle telemetry. |
| Two dispatchers accept the same load | No shared assignment authority. | Atomic reservation, version checks and visible conflict resolution. |
| Browser refresh, device loss or offline request | Operational log is ephemeral. | Durable queue, idempotent retry, synchronization and confirmed receipt. |
| Customer link after reassignment | Follows current truck destination. | Shipment-scoped history, expiry/revocation and correct completion state. |
| Manual billing correction or waiver | No billing lifecycle. | Preserve original evidence, reason, actor, approval and revised amount. |

Sparse telemetry is not a hypothetical integration detail: Rose Rocket's ELD integration documentation specifies a 15-minute location refresh for that integration. It also imports several HOS availability measures. This vendor-specific example shows why database timestamp precision and physical-event precision must be distinguished.[^14]

Axle legality similarly cannot be inferred from gross payload alone. Ontario's vehicle weight rules distinguish configurations and axle conditions, with route/permit restrictions relevant in some operations. The planned simple weight field would be only an initial capacity check, not proof of axle compliance.[^15]

The best innovation opportunity is the interaction between these cases: a delayed stop can create detention, remove legal driver availability, invalidate a return load and change the customer's ETA simultaneously. A shared exception record should coordinate all four consequences.

## 10. Architecture, security and adoption implications

**The event-based design is worth retaining, but its current guarantees are narrower than the README suggests.** Replay can reproduce selected projections from a supplied log. It does not prove that the original observations were correct, that records survive reload, that every device shares them, or that the log reconstructs all operational configuration. Site overrides live separately in localStorage and mutate reference objects; full historical reconstruction would need versioned configuration alongside events.[C1][C12]

Late pings can overwrite a newer truck state even though the world clock is kept monotonic. Nested event payloads are not a durable immutable record, and there are no provider IDs or deduplication rules. A real integration needs event-time and receipt-time provenance, schema/version handling, corrections, reconnection and an authority policy for conflicting updates.[C3]

Authentication and customer tokens are explicitly prototype-only. Staff credentials and roles are compared in the browser, while customer claims are encoded rather than signed. These are disclosed choices, but they prevent treating the current app as access-controlled operational software. The optional LLM key would also be exposed in the client. Private driver/location data should be mediated by server-side authorization and shipment-scoped access before an actual fleet pilot.[C11][C10]

The app currently creates an additional operating surface; it does not demonstrate removal of a load board, ELD, TMS or accounting subscription. A practical small-carrier rollout would usually need to prove one useful integration path first: one source of orders, one source of driver/vehicle state, and one destination for invoices or charge exports. The carrier must be able to identify which system owns each field and how failures are reconciled.

Adoption should be evaluated across dispatch, drivers and billing together. A driver request needs acknowledgment, an owner and a resolution state. An event feed alone does not establish that someone saw it. The breakdown interface's implication that help is on the way is especially stronger than merely recording a report against a seeded vendor book. Vendor hours, availability and carrier authorization are also operational inputs, not just map references.[C4][C2]

A useful failure mode is to preserve the last known data with its age and make unresolved decisions visible. Replacing a failed live feed with an undated sample may keep a demo attractive while reducing operational trust. A pilot should distinguish live, stale-last-known, estimated and fictional fixture data clearly, especially on the driver surface.

## 11. Competition and a defensible product position

Unified freight workflows already exist in the market. Their existence does not prove that small Ontario carriers can adopt them affordably or use them efficiently, but it means consolidation by itself is not novel.

| Existing product | Officially documented overlap | Implication for Corridor |
| --- | --- | --- |
| Trimble TruckMate | Detention/accessorial billing, multi-leg dispatch, LTL planning, HOS/window-aware matching, documents and accounting. | A credible comparison must address completion and onboarding, not just screen count. |
| Axon | Integrated order processing, dispatch, driver pay, billing, maintenance, financial reporting and customer visibility. | A single shared workflow is an established category promise. |
| Rose Rocket | ELD integrations, driver dispatch, acceptance and delivery-document workflows. | A driver app needs a reliable connection to the dispatch and billing record to differentiate. |

These are vendor descriptions of offered capabilities, not independently verified ROI, usability or price comparisons.[^16][^17][^18]

Two product directions are possible. For the **brief-aligned direction**, Corridor would become an exception-focused city-dispatch workspace centered on detention recovery and feasible next assignments. Its advantage would need to be measured lower setup effort, faster exception resolution and fewer missing revenue records for a narrowly defined carrier segment.

For a **parking-focused direction**, the customer, value proposition and validation plan would change. The project would need dependable legal-access data and independently calibrated arrival-time availability, potentially across multiple fleets or site operators. That direction could be valuable, but it would remain materially different from completing the supplied brief. It should not borrow the brief's quoting-revenue assumptions as evidence for its own value.

The strongest combined position is a city-dispatch exception tool in which parking protects the final leg of a feasible plan. The distinctive question becomes: **“This stop is taking longer than expected—what happens to the driver's hours, the next commitment, the detention claim and the safe stopping plan?”** The current app shows pieces of this question but does not yet coordinate the answer.

## 12. Financial value and validation priorities

### The brief's business case is a hypothesis

The brief quotes software costs, five-system fragmentation, one to three missed jobs per day and $15,000–$50,000+ monthly lost opportunity. The supplied evidence does not independently establish those figures for the target Ontario carrier. Currency, subscription scope, contract terms and fleet/desk size are also insufficiently specified.[^1]

Its arithmetic needs reconciliation: $6,000 per day across 20 operating days is $120,000 of monthly opportunity face value. A smaller realizable value could result from quote win rate, available capacity or margin, but those assumptions are absent. A missed quote is not necessarily a lost job, booked revenue is not collected revenue, and revenue is not profit.

The appropriate carrier-level model is:

**Net benefit = incremental collected detention + contribution from additional feasible loads + avoidable operating cost − software, integration and support cost.**

Measure recovered dispatcher capacity separately from payroll savings unless staffing cost is actually avoided. Do not count the same freed time both as saved wages and as additional load contribution. Distinguish unavoidable repositioning from avoidable empty running and keep service commitments constant when comparing policies.

### Recommended sequence

| Priority | Report recommendation | Evidence required before claiming success |
| --- | --- | --- |
| P0: trustworthy core workflow | Persistent shipment/stop identity, correct arrival/completion semantics, billable detention calculation and exportable evidence. | One prolonged FTL visit produces the correct charge and survives refresh/reconnection. |
| P0: decision correctness | Unknown HOS handling, dock departure hold, complete supported HOS regime, defect availability and closed-route handling. | No prohibited movement/assignment in defined boundary cases; explain unresolved cases. |
| P1: actual dispatch | Open-load inventory, versioned offer/reservation, driver acknowledgment and feasibility including service time. | Two separate sessions agree on one assignment; a conflict cannot double-book it. |
| P1: brief coverage | London/Milton-centered regional routes, satellite mode and historical trace/drill-down. | Demonstrate the specified regional branches and investigate a particular leg/stop. |
| P1: integrations | One order source, one authoritative ELD/vehicle source and one billing destination. | Reconcile identities, stale data, retries and corrections end to end. |
| P2: differentiated prediction | Calibrated parking forecasts and richer LTL planning. | Independent occupancy validation and capacity/time-window correctness across stop sequences. |

These are scope priorities, not an implementation schedule or estimate. Building all proposed features without a carrier pilot would not establish value.

### Pilot measures

Observe a baseline period and then a comparable assisted period, matched for lane, weekday, freight type and fleet exposure. Track check calls and manual touches per load; median and upper-tail quote response time; feasible loads accepted; eligible detention identified, invoiced, disputed and collected; minutes spent preparing a detention claim; avoidable empty kilometres at constant service; and infeasible recommendations by cause.

For parking, track failed arrival availability and time remaining at a verified safe stop. For data, track freshness, event loss, duplication and reconciliation backlog. Avoid claiming accident reduction from a short pilot or revenue recovery from invoices that have not yet been paid. Carrier interviews and actual contracts are necessary to set meaningful target improvements; arbitrary percentages would add false precision.

## 13. Acceptance scenarios and verification findings

The most informative next demonstration is a connected sequence rather than another standalone screen. Start with a Milton-to-London delivery, an available London-to-Kitchener return load, limited driver hours, a delayed dock release and a relevant closure. The expected result should include both a decision and its operational/financial record.

1. A 119-minute qualifying FTL stop yields no billable time under a stated two-hour rule; a 150-minute stop yields 30 billable minutes before explicit rate rounding.
2. Early arrival, service completion before gate-out and an approved waiver produce traceable, contract-correct results.
3. A prolonged parking/rest stay never becomes a customer detention charge merely because it is a long geofence visit.
4. A driver whose duty allowance expires at the dock stays held before any new driving; the next load becomes unavailable to that driver and a resolution is recorded.
5. Missing ELD history and exhausted elapsed/cycle limits cannot return an affirmative feasible assignment.
6. A mainline closure invalidates the affected route; a ramp-only closure is assessed against actual planned access.
7. A wrong-carriageway parking site cannot be selected without a feasible legal approach; a planned stop is never described as a guaranteed reservation.
8. Two dispatchers racing to assign one load produce one winning assignment and one explicit conflict; the driver sees the same result on another device.
9. Duplicate, delayed and offline observations do not create duplicate visits/charges or silently regress the current vehicle state.
10. A partial LTL delivery updates only the affected shipment and recalculates remaining capacity/appointments; an old customer link does not expose the truck's next shipment.

### What passed

Both existing smoke scripts passed, and the production build completed successfully. The build reported a large-bundle warning, not a compilation failure. The standard eight-hour fleet smoke run reported 13,395 events, 35 dwells, 169 transits and 11 forced stops. These outputs demonstrate running simulation and selected invariants; there is no comparison policy showing avoided stops or improved utilization.[C13]

### What those checks do not establish

The HOS smoke assertion examines the final snapshot for a truck still driving more than one hour beyond the 13-hour limit. It does not inspect every movement segment or prove compliance with duty, elapsed, daily or cycle constraints. Replay checks compare selected counts and kilometre totals, not every semantic property. The deterministic counterexamples in this report demonstrate why passing these checks is insufficient.[C13]

The browser review confirmed the dispatcher interface, live 511/cached flow labels, the canned AI answer and the driver dock timer. No real ELD, commercial freight assignment, invoice export, customer message, multi-device synchronization or field parking observation was verified. Site reference checking was limited to specific examples. Industry evidence combines official Canadian guidance, a Canadian tariff, vendor documentation and explicitly labeled US research; it does not supply a representative Ontario carrier ROI study.

**Final judgment:** Corridor is a useful prototype, but it does not yet satisfy the brief's central pain point. A persistent shipment-and-stop workflow connecting safe dispatch to recoverable charges would close the most important gap.

## Sources

All web sources were checked on 13 September 2026. Undated vendor/operator pages describe published capabilities or reference information at access, not independent performance validation. Numbered references are source footnotes; C references identify the inspected local implementation.

[^1]: Supplied document, *Hackathon Project Brief: City Dispatch Workflow & Fleet Automation*, pp. 1–6. Local file: `/Users/hercules/Downloads/1788654151601_Hackathon_Project_Brief.pdf`. Market figures are unverified brief assumptions; pp. 2–5 establish requirements.
[^2]: American Transportation Research Institute, *Costs and Consequences of Truck Driver Detention: A Comprehensive Analysis*, September 2024, printed pp. 7–8 and 14–15. [Original study, accessible copy](https://yue-shan-econ.github.io/assets/Costs%20and%20Consequences%20of%20Truck%20Driver%20Detention.pdf). US convenience samples; subgroup and sector limitations apply.
[^3]: US DOT Office of Inspector General, *Estimates Show Commercial Driver Detention Increases Crash Risks and Costs, but Current Data Limit Further Analysis*, 31 January 2018, report ST2018019. [Report](https://www1.oig.dot.gov/library-item/36237). Used for limits of location-based detention inference, not current Ontario costs.
[^4]: Government of Ontario, *Southwestern Ontario transportation task force final report*, 2023, truck-rest-area recommendations. [Report](https://www.ontario.ca/page/southwestern-ontario-transportation-task-force-final-report). Search-indexed official text was available; direct page retrieval was blocked.
[^5]: Maritime-Ontario Freight Lines, *Tariff 520: Conditions of Carriage*, effective 1 January 2026, item 310, printed p. 11. [Tariff](https://www.m-o.com/wp-content/uploads/2026/01/Tariff520.Jan1_.2026.pdf). Carrier-specific contractual example.
[^6]: Government of Canada, *Commercial Vehicle Drivers Hours of Service Regulations*, SOR/2005-313, sections 12–14 and 24–29. [Consolidated regulations](https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/FullText.html). Federal south-of-60 framework; applicability must be established separately.
[^7]: Government of Ontario, *Hours of Service*, O. Reg. 555/06, especially section 23. [Regulation](https://www.ontario.ca/laws/regulation/060555). Local RODS exemption and operator record obligations; indexed official text accessed.
[^8]: Transport Canada, *Electronic logging devices for commercial drivers and motor carriers*, undated. [Requirements](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/electronic-logging-devices-commercial-drivers-motor-carriers). Certified ELD boundary.
[^9]: Government of Ontario, *Daily trip inspection—classes A and D*, MTO Truck Handbook, and *Daily inspection test*. [Daily-trip guidance](https://www.ontario.ca/document/official-ministry-transportation-mto-truck-handbook/daily-trip-inspection-classes-and-d); [Defect examples](https://www.ontario.ca/document/official-ministry-transportation-mto-truck-handbook/daily-inspection-test). Official indexed text accessed.
[^10]: Ontario 511, *GET Truck Rest Areas API Documentation*, undated. [Schema](https://511on.ca/help/endpoint/truckrestareas). Parking amenity, direction, status and opening fields; no documented live stall counts.
[^11]: ONroute, *Cambridge North*, undated. [Operator location page](https://www.onroute.ca/locations/cambridge-north). Westbound access and 35 commercial spaces.
[^12]: ONroute, *Woodstock*, undated. [Operator location page](https://www.onroute.ca/locations/woodstock). Eastbound access and 78 commercial spaces.
[^13]: Ontario 511, *GET Events API Documentation*, undated. [Schema](https://511on.ca/help/endpoint/event). Directions, closure flag, schedules, geometry and restrictions.
[^14]: Rose Rocket, *Enabling ELD Integrations*, undated. [Integration documentation](https://help.roserocket.com/platform/enabling-eld-integration). Vendor-specific location refresh and HOS data fields.
[^15]: Government of Ontario, *Vehicle Weights and Dimensions*, O. Reg. 413/05, and *Guide to oversize/overweight vehicles and loads*. [Regulation](https://www.ontario.ca/laws/regulation/050413); [Guide](https://www.ontario.ca/page/guide-oversizeoverweight-vehicles-and-loads). Configuration and route/permit dependence; official indexed text accessed.
[^16]: Trimble, *TruckMate TMS: Capabilities & benefits*, undated, 2026 site copyright. [Product documentation](https://transportationinfo.trimble.com/brochure/truckmate-tms/capabilities-benefits). Offered billing, dispatch, matching and accounting scope.
[^17]: Axon, *Trucking Dispatch Software*, undated. [Product documentation](https://axonsoftware.com/trucking-dispatch-software/). Offered integrated workflows and customer visibility.
[^18]: Rose Rocket, *Dispatch Orders to Drivers*, undated. [Workflow documentation](https://help.roserocket.com/platform/dispatch-orders-to-drivers). Driver dispatch, response and completion workflow.

## Local implementation evidence

Paths and line numbers refer to the working tree inspected for this report and may move after later edits. They are code evidence, not deployment guarantees.

- **[C1] Runtime and active routes:** [runtime.js:14](/Users/hercules/projects/Gladiolus/src/runtime.js:14), [App.jsx:10](/Users/hercules/projects/Gladiolus/src/App.jsx:10), [events.js:141](/Users/hercules/projects/Gladiolus/src/engine/events.js:141). Browser-local store/simulator, active driver import and ephemeral event array.
- **[C2] Region and seeded reference data:** [corridor.js:9](/Users/hercules/projects/Gladiolus/src/data/corridor.js:9), [corridor.js:49](/Users/hercules/projects/Gladiolus/src/data/corridor.js:49), [corridor.js:140](/Users/hercules/projects/Gladiolus/src/data/corridor.js:140). Corridor vertices, parking access/capacity assumptions and vendor fixtures.
- **[C3] Event semantics and simulation:** [simulator.js:150](/Users/hercules/projects/Gladiolus/src/engine/simulator.js:150), [simulator.js:273](/Users/hercules/projects/Gladiolus/src/engine/simulator.js:273), [events.js:37](/Users/hercules/projects/Gladiolus/src/engine/events.js:37), [geofence.js:8](/Users/hercules/projects/Gladiolus/src/engine/geofence.js:8). Arrival/delivery conflation, wait range, post-movement HOS check, event fold and hysteresis.
- **[C4] Driver live/demo behavior:** [DriverPortal.jsx:129](/Users/hercules/projects/Gladiolus/src/driver/DriverPortal.jsx:129), [DriverPortal.jsx:190](/Users/hercules/projects/Gladiolus/src/driver/DriverPortal.jsx:190), [model.js:44](/Users/hercules/projects/Gladiolus/src/driver/model.js:44), [model.js:81](/Users/hercules/projects/Gladiolus/src/driver/model.js:81). Action routing, dock timer, isolated scenario store and offer check. Planning-only extensions: [plan.md:183](/Users/hercules/projects/Gladiolus/plan.md:183), [plan-dispatch.md:90](/Users/hercules/projects/Gladiolus/plan-dispatch.md:90).
- **[C5] Dispatcher mapping and metrics:** [MapPane.jsx:41](/Users/hercules/projects/Gladiolus/src/components/MapPane.jsx:41), [DispatchBoard.jsx:83](/Users/hercules/projects/Gladiolus/src/views/DispatchBoard.jsx:83), [metrics.js:11](/Users/hercules/projects/Gladiolus/src/engine/metrics.js:11), [Dashboard.jsx:79](/Users/hercules/projects/Gladiolus/src/views/Dashboard.jsx:79). Single basemap, parking-oriented board, dwell statistics and fleet charts.
- **[C6] HOS and optimistic reach:** [hos.js:12](/Users/hercules/projects/Gladiolus/src/engine/hos.js:12), [hos.js:37](/Users/hercules/projects/Gladiolus/src/engine/hos.js:37), [simulator.js:85](/Users/hercules/projects/Gladiolus/src/engine/simulator.js:85), [DriverPortal.jsx:212](/Users/hercules/projects/Gladiolus/src/driver/DriverPortal.jsx:212). Missing-clock defaults, speed floor, emitted fields and UI qualification.
- **[C7] Parking inference:** [parking.js:17](/Users/hercules/projects/Gladiolus/src/engine/parking.js:17), [parking.js:46](/Users/hercules/projects/Gladiolus/src/engine/parking.js:46), [parking.js:64](/Users/hercules/projects/Gladiolus/src/engine/parking.js:64), [parking.js:122](/Users/hercules/projects/Gladiolus/src/engine/parking.js:122), [simulator.js:344](/Users/hercules/projects/Gladiolus/src/engine/simulator.js:344). Share, baseline, double counting, direction-free selection and claim validation.
- **[C8] Traffic scope and closures:** [on511.js:41](/Users/hercules/projects/Gladiolus/src/services/on511.js:41), [on511.js:92](/Users/hercules/projects/Gladiolus/src/services/on511.js:92), [vite.config.js:8](/Users/hercules/projects/Gladiolus/vite.config.js:8). Normalization, closure multiplier and development proxy.
- **[C9] Inspection/reporting limitations:** [inspection.js:42](/Users/hercules/projects/Gladiolus/src/engine/inspection.js:42), [contract.js:190](/Users/hercules/projects/Gladiolus/src/contract.js:190), [DriverPortal.jsx:161](/Users/hercules/projects/Gladiolus/src/driver/DriverPortal.jsx:161). Clearing behavior, system-level defect classification and submitted fields; simulator does not gate on these reports.
- **[C10] AI layer:** [llm.js:12](/Users/hercules/projects/Gladiolus/src/services/llm.js:12), [llm.js:67](/Users/hercules/projects/Gladiolus/src/services/llm.js:67), [DispatchBoard.jsx:38](/Users/hercules/projects/Gladiolus/src/views/DispatchBoard.jsx:38). Canned advice, aggregate prompt input and only active ask workflow.
- **[C11] Customer tracking and authorization:** [CustomerView.jsx:13](/Users/hercules/projects/Gladiolus/src/views/CustomerView.jsx:13), [CustomerView.jsx:28](/Users/hercules/projects/Gladiolus/src/views/CustomerView.jsx:28), [AuthContext.jsx:19](/Users/hercules/projects/Gladiolus/src/auth/AuthContext.jsx:19). Truck-based lookup, ETA formula and unsigned token; browser-seeded staff auth in the same module.
- **[C12] Configuration outside the operational fold:** [settings.js:58](/Users/hercules/projects/Gladiolus/src/admin/settings.js:58), [settings.js:91](/Users/hercules/projects/Gladiolus/src/admin/settings.js:91). Local persistence and mutation of site configuration.
- **[C13] Existing verification:** [smoke.mjs:49](/Users/hercules/projects/Gladiolus/scripts/smoke.mjs:49), [smoke.mjs:71](/Users/hercules/projects/Gladiolus/scripts/smoke.mjs:71), [driver-smoke.mjs:1](/Users/hercules/projects/Gladiolus/scripts/driver-smoke.mjs:1). Selected replay assertions, permissive final-snapshot HOS test and driver scenario checks.
