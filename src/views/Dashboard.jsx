import { useMemo } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { useStore, useWorld } from '../useStore.js'
import { dwellLeague, kmOverTime, utilisation } from '../engine/metrics.js'
import { fmtKm, pct } from '../format.js'

const AXIS = { stroke: '#8b97a8', fontSize: 11 }
const TOOLTIP = {
  contentStyle: { background: '#141a24', border: '1px solid #293343', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#8b97a8' },
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
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid stroke="#293343" vertical={false} />
              <XAxis dataKey="label" {...AXIS} tickLine={false} />
              <YAxis {...AXIS} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP} formatter={(v) => `${v} km`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="laden" name="Laden" stackId="1" stroke="#4ea3ff" fill="#4ea3ff" fillOpacity={0.35} />
              <Area type="monotone" dataKey="empty" name="Empty" stackId="1" stroke="#ffb020" fill="#ffb020" fillOpacity={0.35} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
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
            <div style={{ height: Math.max(160, league.length * 34) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={league} layout="vertical" margin={{ top: 4, right: 16, left: 96, bottom: 0 }}>
                  <CartesianGrid stroke="#293343" horizontal={false} />
                  <XAxis type="number" {...AXIS} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={150} {...AXIS} tickLine={false} axisLine={false} />
                  <Tooltip {...TOOLTIP} formatter={(v) => `${v} min`} />
                  <Bar dataKey="avg" name="Average dwell" fill="#3ddc97" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
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
