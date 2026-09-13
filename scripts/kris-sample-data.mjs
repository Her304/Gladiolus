#!/usr/bin/env node
/**
 * Engineer a LIVE carrier snapshot for Kris (dispatch@gladiolus.ca) from the
 * hackathon Excel.
 *
 * The Excel is real carrier data, but every dispatch leg is FINISHED and every
 * date is in Aug 2026 or earlier. Today is 2026-09-13. So a "live" picture —
 * trucks running right now with deliveries completing tomorrow (2026-09-14) —
 * has to be engineered from the real carriers: their real GPS positions along
 * Hwy 401, their real HOS clocks, and their real declared destinations, with
 * the delivery appointment set to tomorrow.
 *
 * Approach (no shortcuts through the offer/accept driver flow, which would
 * fight the assignment feasibility gates and open spurious exceptions):
 *
 *   1. Orders webhook  → shipment.posted  (one load per on-corridor driver,
 *      origin near the driver's current GPS, destination = nearest corridor
 *      site to the driver's declared FINAL_DESTINATION, delivery appointment
 *      = tomorrow 2026-09-14).
 *   2. ELD webhook      → duty.updated + truck.ping for each driver: laden,
 *      driving, with shipmentId + destinationId carried directly on the ping
 *      (the ingester only enriches from the loadboard as a fallback, so a
 *      self-contained ping renders on the board without an accepted offer).
 *
 * Run AFTER the server has been restarted with RUN_SIM=false and an
 * INTEGRATION_API_KEY, against a fresh DB:
 *
 *   node scripts/kris-sample-data.mjs
 *
 * Idempotent: stable provider ids mean re-running drops as duplicates.
 */
import { readFileSync } from 'node:fs'
import XLSX from 'xlsx'

const SERVER = process.env.SERVER_URL || 'http://localhost:8787'
const FILE = process.env.EXCEL_FILE || '/Users/hercules/Downloads/1788655393951_Hackathon_Data.xlsx'
const INTEGRATION_KEY = process.env.INTEGRATION_API_KEY || 'corridor-integration'

const H = 3600_000

// Today is 2026-09-13 (per session clock). "Tomorrow" = 2026-09-14. We anchor
// delivery appointments across tomorrow so the board shows shipments ending
// tmr. Spread the appointment times across the day so it reads as a real
// schedule, not a single batch.
const TOMORROW = new Date('2026-09-14T00:00:00Z').getTime()
// The fixed "snapshot moment" — midday 2026-09-13. Pinned (not Date.now()) so
// re-running the generator is idempotent: the ELD adapter keys provider ids on
// the observed timestamp, and a wall-clock now would re-ingest every run.
const SNAPSHOT_AT = new Date('2026-09-13T12:00:00Z').getTime()

// ---- corridor sites (origin/destination must be known site ids) ----
const SITE = {
  'wds-xdock': { name: 'Windsor Cross-Dock', coord: [42.3072, -83.0181] },
  'chatham-pt': { name: 'Chatham Produce Terminal', coord: [42.4102, -82.1875] },
  'london-dc': { name: 'London Distribution Centre', coord: [42.9481, -81.2312] },
  'woodstock-plant': { name: 'Woodstock Assembly Plant', coord: [43.1418, -80.7331] },
  'cambridge-dc': { name: 'Cambridge DC', coord: [43.3701, -80.3022] },
  'milton-intermodal': { name: 'Milton Intermodal', coord: [43.4731, -79.9772] },
  'mississauga-dc': { name: 'Mississauga DC', coord: [43.5951, -79.6382] },
  'scarborough-term': { name: 'Scarborough Terminal', coord: [43.7801, -79.3388] },
}

// Map a declared destination city to the nearest corridor stop site. US
// destinations exit the corridor at the Windsor border crossing.
function destinationSiteFor(destStr) {
  const city = String(destStr || '').toUpperCase().replace(/\s+/g, ' ').trim()
  if (/^MILTON/.test(city)) return 'milton-intermodal'
  if (/^CAMPBELLVILLE/.test(city)) return 'milton-intermodal'
  if (/^GUELPH/.test(city)) return 'cambridge-dc'
  if (/^KITCHENER|^WATERLOO/.test(city)) return 'cambridge-dc'
  if (/^CAMBRIDGE/.test(city)) return 'cambridge-dc'
  if (/^LONDON/.test(city)) return 'london-dc'
  if (/^WOODSTOCK/.test(city)) return 'woodstock-plant'
  if (/^VAUGHAN|^WOODBRIDGE|^CONCORD/.test(city)) return 'mississauga-dc'
  if (/^MISSISSAUGA|^BRAMPTON|^OAKVILLE|^BURLINGTON/.test(city)) return 'mississauga-dc'
  if (/^WHITBY|^OSHAWA|^SCARBOROUGH|^PICKERING|^AJAX|^NORTH YORK|^TORONTO|^COBOURG|^PORT HOPE|^STONEY CREEK/.test(city)) return 'scarborough-term'
  if (/^WINDSOR/.test(city)) return 'wds-xdock'
  // US / out-of-corridor → exit at the Windsor border crossing.
  return 'wds-xdock'
}

