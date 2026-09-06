import { FLEET_SHARE } from '../engine/parking.js'
import { pct } from '../format.js'

/**
 * The parking board. `seen` and `confidence` are shown next to every estimate
 * on purpose: the fleet-share assumption is load-bearing, and a number that
 * carries this much weight should not be invisible behind a tidy percentage.
 */
export default function ParkingPanel({ board }) {
  const tight = board.filter((p) => p.level === 'tight' || p.level === 'full').length

  return (
    <section className="panel">
      <h2>
        Parking pressure <span className="count">{tight} of {board.length} tight or full</span>
      </h2>
      <p className="note">
        No live occupancy feed exists for Ontario, so the fleet is the sensor. Our
        own trucks on site are counted exactly; the rest of each lot is estimated
        by scaling that sample against an assumed {pct(FLEET_SHARE)} share of
        corridor traffic, and blended with the historical curve for the hour
        wherever the sample is thin.
      </p>

      {board.map((p) => (
        <div key={p.site.id} className={`lot level-${p.level}`}>
          <div className="lot-name">
            {p.site.name}{' '}
            {p.site.owned && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· our yard</span>}
          </div>
          <div className="lot-fig">
            <b>{p.projectedFree}</b>
            <small>free</small>
          </div>
          <div className="lot-sub">
            {p.occupied} of {p.site.spaces} taken · {p.observed} ours on site
            {p.observed > 0 && ` (confidence ${p.confidence.toFixed(2)})`}
            {p.inbound.length > 0 && ` · ${p.inbound.length} inbound`}
            {p.claims > 0 && ` · ${p.claims} holding`}
          </div>
          <div className="bar">
            <i style={{ width: `${Math.round(p.estimatedUtil * 100)}%` }} />
          </div>
        </div>
      ))}
    </section>
  )
}
