#!/usr/bin/env node
/**
 * Import real carrier data from the hackathon Excel file into the Corridor
 * system. Creates drivers, trucks, loads (from Tlorder), and dispatch legs
 * as domain events in the server's store. Run after the server is up:
 *
 *   node scripts/import-hackathon-data.mjs
 *
 * The data is real-world: 131 drivers with positions + HOS, 4032 loads, 10480
 * dispatch legs. This is "plain data" (the user's term) — real carrier
 * operations, not the seeded demo sim.
 */
import { readFileSync } from 'node:fs'
import XLSX from 'xlsx'

const SERVER = process.env.SERVER_URL || 'http://localhost:8787'
const FILE = process.env.EXCEL_FILE || '/Users/hercules/Downloads/1788655393951_Hackathon_Data.xlsx'

// ---- admin login (creates the system account if needed) ----
async function adminLogin() {
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@gladiolus.ca', password: 'corridor' }),
  })
  const r = await res.json()
  if (!r.ok) throw new Error(`admin login failed: ${r.error}`)
  return r.token
}

// ---- parse a "0433201N" lat/lon string into a decimal degree ----
// Format: DDMMMMMH → DD.MMMMM degrees (e.g. "0433201N" = 43.3201° N)
function parseCoord(str) {
  const m = String(str || '').match(/^0?(\d{2})(\d{4})([NSEW])$/)
  if (!m) return null
  const val = parseFloat(`${m[1]}.${m[2]}`)
  return (m[3] === 'S' || m[3] === 'W') ? -val : val
}

// ---- Excel date serial → ms epoch ----
function excelDate(serial) {
  if (typeof serial !== 'number') return null
  // Excel epoch: 1900-01-01 is day 1, with a leap-year bug for 1900.
  return Math.round((serial - 25569) * 86400 * 1000)
}