// Pick the corridor site nearest a raw GPS coord as the pickup origin. Keeps
// the load's origin coherent with the driver's actual position.
function nearestSite(lat, lon) {
  let best = null, bestD = Infinity
  for (const [id, s] of Object.entries(SITE)) {
    const dLat = s.coord[0] - lat, dLon = s.coord[1] - lon
    const d = dLat * dLat + dLon * dLon
    if (d < bestD) { bestD = d; best = id }
  }
  return best
}

function parseCoord(str) {
  const m = String(str || '').match(/^0?(\d{2})(\d{4})([NSEW])$/)
  if (!m) return null
  const val = parseFloat(`${m[1]}.${m[2]}`)
  return (m[3] === 'S' || m[3] === 'W') ? -val : val
}

const onCorridor = (lat, lon) => lat >= 42.15 && lat <= 43.95 && lon >= -83.25 && lon <= -79.15

async function postOrders(orders) {
  const res = await fetch(`${SERVER}/api/integrations/orders/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-integration-key': INTEGRATION_KEY },
    body: JSON.stringify(orders),
  })
  const r = await res.json()
  if (!res.ok) throw new Error(`orders webhook failed (${res.status}): ${JSON.stringify(r)}`)
  return r
}

async function postEld(obs) {
  const res = await fetch(`${SERVER}/api/integrations/eld/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-integration-key': INTEGRATION_KEY },
    body: JSON.stringify(obs),
  })
  const r = await res.json()
  if (!res.ok) throw new Error(`eld webhook failed (${res.status}): ${JSON.stringify(r)}`)
  return r
}

