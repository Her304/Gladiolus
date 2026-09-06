import { useWorld } from '../useStore.js'
import { readCustomerToken } from '../auth/AuthContext.jsx'
import { SITE_BY_ID } from '../data/corridor.js'
import { fmtTime } from '../format.js'

/**
 * The read-only surface a customer gets from a shared link. No sign-in, one
 * load, and deliberately less detail than dispatch sees: no driver name, no
 * hours-of-service clock, no other trucks.
 */
export default function CustomerView({ token }) {
  const world = useWorld()
  const claim = readCustomerToken(token)
  const truck = claim ? world.trucks[claim.truckId] : null

  if (!claim || !truck) {
    return (
      <div className="page page-narrow">
        <div className="banner" style={{ borderLeftColor: 'var(--crit)' }}>
          <strong>This tracking link is not valid.</strong> Ask your contact at
          Gladiolus for a new one.
        </div>
      </div>
    )
  }

  const dest = SITE_BY_ID[truck.destinationId]
  const etaMs = dest
    ? (Math.abs(dest.chainage - truck.chainage) / Math.max(truck.speedKph, 40)) * 3600_000
    : null

  return (
    <div className="page page-narrow">
      <div className="cards">
        <div className="card">
          <h3>Shipment</h3>
          <div className="big">{claim.loadId ?? truck.loadId ?? '—'}</div>
          <div className="sub">Carrier reference {truck.id}</div>
        </div>
        <div className="card">
          <h3>Estimated arrival</h3>
          <div className="big">{etaMs != null ? fmtTime(world.clock + etaMs) : '—'}</div>
          <div className="sub">{dest?.name ?? 'Destination to be confirmed'}</div>
        </div>
        <div className="card">
          <h3>Status</h3>
          <div className="big">
            {truck.parked ? 'Driver resting' : truck.state === 'dwelling' ? 'At a stop' : 'In transit'}
          </div>
          <div className="sub">Updated {fmtTime(world.clock)}</div>
        </div>
      </div>

      <p className="note" style={{ paddingLeft: 0, marginTop: 18 }}>
        Arrival times account for live road conditions on the 401 and the
        driver's remaining legal driving hours. They move as conditions change.
      </p>
    </div>
  )
}
