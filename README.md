# Gladiolus Corridor

Shared fleet dispatch and detention operations for Southern Ontario. The product
connects order intake, feasibility-ranked assignment, driver acknowledgment,
ELD/GPS stop execution, detention review, customer tracking, and billing to one
durable event sequence.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). `npm run dev` starts both
the authoritative Node server on port 8787 and Vite on port 5173. The simulator
runs once on the server; separate browsers do not create separate fleet worlds.

Demo accounts:

- Dispatch: `dispatch@gladiolus.ca` / `corridor`
- Admin: `admin@gladiolus.ca` / `corridor`
- Driver: `GLD-101` / `8101` (through `GLD-140` / `8140`)

Passwords and PINs are seeded only on the server and stored as scrypt hashes.
They are not included in the production browser bundle.

To try the guided driver workflow without changing the shared fleet, open
`#/driver-demo/today` and choose **Loading at pickup** or **Unloading at
delivery**. The driver confirms check-in, loading/unloading, and gate-out; the
simulated trailer state changes only when those milestone events are confirmed.

## Product surfaces

| Surface | Route | Access |
|---|---|---|
| Dispatch control tower | `#/board` | dispatch/admin |
| Fleet analytics | `#/dashboard` | dispatch/admin |
| Detention ledger | `#/detention` | dispatch/admin |
| Shipment timeline | `#/timeline` | dispatch/admin |
| Administration | `#/admin` | admin |
| Driver workflow | `#/driver` | assigned driver |
| Customer tracking | `#/t/<grant>` | signed shipment grant |

The dispatch board can quote and post a load, compare available trucks, and
offer only after the server verifies fresh HOS, vehicle availability, route,
equipment, payload, gross weight, and estimated/measured axle groups. The
driver sees that same offer and accepts or rejects it through an authorized
command. Exceptions remain owned and visible instead of silently falling back
to an infeasible load.

The map includes standard and satellite basemaps, active routes, historical
breadcrumbs, timestamped speed samples, distance, average speed, and data age.
Customer links resolve the assigned truck from the shipment event stream; a
fresh customer browser receives only that shipment and its telemetry.

## Architecture

```text
order webhook ─┐
ELD webhook ───┼──▶ authenticated adapters ──▶ durable event log
server sim ────┘                                  │
                                                  ├──▶ command/load projections
browser commands ──▶ role + feasibility gates ────┤
                                                  └──▶ paged SSE replay/live tail
                                                           │
                                     dispatch / driver / customer browsers
```

The server is authoritative. PostgreSQL is the production store; local
development and tests use a file-backed SQLite implementation of the same async
interface. On startup, the load board, assignment state, integration identity
map, site configuration, visits, claims, and read projections are rebuilt from
durable events/records.

SSE clients reconnect from the last scanned sequence. Replay drains every
500-event page before acknowledging the cursor, and registration happens before
replay so a concurrent append cannot fall into a replay/live gap.

The simulator remains a physical data source rather than application state. It
emits the same observation envelope used by integrations and runs only in the
server process when enabled. Production browser builds always use the
same-origin server even when `VITE_SERVER_URL` is empty.

## Stop and detention workflow

Real ELD position observations run through the same geofence transition logic
as simulated observations. For an intended shipment stop, entry emits arrival;
exit emits gate-out and an explicitly inferred service-completion boundary when
the driver has not confirmed one. A qualifying 150-minute visit under the demo
two-hour rule produces 30 billable minutes, rounded under the versioned rule.

Inferred evidence carries an uncertainty note and requires staff review before
billing. Billing exports only claims whose latest state is `reviewed`, uses the
calculated amount/currency, emits `detention.exported`, and will not export the
same claim twice.

## Security boundaries

- Every operational route validates a signed, expiring HMAC session.
- Driver commands are scoped to the signed driver's truck and assignment.
- Admin commands are enforced server-side, not by route visibility.
- Raw observation ingestion requires an integration-role token and accepts only
  observation event types with `providerId` and `observedAt`.
- ELD and order webhooks require `X-Integration-Key`, or a signed
  integration/admin session. Missing configuration never enables anonymous
  writes.
- Customer grants are URL-safe, signed, expiring, revocable, and filtered by
  `shipmentId` on event history, SSE, and projections.
- Browser origins are same-origin by default; additional production origins
  must be listed in `CORS_ORIGINS`.
- LLM, TomTom, Ontario 511, and OSRM calls go through server proxies. Provider
  keys never enter the browser bundle.

## Configuration

Copy `.env.example` to `.env` for standalone or Docker deployment.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string; unset uses SQLite for dev |
| `SESSION_SECRET` | Required production session/grant signing secret |
| `INTEGRATION_API_KEY` | Required credential for ELD/order webhooks |
| `CORS_ORIGINS` | Optional comma-separated additional browser origins |
| `RUN_SIM` | Set `true` only for a shared demo deployment |
| `LLM_KEY` | Optional server-side Anthropic key |
| `TOMTOM_KEY` | Optional server-side flow key |
| `OSRM_URL` | Optional carrier-owned OSRM base URL |
| `BILLING_EXPORT_PATH` | Billing CSV destination; defaults to `./exports` |
| `VITE_SERVER_URL` | Dev-only API origin; production is same-origin |

Without the optional traffic/LLM providers the UI clearly labels and uses its
bundled fixtures. Operational data never falls back to a per-browser simulator
in a production build.

## Production container

Set strong values for `SESSION_SECRET` and `INTEGRATION_API_KEY` in `.env`, then:

```bash
docker compose up --build
```

The multi-stage image builds the Vite client and serves it with the API from one
non-root Node process on port 8787. Compose provisions PostgreSQL and waits for
its health check. The PostgreSQL migration uses native `BIGSERIAL`, `BIGINT`,
and `JSONB` DDL.

## Integration examples

Order intake:

```bash
curl -X POST http://localhost:8787/api/integrations/orders/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Integration-Key: YOUR_KEY' \
  -d '{"externalId":"ORD-77","originId":"london-dc","destinationId":"milton-intermodal","payloadKg":18000,"revenue":1850,"equipment":["dry-van"]}'
```

ELD observations may include provider driver/vehicle identifiers or mapped
Corridor identifiers, coordinates, odometer/speed, full duty counters,
equipment, tare/gross limits, and measured axle groups. Identity mappings are
persisted so a restart does not break reconciliation.

## Verification

```bash
npm test
npm run smoke
npm run proof
npm run build
```

`npm run proof` is the adversarial system check. It verifies native PostgreSQL
DDL, lossless replay of 1,205 events across the old 500-event boundary, and an
authenticated order → feasible offer → driver acceptance → real ELD geofence →
30-minute detention → reviewed billing export flow. It closes and reopens the
database and verifies that assignment, identity mapping, claim/export, and admin
configuration survive.

## Honest limits

- The included ELD/order shapes are production boundaries and sample adapters;
  a carrier still has to supply its vendor credentials, field mapping, and
  contract-specific detention rules.
- The parking layer is an estimate from observed fleet occupancy blended with a
  time-of-day prior. It exposes observed count, sample confidence, and capacity.
- Axle distribution is explicitly marked as an estimate unless measured axle
  weights are supplied. Missing payload/tare data is unresolved, never feasible.
- The included detention rule and demo accounts are seed data, not universal
  commercial or identity policy.
- SQLite is a development fallback. Production deployments should use the
  PostgreSQL path exercised by the container configuration.
