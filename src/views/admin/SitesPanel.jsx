import { useMemo, useState } from 'react'
import { useOperationalEvents, useWorld } from '../../useStore.js'
import { SITES, MIN_FENCE_M, offCorridorKm, BASE_SITE_CAPACITIES } from '../../data/corridor.js'
import { pressureFor } from '../../engine/parking.js'
import { APPROACH_KM } from '../../contract.js'
import { pct } from '../../format.js'
import { issueCommand } from '../../services/serverApi.js'

const CAPACITY_RANGE = { min: 1, max: 400 }

/**
 * Corridor configuration. Capacity is editable and live — `pressureFor` reads
 * `site.spaces` on every call, so an edit moves the parking board, the map
 * colours and the recommender on the next tick.
 *
 * Fence radius is shown but not editable, and the reason is worth stating: the
 * simulator sizes its sub-step from the smallest fence on the corridor when it
 * is constructed, so shrinking one underneath a running sim would let trucks
 * step straight over it without ever firing an enter event. That is a restart,
 * not a text input, and a console that offered the input anyway would be lying.
 */
export default function SitesPanel({ user }) {
  const world = useWorld()
  const events = useOperationalEvents()
  const [drafts, setDrafts] = useState({})
  const [error, setError] = useState(null)

  const now = useMemo(() => new Date(world.clock), [world.clock])
  const capacities = useMemo(() => {
    const values = { ...BASE_SITE_CAPACITIES }
    for (const e of events) {
      if (e.type !== 'config.changed') continue
      if (e.configKey === 'site.capacity' && e.siteId in values) values[e.siteId] = e.value
      if (e.configKey === 'site.capacities.reset') Object.assign(values, e.capacities || BASE_SITE_CAPACITIES)
    }
    return values
  }, [events])
  const overriddenIds = Object.keys(BASE_SITE_CAPACITIES).filter((id) => capacities[id] !== BASE_SITE_CAPACITIES[id])

  async function commit(site) {
    const raw = drafts[site.id]
    setDrafts((d) => { const next = { ...d }; delete next[site.id]; return next })
    if (raw === undefined || raw === '') return

    const applied = Math.round(Number(raw))
    if (!Number.isFinite(applied)) {
      setError(`"${raw}" is not a capacity. Enter a whole number of spaces.`)
      return
    }
    if (applied < CAPACITY_RANGE.min || applied > CAPACITY_RANGE.max) {
      setError(`Capacity must be ${CAPACITY_RANGE.min}–${CAPACITY_RANGE.max} spaces.`)
      return
    }
    const result = await issueCommand({ type: 'setSiteCapacity', siteId: site.id, spaces: applied })
    setError(result.ok ? null : result.error || 'Capacity update failed.')
  }

  async function reset(site) {
    const result = await issueCommand({ type: 'setSiteCapacity', siteId: site.id, spaces: BASE_SITE_CAPACITIES[site.id] })
    setError(result.ok ? null : result.error || 'Capacity reset failed.')
  }

  async function resetEverything() {
    const result = await issueCommand({ type: 'resetSiteCapacities' })
    setError(result.ok ? null : result.error || 'Capacity reset failed.')
  }

  const overrides = overriddenIds.length

  return (
    <>
      <section className="card">
        <div className="row">
          <h3 style={{ flex: 1 }}>
            Parking capacity <span className="count">{overrides} override{overrides === 1 ? '' : 's'}</span>
          </h3>
          <button className="ghost" onClick={resetEverything} disabled={!overrides}>
            Restore seeded values
          </button>
        </div>

        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Site</th><th className="num">Chainage</th><th className="num">Fence</th>
              <th className="num">Spaces</th><th className="num">Seeded</th>
              <th className="num">Ours on site</th><th>Estimated</th><th />
            </tr>
          </thead>
          <tbody>
            {SITES.filter((s) => s.kind === 'parking').map((site) => {
              const capacity = capacities[site.id]
              const p = pressureFor({ ...site, spaces: capacity }, world, now)
              const dirty = capacity !== BASE_SITE_CAPACITIES[site.id]
              return (
                <tr key={site.id}>
                  <td>
                    {site.name}
                    {site.owned && <span className="tag tag-owned">owned</span>}
                  </td>
                  <td className="num">{site.chainage.toFixed(1)} km</td>
                  <td className="num">{site.radiusM} m</td>
                  <td className="num">
                    <input
                      className="field cell"
                      inputMode="numeric"
                      aria-label={`Capacity at ${site.name}`}
                      value={drafts[site.id] ?? capacity}
                      onChange={(e) => setDrafts((d) => ({ ...d, [site.id]: e.target.value }))}
                      onBlur={() => commit(site)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                    />
                  </td>
                  <td className="num">{dirty ? BASE_SITE_CAPACITIES[site.id] : '—'}</td>
                  <td className="num">{p.observed}</td>
                  <td>
                    <span className={`pill level-${p.level}`}>{p.level}</span>{' '}
                    <span className="mono muted">{p.occupied}/{capacity} · {pct(p.confidence)} conf</span>
                  </td>
                  <td className="num">
                    {dirty && <button className="ghost" onClick={() => reset(site)}>Reset</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {error && <p className="err" style={{ marginTop: 10 }}>{error}</p>}

        <p className="note" style={{ paddingLeft: 0 }}>
          Capacity changes are admin-authorized server commands. They persist in
          the shared event log, replay after restart, and reach every connected
          dispatcher on the same sequence.
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Customer and delivery geofences</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Site</th><th className="num">Chainage</th><th className="num">Fence</th>
              <th className="num">Off the line</th><th className="num">Visits</th><th className="num">On site</th>
            </tr>
          </thead>
          <tbody>
            {SITES.filter((s) => s.kind === 'stop').map((site) => {
              const state = world.sites[site.id] || { occupants: [], visits: 0 }
              const off = offCorridorKm(site.coord)
              return (
                <tr key={site.id}>
                  <td>{site.name}</td>
                  <td className="num">{site.chainage.toFixed(1)} km</td>
                  <td className="num">{site.radiusM} m</td>
                  <td className={`num${off > APPROACH_KM ? ' hos-critical' : ''}`}>{off.toFixed(2)} km</td>
                  <td className="num">{state.visits}</td>
                  <td className="num">{state.occupants.length}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="note" style={{ paddingLeft: 0 }}>
          A site further off the driven line than the {APPROACH_KM} km approach
          blend can never fire its fence — silently. <code>scripts/smoke.mjs</code> asserts
          the list is empty; this column is the same check with a human looking at it.
          Smallest fence on the corridor is {MIN_FENCE_M} m, which sets the simulator's sub-step.
        </p>
      </section>
    </>
  )
}
