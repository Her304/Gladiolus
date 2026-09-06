import { useMemo } from 'react'
import { useWorld } from '../useStore.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { recommendParking } from '../engine/parking.js'
import { hosStatus, clockLeftMs, fmtClock, reachableKm, DRIVE_LIMIT_MS } from '../engine/hos.js'
import { SITE_BY_ID } from '../data/corridor.js'
import { fmtKm } from '../format.js'

/**
 * What one driver needs, and nothing else: how much clock is left, where the
 * load is going, and where to park before the clock runs out.
 */
export default function DriverView() {
  const world = useWorld()
  const { user } = useAuth()
  const truck = world.trucks[user?.truckId]

  const now = useMemo(() => new Date(world.clock), [world.clock])
  const rec = useMemo(
    () => (truck ? recommendParking(truck, world, now) : null),
    [truck, world, now],
  )

  if (!truck) {
    return (
      <div className="page page-narrow">
        <p className="note">Waiting for the first ping from {user?.truckId}…</p>
      </div>
    )
  }

  const status = hosStatus(truck)
  const left = clockLeftMs(truck)
  const dest = SITE_BY_ID[truck.destinationId]

  return (
    <div className="page page-narrow">
      <div className="cards">
        <div className="card">
          <h3>Driving time left</h3>
          <div className={`dial hos-${status}`}>
            <b>{fmtClock(left)}</b>
            <span className="sub">of 13:00</span>
          </div>
          <div className="sub">
            {status === 'violation'
              ? 'Limit reached. You must stop now.'
              : `About ${fmtKm(reachableKm(truck))} at your current speed.`}
          </div>
        </div>

        <div className="card">
          <h3>{truck.laden ? 'On board' : 'Running empty'}</h3>
          <div className="big">{truck.laden ? truck.loadId : '—'}</div>
          <div className="sub">
            {truck.state === 'dwelling'
              ? `At ${SITE_BY_ID[truck.insideSiteId]?.name ?? 'a stop'}`
              : `Next stop ${dest?.name ?? 'unassigned'}`}
          </div>
        </div>

        <div className="card">
          <h3>Status</h3>
          <div className="big">
            {truck.parked ? 'Parked' : truck.state === 'dwelling' ? 'Loading' : `${truck.speedKph} km/h`}
          </div>
          <div className="sub">{truck.plate} · odo {fmtKm(truck.odometerKm)}</div>
        </div>
      </div>

      <h2 style={{ fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 26 }}>
        Where to park
      </h2>

      {!rec && (
        <div className="banner" style={{ borderLeftColor: 'var(--crit)' }}>
          <strong>Nothing is reachable on the hours you have left.</strong> The
          nearest rest area is beyond your remaining clock. Call dispatch before
          you go any further — stopping on a ramp is the outcome this is meant to
          prevent.
        </div>
      )}

      {rec && (
        <>
          {!rec.viable && (
            <div className="banner">
              <strong>Every lot within reach is projected full.</strong> This is
              the least-bad option rather than a space we can promise.
            </div>
          )}
          <div className="card">
            <h3>Recommended</h3>
            <div className="big">{rec.best.site.name}</div>
            <div className="sub">
              {Math.round(rec.best.ahead)} km ahead ·{' '}
              {rec.best.projectedFree} of {rec.best.site.spaces} spaces projected free ·{' '}
              {rec.best.observed} of our trucks on site now
            </div>
          </div>

          {rec.alternatives.length > 0 && (
            <table style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>Alternative</th>
                  <th className="num">Ahead</th>
                  <th className="num">Free</th>
                  <th className="num">Full</th>
                </tr>
              </thead>
              <tbody>
                {rec.alternatives.map((a) => (
                  <tr key={a.site.id}>
                    <td>{a.site.name}</td>
                    <td className="num">{Math.round(a.ahead)} km</td>
                    <td className="num">{a.projectedFree}</td>
                    <td className="num">{Math.round(a.estimatedUtil * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <p className="note" style={{ paddingLeft: 0, marginTop: 20 }}>
        Hours of service shown are the Canadian federal limits, simplified to the
        13-hour driving and 14-hour on-duty caps. Driving so far this shift:{' '}
        {fmtClock(truck.drivingMs)} of {fmtClock(DRIVE_LIMIT_MS)}.
      </p>
    </div>
  )
}
