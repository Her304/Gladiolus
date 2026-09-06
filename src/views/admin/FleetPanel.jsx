import { useMemo, useState } from 'react'
import { useWorld } from '../../useStore.js'
import { SITE_BY_ID } from '../../data/corridor.js'
import { clockLeftMs, hosStatus, fmtClock } from '../../engine/hos.js'
import { fmtKm } from '../../format.js'

const COLUMNS = [
  { id: 'id', label: 'Truck', get: (t) => t.id },
  { id: 'plate', label: 'Plate', get: (t) => t.plate },
  { id: 'driverName', label: 'Driver', get: (t) => t.driverName },
  { id: 'state', label: 'State', get: (t) => t.state },
  { id: 'load', label: 'Load', get: (t) => t.loadId || '' },
  { id: 'chainage', label: 'Chainage', get: (t) => t.chainage, num: true },
  { id: 'speedKph', label: 'Speed', get: (t) => t.speedKph, num: true },
  { id: 'odometerKm', label: 'Odometer', get: (t) => t.odometerKm, num: true },
  { id: 'clock', label: 'Clock left', get: (t) => clockLeftMs(t), num: true },
]

/**
 * The fleet registry — every truck the log knows about, in one table. The board
 * shows the six trucks that need a decision; this shows all forty, which is the
 * difference between an operations view and an administrative one.
 */
export default function FleetPanel() {
  const world = useWorld()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState({ col: 'id', dir: 1 })

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const col = COLUMNS.find((c) => c.id === sort.col) || COLUMNS[0]
    return Object.values(world.trucks)
      .filter(
        (t) =>
          !q ||
          t.id.toLowerCase().includes(q) ||
          t.driverName?.toLowerCase().includes(q) ||
          t.plate?.toLowerCase().includes(q) ||
          t.loadId?.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const av = col.get(a)
        const bv = col.get(b)
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir
        return String(av).localeCompare(String(bv)) * sort.dir
      })
  }, [world, query, sort])

  function sortBy(id) {
    setSort((s) => ({ col: id, dir: s.col === id ? -s.dir : 1 }))
  }

  return (
    <section className="card">
      <div className="row">
        <h3 style={{ flex: 1 }}>
          Fleet registry <span className="count">{rows.length} of {Object.keys(world.trucks).length}</span>
        </h3>
        <input
          className="field"
          placeholder="Filter by truck, driver, plate or load"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="scroll-y tall" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  className={`sortable${c.num ? ' num' : ''}`}
                  aria-sort={sort.col === c.id ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  onClick={() => sortBy(c.id)}
                >
                  {c.label}{sort.col === c.id ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
              <th>At site</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td className="mono">{t.plate}</td>
                <td>{t.driverName}</td>
                <td>
                  {t.state}
                  {t.laden ? <span className="tag tag-laden">laden</span> : <span className="tag tag-empty">empty</span>}
                </td>
                <td className="mono">{t.loadId || '—'}</td>
                <td className="num">{t.chainage?.toFixed(1)}</td>
                <td className="num">{Math.round(t.speedKph)}</td>
                <td className="num">{fmtKm(t.odometerKm)}</td>
                <td className={`num hos hos-${hosStatus(t)}`}>{fmtClock(clockLeftMs(t))}</td>
                <td>{t.insideSiteId ? SITE_BY_ID[t.insideSiteId]?.name ?? t.insideSiteId : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note" style={{ paddingLeft: 0 }}>
        Every column here is folded from the ping stream, not stored. There is no
        truck record to edit — a truck is whatever its last ping said it was.
      </p>
    </section>
  )
}
