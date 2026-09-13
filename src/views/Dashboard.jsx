import { useMemo } from 'react'
import { useStore, useWorld } from '../useStore.js'
import { dwellLeague, kmOverTime, utilisation } from '../engine/metrics.js'
import { fmtKm, pct } from '../format.js'

const CHART = { width: 900, height: 210, left: 48, right: 12, top: 12, bottom: 30 }

function linePath(points) {
  return points.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
}

function AreaPerformanceChart({ data }) {
  if (!data.length) return <p className="sub">Waiting for enough movement to chart.</p>
  const { width, height, left, right, top, bottom } = CHART
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const maximum = Math.max(1, ...data.map((row) => row.laden + row.empty))
  const x = (index) => left + (data.length === 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth)
  const y = (value) => top + plotHeight - (value / maximum) * plotHeight
  const laden = data.map((row, index) => [x(index), y(row.laden)])
  const total = data.map((row, index) => [x(index), y(row.laden + row.empty)])
  const baseline = top + plotHeight
  const ladenArea = `${linePath(laden)} L${laden.at(-1)[0]},${baseline} L${laden[0][0]},${baseline} Z`
  const emptyArea = `${linePath(total)} ${linePath([...laden].reverse()).replace(/^M/, 'L')} Z`
  const tickIndexes = [...new Set(Array.from({ length: Math.min(6, data.length) }, (_, i) =>
    Math.round((i / Math.max(1, Math.min(6, data.length) - 1)) * (data.length - 1))))]

  return (
    <div style={{ height: 240, overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" role="img" aria-label="Laden and empty kilometres over time">
        <title>Laden and empty kilometres over time</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridY = y(maximum * ratio)
          return <g key={ratio}><line x1={left} x2={width - right} y1={gridY} y2={gridY} stroke="#293343" /><text x={left - 8} y={gridY + 4} textAnchor="end" fill="#8b97a8" fontSize="11">{Math.round(maximum * ratio)}</text></g>
        })}
        <path d={ladenArea} fill="#4ea3ff" fillOpacity=".35" />
        <path d={emptyArea} fill="#ffb020" fillOpacity=".35" />
        <path d={linePath(laden)} fill="none" stroke="#4ea3ff" strokeWidth="2" />
        <path d={linePath(total)} fill="none" stroke="#ffb020" strokeWidth="2" />
        {data.map((row, index) => <circle key={row.slot} cx={x(index)} cy={y(row.laden + row.empty)} r="8" fill="transparent"><title>{row.label}: {row.laden} km laden, {row.empty} km empty</title></circle>)}
        {tickIndexes.map((index) => <text key={index} x={x(index)} y={height - 7} textAnchor="middle" fill="#8b97a8" fontSize="11">{data[index].label}</text>)}
        <g transform={`translate(${width - 170},${top + 4})`} fontSize="11"><rect width="10" height="10" fill="#4ea3ff" fillOpacity=".7" /><text x="15" y="9" fill="#8b97a8">Laden</text><rect x="75" width="10" height="10" fill="#ffb020" fillOpacity=".7" /><text x="90" y="9" fill="#8b97a8">Empty</text></g>
      </svg>
    </div>
  )
}

function DwellBarChart({ data }) {
  const width = 900
  const height = Math.max(160, data.length * 34 + 30)
  const left = 180
  const right = 36
  const maximum = Math.max(1, ...data.map((row) => row.avg))
  const plotWidth = width - left - right
  return (
    <div style={{ height, overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" role="img" aria-label="Average dwell minutes by site">
        <title>Average dwell minutes by site</title>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gridX = left + ratio * plotWidth
          return <g key={ratio}><line x1={gridX} x2={gridX} y1="4" y2={height - 24} stroke="#293343" /><text x={gridX} y={height - 7} textAnchor="middle" fill="#8b97a8" fontSize="11">{Math.round(maximum * ratio)}</text></g>
        })}
        {data.map((row, index) => {
          const y = index * 34 + 8
          const barWidth = (row.avg / maximum) * plotWidth
          return <g key={row.siteId}><title>{row.name}: {row.avg} average minutes across {row.visits} visits</title><text x={left - 10} y={y + 17} textAnchor="end" fill="#8b97a8" fontSize="11">{row.name}</text><rect x={left} y={y} width={barWidth} height="22" rx="3" fill="#3ddc97" /><text x={Math.min(width - right - 4, left + barWidth + 7)} y={y + 16} fill="#cbd5e1" fontSize="11">{row.avg} min</text></g>
        })}
      </svg>
    </div>
  )
}

export default function Dashboard() {
  const world = useWorld()
  const store = useStore()

  // Walking 13k+ ping events is not free, so recompute once per bucket rather
  // than on every tick.
  const bucketKey = Math.floor(world.clock / (5 * 60_000))
  const series = useMemo(() => kmOverTime(store.events), [bucketKey, store])

  const league = useMemo(() => dwellLeague(world), [world])
  const util = useMemo(() => utilisation(world), [world])
  const emptyShare = world.ladenKm + world.emptyKm > 0
    ? world.emptyKm / (world.ladenKm + world.emptyKm)
    : 0

  return (
    <div className="page">
      <div className="cards">
        <div className="card">
          <h3>Empty running</h3>
          <div className="big">{pct(emptyShare)}</div>
          <div className="sub">{fmtKm(world.emptyKm)} empty of {fmtKm(world.ladenKm + world.emptyKm)}</div>
        </div>
        <div className="card">
          <h3>Completed stops</h3>
          <div className="big">{world.dwells.length}</div>
          <div className="sub">{world.transits} drive-throughs not counted as visits</div>
        </div>
        <div className="card">
          <h3>Out of hours on the shoulder</h3>
          <div className="big" style={{ color: world.forcedStops ? 'var(--crit)' : undefined }}>
            {world.forcedStops}
          </div>
          <div className="sub">Drivers who ran out of clock with no lot in reach</div>
        </div>
        <div className="card">
          <h3>Fleet right now</h3>
          <div className="big">{util.counts.driving}/{util.total}</div>
          <div className="sub">driving · {util.counts.dwelling} on site · {util.counts.resting} resting</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Laden against empty kilometres</h3>
        <AreaPerformanceChart data={series} />
        <p className="sub">
          Empty kilometres are the backhaul opportunity: every one of them is a
          truck being paid for by nobody.
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Dwell league table — average minutes on site</h3>
        {league.length === 0 && <p className="sub">No completed stops yet.</p>}
        {league.length > 0 && (
          <>
            <DwellBarChart data={league} />
            <table style={{ marginTop: 10 }}>
              <thead>
                <tr><th>Site</th><th className="num">Visits</th><th className="num">Avg</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {league.map((r) => (
                  <tr key={r.siteId}>
                    <td>{r.name}</td>
                    <td className="num">{r.visits}</td>
                    <td className="num">{r.avg} min</td>
                    <td className="num">{r.total} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <p className="note" style={{ paddingLeft: 0 }}>
        Every figure here is a fold over the same event log — {store.events.length.toLocaleString('en-CA')} events
        so far. None of them required a schema change to add.
      </p>
    </div>
  )
}