async function main() {
  console.log('reading', FILE)
  const wb = XLSX.readFile(FILE)
  const token = await adminLogin()
  console.log('logged in as admin')

  // ---- Drivers ----
  const dRows = XLSX.utils.sheet_to_json(wb.Sheets['Driver'], { header: 1 })
  const drivers = []
  for (let i = 1; i < dRows.length; i++) {
    const r = dRows[i]
    if (!r[0] || r[5] === '<null>') continue
    const lat = parseCoord(r[31])
    const lon = parseCoord(r[32])
    if (lat == null || lon == null) continue
    drivers.push({
      id: `D-${r[0]}`,
      name: r[5] || `Driver${r[0]}`,
      email: r[4] || `driver${r[0]}@carrier.local`,
      truckId: `T${String(r[0]).padStart(4, '0')}`,
      lat, lon,
      remainingHours: r[8] || 0,
      cycleHours7: r[14] || 0,
      cycleHours8: r[15] || 0,
      cycleHours14: r[16] || 0,
      status: r[35] || 'UNKNOWN',
      active: r[34] === true,
      currentTrip: r[38] || 0,
      finalDestination: r[41] || null,
      homeZone: r[1] || null,
    })
  }
  console.log(`parsed ${drivers.length} drivers`)

  // Post each driver as a duty.updated + truck.ping event.
  let posted = 0
  for (const d of drivers) {
    // duty.updated — the HOS snapshot. The Excel's REMAINING_HOURS is the cycle
    // remaining (can be >13). REMAINING_HOURS_CAN_8 (col 15) is the daily on-duty
    // remaining (≤14h). Use that for drivingMs/onDutyMs; cycle7 for cycleMs.
    const dailyRemaining = Math.min(d.cycleHours8 || d.remainingHours || 13, 14)
    const remainingMs = dailyRemaining * 3600_000
    const cycleUsed = Math.max(0, (70 - (d.cycleHours7 || 70))) * 3600_000
    await fetch(`${SERVER}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'duty.updated', providerId: `eld-duty-${d.id}`, observedAt: Date.now(),
        source: 'eld', driverId: d.id, truckId: d.truckId,
        drivingMs: Math.max(0, 13 * 3600_000 - remainingMs),
        onDutyMs: Math.max(0, 14 * 3600_000 - remainingMs),
        elapsedMs: 0, cycleMs: cycleUsed,
        regime: 'cycle1', dutyStatus: d.active ? 'driving' : 'off',
      }),
    })
    // truck.ping — the position
    await fetch(`${SERVER}/api/events/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'truck.ping', providerId: `eld-ping-${d.truckId}`, observedAt: Date.now(),
        source: 'eld', truckId: d.truckId, driverId: d.id, shipmentId: null,
        truck: {
          id: d.truckId, driverId: d.id, driverName: d.name,
          coord: [d.lat, d.lon], speedKph: d.active ? 90 : 0,
          odometerKm: 100000, state: d.active ? 'driving' : 'resting',
          heading: 0, direction: 1, chainage: 0, laden: false,
        },
      }),
    })
    posted++
    if (posted % 20 === 0) console.log(`  posted ${posted}/${drivers.length} drivers`)
  }
  console.log(`posted ${posted} drivers as events`)

  // ---- Loads (Tlorder) — post a sample as open loads ----
  const tRows = XLSX.utils.sheet_to_json(wb.Sheets['Tlorder'], { header: 1 })
  let loadCount = 0
  for (let i = 1; i < Math.min(tRows.length, 50); i++) {
    const r = tRows[i]
    if (!r[1]) continue
    const billNumber = String(r[1])
    const originCity = r[4] || 'Unknown'
    const destCity = r[11] || 'Unknown'
    const distance = r[18] || 0
    const weight = r[31] || 0
    const loadType = r[29] || 'Dry Van'
    const revenue = 500 + (distance * 1.5)
    // Post as a command (creates a load in the loadboard)
    const res = await fetch(`${SERVER}/api/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'postLoad',
        load: {
          id: `L-${billNumber}`,
          shipmentId: `SHP-${billNumber}`,
          originId: originCity,
          destinationId: destCity,
          readyAt: Date.now(),
          revenue: Math.round(revenue),
          equipment: [loadType],
          payloadKg: weight ? Math.round(weight * 0.453592) : null,
        },
      }),
    })
    if (res.ok) loadCount++
  }
  console.log(`posted ${loadCount} loads from Tlorder`)

  // ---- Dispatch legs — post as shipment milestones for active trips ----
  const dispRows = XLSX.utils.sheet_to_json(wb.Sheets['Dispatch'], { header: 1 })
  let legCount = 0
  for (let i = 1; i < Math.min(dispRows.length, 100); i++) {
    const r = dispRows[i]
    const driver = r[4]
    const legStat = r[9]
    const originZone = r[25] || r[14]
    const destZone = r[26] || r[15]
    const tripNumber = r[1]
    if (!driver || !tripNumber) continue
    // Post active dispatch legs as stop events
    const stopId = `STP-${tripNumber}-${r[2]}`
    const driverMatch = drivers.find((d) => d.name === driver)
    if (!driverMatch) continue
    if (legStat === 'FINISHED' || r[12] === 'COMPLETE') {
      await fetch(`${SERVER}/api/events/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'stop.service_completed', providerId: `disp-${stopId}-${driver}`,
          observedAt: Date.now(), source: 'tms',
          shipmentId: `SHP-${tripNumber}`, stopId,
          truckId: driverMatch.truckId, facilityId: destZone,
        }),
      })
      legCount++
    }
  }
  console.log(`posted ${legCount} dispatch leg completions`)

  console.log('\ndone. Data is live in the server.')
  console.log('Admin can view it at http://localhost:5173/#/board')
  console.log('Dispatch can view loads at http://localhost:5173/#/detention')
}

main().catch((e) => { console.error(e); process.exit(1) })
