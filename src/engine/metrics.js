import { EVENT } from '../contract.js'
import { SITE_BY_ID } from '../data/corridor.js'

/**
 * Dashboard metrics, all folds over the same log. Adding one of these never
 * needed a schema change — that is the whole argument for the append-only log,
 * so it is worth saying out loud when the dashboard comes up in the demo.
 */

/** Average time on site, worst first. The number a shipper argues about. */
export function dwellLeague(world) {
  const bySite = {}
  for (const d of world.dwells) {
    const row = (bySite[d.siteId] ??= { siteId: d.siteId, name: SITE_BY_ID[d.siteId]?.name ?? d.siteId, visits: 0, total: 0 })
    row.visits += 1
    row.total += d.minutes
  }
  return Object.values(bySite)
    .map((r) => ({ ...r, avg: Math.round(r.total / r.visits) }))
    .sort((a, b) => b.avg - a.avg)
}

/**
 * Laden against empty kilometres over time. Walks the ping stream and
 * differences each truck's odometer — the same arithmetic the live world fold
 * does, just kept per time bucket.
 *
 * Bucketed in quarter hours rather than hours: a demo is watched for minutes,
 * and hourly buckets leave the chart as one lonely point until the run is well
 * under way.
 */
export function kmOverTime(events, { bucketMin = 15, maxBuckets = 48 } = {}) {
  const size = bucketMin * 60_000
  const buckets = new Map()
  const lastOdo = new Map()

  for (const e of events) {
    if (e.type !== EVENT.PING) continue
    const prev = lastOdo.get(e.truckId)
    lastOdo.set(e.truckId, e.truck.odometerKm)
    if (prev == null) continue

    const delta = Math.max(0, e.truck.odometerKm - prev)
    if (delta === 0) continue

    const slot = Math.floor(e.at / size) * size
    const b = buckets.get(slot) ?? { slot, laden: 0, empty: 0 }
    if (e.truck.laden) b.laden += delta
    else b.empty += delta
    buckets.set(slot, b)
  }

  return [...buckets.values()]
    .sort((a, b) => a.slot - b.slot)
    .slice(-maxBuckets)
    .map((b) => ({
      ...b,
      label: new Date(b.slot).toLocaleTimeString('en-CA', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      }),
      laden: Math.round(b.laden),
      empty: Math.round(b.empty),
    }))
}

/** Where the fleet actually is right now. */
export function utilisation(world) {
  const counts = { driving: 0, dwelling: 0, resting: 0 }
  for (const t of Object.values(world.trucks)) counts[t.state] = (counts[t.state] ?? 0) + 1
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1
  return {
    counts,
    total,
    rows: [
      { name: 'Driving', value: counts.driving },
      { name: 'On site', value: counts.dwelling },
      { name: 'Resting', value: counts.resting },
    ],
  }
}