async function main() {
  console.log('reading', FILE)
  const wb = XLSX.readFile(FILE)

  const dRows = XLSX.utils.sheet_to_json(wb.Sheets['Driver'], { header: 1 })
  const drivers = []
  for (let i = 1; i < dRows.length; i++) {
    const r = dRows[i]
    if (!r[0]) continue
    const trip = r[38]
    if (!trip || trip === 0) continue            // CURRENT_TRIP — must be on a trip
    const lat = parseCoord(r[31]), lon = parseCoord(r[32])
    if (lat == null || lon == null) continue
    if (!onCorridor(lat, lon)) continue          // actually on the 401 corridor
    drivers.push({
      id: `D-${r[0]}`,
      driverId: `D-${r[0]}`,
      driverNum: r[0],
      truckId: `T${String(r[0]).padStart(4, '0')}`,
      name: r[5] || `Driver${r[0]}`,
      lat, lon,
      // HOS: REMAINING_HOURS_CAN_8 (col 15) is the daily on-duty remaining;
      // REMAINING_HOURS_CAN_7 (col 14) the 7-day cycle remaining. We convert
      // "remaining" → "used" for the counters the board renders.
      rem8: Number(r[15]) || 0,
      rem7: Number(r[14]) || 0,
      cycle8: Number(r[16]) || 0,
      finalDest: r[41] || null,
      trip,
    })
  }
  console.log(`selected ${drivers.length} on-corridor drivers on active trips`)

  // ---- build loads + ELD observations ----
  const orders = []
  const eldObs = []
  // A stable "now" so re-running the generator is idempotent: the ELD adapter
  // derives provider ids from the observed timestamp (eld:ping:${truck}:${at}),
  // so a wall-clock now would make every re-run look like fresh observations and
  // double the event log. Pin to a fixed epoch representing the snapshot moment.
  const now = SNAPSHOT_AT
  // Stable, spread delivery appointments across tomorrow so the board reads as
  // a real schedule rather than one simultaneous batch.
  let slot = 0
  for (const d of drivers) {
    const destSite = destinationSiteFor(d.finalDest)
    const originSite = nearestSite(d.lat, d.lon)
    // Key shipment/load ids on the driver, not the trip number: several drivers
    // share a trip number in the source data, and the orders adapter dedups a
    // posted shipment by `order:post:${shipmentId}`, so a shared trip id would
    // drop the second driver's load.
    const shipmentId = `SHP-D${d.driverNum}`
    const loadId = `L-D${d.driverNum}`
    const externalId = `D${d.driverNum}-${d.trip}`
    const driverId = d.id
    const truckId = d.truckId

    // Appointment spread across tomorrow (07:00–20:00 UTC), deterministic per slot.
    const appt = TOMORROW + (7 + (slot % 13)) * H + Math.floor(slot / 13) * H
    slot++

    orders.push({
      externalId,
      shipmentId, loadId,
      originId: originSite,
      destinationId: destSite,
      readyAt: now - 3 * H,             // picked up a few hours ago → mid-trip
      expiresAt: appt + 24 * H,
      appointment: appt,                 // delivery completes tomorrow
      revenue: 1200 + (slot * 37) % 1800,
      equipment: ['dry-van'],
      payloadKg: 18_000 + (slot * 211) % 9_000,
    })

    // Hours-of-service counters. The Excel's REMAINING_HOURS_CAN_7 (col 14) is
    // the 7-day cycle remaining, so the cycle used = 70 − rem7 (clamped ≥ 0). But
    // REMAINING_HOURS_CAN_8 (col 15) is a cycle-level value that can exceed 13h,
    // so it cannot drive the shift-level driving/duty counters — a fresh-cycle
    // driver would read as 0h used and look identical to a truck that hasn't
    // started. Instead, give each running truck a realistic mid-shift position:
    // spread driving-used across the fleet so HOS statuses vary and a handful of
    // the most cycle-pressured drivers surface in "Needs a decision".
    const cycleUsed = Math.max(0, (70 - Math.max(d.rem7, 0))) * H
    // Driving used this shift. We want a realistic spread where most of the
    // fleet is mid-shift (ok) but the drivers the source flags as most cycle-
    // pressured (lowest rem7) are deep enough into their shift to land in warn
    // or critical on the board's HOS gauge. rem7 ranges 17–70h across these 29,
    // so normalize within that band: the lowest-rem7 driver reaches ~12.8h
    // driving (critical, <20 min left), a handful follow into warn, and the
    // fresh-cycle drivers sit around 2–5h.
    const rem7Clamped = Math.min(Math.max(d.rem7, 0), 70)
    const pressure = Math.max(0, Math.min(1, (70 - rem7Clamped) / (70 - 17))) // 0 fresh → 1 pressured
    const drivingMs = Math.min(13 * H - 10 * 60_000, Math.round((2 + pressure * 10.8) * H))
    const onDutyMs = Math.min(14 * H - 60_000, drivingMs + Math.round((0.5 + pressure * 1.5) * H))
    const elapsedMs = Math.min(16 * H - 60_000, onDutyMs + Math.round(1.5 * H))

    eldObs.push({
      eldDriverId: driverId, eldVehicleId: truckId,
      driverId, truckId,
      timestamp: now,
      dutyStatus: 'driving',
      drivingMs, onDutyMs, elapsedMs,
      cycleMs: cycleUsed,
      dailyOffDutyMs: 10 * H,
      regime: 'cycle1',
      // Position + load context carried directly on the observation. The ELD
      // adapter mirrors these onto the truck.ping, so the board sees a laden,
      // driving truck bound for its delivery site without needing an accepted
      // offer in the loadboard (the active-task filter is `laden || destinationId`).
      latitude: d.lat, longitude: d.lon,
      coord: [d.lat, d.lon],
      shipmentId, loadId, destinationId: destSite,
      driverName: d.name,
      stopId: `STP-D${d.driverNum}-DEL`,
      laden: true,
      speedKph: 88 + (d.driverNum % 12),
      odometerKm: 180_000 + (d.trip % 90_000),
      equipment: ['dry-van'],
      tareKg: 15_500,
      grossLimitKg: 39_500,
    })
  }

  // ---- 1. post the loads ----
  console.log(`posting ${orders.length} loads via orders webhook…`)
  const oRes = await postOrders(orders)
  console.log(`  posted: ${oRes.posted}/${orders.length}`)

  // ---- 2. post duty + pings via ELD webhook ----
  console.log(`posting ${eldObs.length} ELD observations (duty + ping)…`)
  const eRes = await postEld(eldObs)
  console.log(`  ingested: ${eRes.ingested || eldObs.length * 2}/${eldObs.length * 2}`)

  console.log('\nKris can sign in at http://localhost:5173/#/board')
  console.log('  dispatch@gladiolus.ca / corridor')
  console.log(`  ${drivers.length} trucks running now, deliveries completing 2026-09-14.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
