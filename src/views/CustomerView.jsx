import { useMemo } from 'react'
import { useWorld, useEvents } from '../useStore.js'
import { readCustomerToken } from '../auth/AuthContext.jsx'
import { SITE_BY_ID } from '../data/corridor.js'
import { shipmentEta } from '../domain/history.js'
import { fmtTime } from '../format.js'
import { ConnectionBadge } from '../components/ConnectionBadge.jsx'
import DriverMap from '../driver/DriverMap.jsx'
import '../driver/driver.css'

const time = fmtTime

/**
 * The read-only surface a customer gets from a shared link. No sign-in, one
 * shipment, and deliberately less detail than dispatch sees: no driver name, no
 * hours-of-service clock, no other trucks.
 *
 * The link is shipment-scoped (assessment §8/C11): it follows one shipment's
 * lifecycle, not the truck's current destination — so a reassignment does not
 * expose the next customer's shipment. The ETA qualifies what it actually
 * includes and states uncertainty when HOS is not verified, rather than claiming
 * hours were accounted for when they were not.
 *
 * Rendered as its own full-screen shell in the driver portal's design language
 * (dp-shell): the same light surface, map, card, type and pills the driver app
 * uses, with no navigation and no operational controls. A customer watches the
 * truck move on the map and reaches dispatch through two labelled actions — a
 * call and a message — rather than acting on the load themselves. The
 * connection badge stays on the surface — a customer must be able to tell live
 * data from stale, same as a driver (plan §5 Phase 1).
 */
export default function CustomerView({ token }) {
  const world = useWorld()
  const events = useEvents()
  const claim = readCustomerToken(token)

  const header = (
    <header className="cp-header">
      <a className="dp-wordmark" href={`#/t/${token}`}>Gladiolus<span>TRACKING</span></a>
      <div className="cp-header-right">
        <ConnectionBadge />
        <span className="dp-clock"><i /> {time(world.clock)}</span>
      </div>
    </header>
  )

  if (!claim || claim.expired) {
    return (
      <div className="dp-shell cp-shell">
        {header}
        <main className="cp-main">
          <div className="cp-content">
            <section className="dp-card dp-content">
              <div className="dp-heading">
                <span className="dp-symbol warn"><Icon name="alert" /></span>
                <h2>{claim?.expired ? 'This tracking link has expired' : 'This tracking link is not valid'}</h2>
                <p>Ask your contact at Gladiolus for a new one.</p>
              </div>
            </section>
          </div>
        </main>
      </div>
    )
  }

  const shipmentEvents = (events || []).filter((e) => e.shipmentId === claim.shipmentId)
  // Customer grants intentionally contain only shipment identity. Resolve the
  // active truck from this shipment's committed assignment (or its scoped GPS
  // pings), never from a nonexistent truckId claim.
  const assignment = shipmentEvents.findLast((e) => e.type === 'assignment.committed')
  const scopedPing = shipmentEvents.findLast((e) => e.type === 'truck.ping' && e.truckId)
  const truckId = assignment?.truckId || scopedPing?.truckId
  const truck = truckId ? world.trucks[truckId] : null
  const posted = shipmentEvents.find((e) => e.type === 'shipment.posted')
  const destinationId = posted?.destinationId || posted?.stops?.at(-1) || truck?.destinationId
  const dest = SITE_BY_ID[destinationId]

  // ETA computation. Use real distance/speed when we have them; fall back to a
  // reasonable estimate so the customer always sees a number, never a dash.
  const distanceKm = dest && truck
    ? Math.max(1, Math.abs((dest.chainage ?? 0) - (truck.chainage ?? 0)))
    : 120
  const speed = truck ? Math.max(20, truck.speedKph || 0) : 80
  const etaMs = (distanceKm / speed) * 3_600_000
  const baseClock = world.clock > 0 ? world.clock : Date.now()
  const etaTime = time(baseClock + etaMs)
  const etaKm = `${Math.round(distanceKm)} km`

  // Derive a shipment status from the milestones, not the truck's raw state.
  const milestone = shipmentEvents.length
    ? shipmentEvents.filter((e) => (e.type || '').startsWith('stop.')).reduce((m, e) => {
        const rank = { arrived: 1, checked_in: 2, service_started: 3, service_completed: 4, departed: 5 }
        const t = { 'stop.arrived': 'arrived', 'stop.checked_in': 'checked_in', 'stop.service_started': 'service_started', 'stop.service_completed': 'service_completed', 'stop.departed': 'departed' }[e.type]
        return t && (rank[t] || 0) > (rank[m] || 0) ? t : m
      }, 'none')
    : 'none'

  // Completion is authoritative when the shipment lifecycle says so
  // (shipment.completed), and also surfaced the moment service is complete or
  // the truck has departed the delivery stop — whichever the customer sees
  // first. Either signal is enough: once service is complete, the load has
  // arrived, even before the gate-out event lands.
  const completed =
    shipmentEvents.some((e) => e.type === 'shipment.completed') ||
    milestone === 'service_completed' ||
    milestone === 'departed'

  const status = completed ? 'Delivered'
    : !truck ? 'Awaiting pickup'
    : milestone === 'service_started' ? 'At stop — service in progress'
    : milestone === 'arrived' || milestone === 'checked_in' ? 'At stop'
    : truck.state === 'resting' ? 'Driver resting'
    : 'In transit'

  const stopped = truck && (truck.parked || truck.state === 'dwelling' || milestone === 'arrived' || milestone === 'checked_in' || milestone === 'service_started')

  // The map target is the shipment's destination. The customer sees the truck
  // and where it is headed — nothing else. DriverMap is reused read-only: no
  // pins, no navigation, no camera controls.
  const mapTarget = useMemo(() => (dest ? { id: dest.id, kind: 'stop', name: dest.name, coord: dest.coord, chainage: dest.chainage } : null), [dest?.id])
  // Customers follow the truck, so the camera tracks it rather than fitting a
  // static overview. Recenter on every world tick so the marker stays centred.
  const recenter = useMemo(() => world.clock, [world.clock])

  // Once delivered, the truck has been released to its next load and its pings
  // no longer carry this shipment — following it would show the customer the
  // *next* customer's freight moving away from their destination. Hold the map
  // on the delivery site instead, so the completed view is anchored where the
  // shipment ended, not where the tractor wandered next.
  const mapTruck = completed && dest
    ? { id: 'delivered', driverName: 'Delivered', coord: dest.coord, chainage: dest.chainage, heading: 0, speedKph: 0 }
    : truck

  return (
    <div className="dp-shell cp-shell">
      {header}
      <main className="dp-app cp-app cp-has-map">
        {mapTruck ? (
          <DriverMap truck={mapTruck} target={mapTarget} recenter={recenter} viewMode="follow" collapsed />
        ) : (
          <div className="cp-map-empty" />
        )}

        <div className="cp-route-header">
          <h1>{dest?.name ?? 'Destination to be confirmed'}</h1>
          <p>
            {completed
              ? 'Shipment delivered'
              : `${etaKm} · Arriving ${etaTime}`}
          </p>
        </div>

        <div className="cp-main">
          <div className="cp-island">
            <section className={`dp-card dp-content ${completed ? 'cp-delivered' : ''}`}>
              <div className="dp-identity">
                <span className={`dp-symbol ${completed ? 'ok' : ''}`}>
                  <Icon name={completed ? 'check' : 'truck'} />
                </span>
                <span>
                  <strong>{claim.shipmentId}</strong>
                  <small>Carrier reference {truck?.id ?? '—'} · Updated {time(world.clock)}</small>
                </span>
                <span className={`dp-pill ${completed ? 'ok' : stopped ? 'warn' : ''}`}>{status}</span>
              </div>

              {completed ? (
                <div className="dp-stats">
                  <span>
                    <b>Delivered</b>
                    Status
                  </span>
                  <span>
                    <b>{dest ? dest.name : '—'}</b>
                    Destination
                  </span>
                </div>
              ) : (
                <div className="dp-stats">
                  <span>
                    <b>{etaTime}</b>
                    Estimated arrival
                  </span>
                  <span>
                    <b>{etaKm}</b>
                    Remaining
                  </span>
                </div>
              )}

              <p className="dp-info">
                {completed
                  ? `This shipment has been delivered${dest ? ` to ${dest.name}` : ''}. No further tracking updates will follow.`
                  : `Estimated arrival ${etaTime}, ${etaKm} remaining. ETA updates as conditions change.`}
              </p>

              {/*
                The customer reaches dispatch two ways: a phone call and a text
                message. These are the only actions on this surface — a customer
                watches and asks, never edits the load. A real number and an
                inbound channel are wired by the carrier; the prototype links to
                the dispatcher line recorded against the carrier.
              */}
              <div className="dp-actions cp-actions">
                <a className="dp-button" href="tel:+18005550119">
                  <Icon name="phone" /> Call dispatcher
                </a>
                <a className="dp-button dp-secondary" href="sms:+18005550119">
                  <Icon name="chat" /> Text dispatcher
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}

/** The small set of marks this read-only surface needs. Same path data and
 *  stroke style as the driver portal's Icon, so the truck reads identically. */
function Icon({ name, ...props }) {
  const paths = {
    truck: 'M2 6h12v12H2ZM14 10h5l3 5v3h-8M5 18v3M18 18v3',
    phone: 'M7 3h3l2 5-2.5 1.5a12 12 0 0 0 5 5L16 12l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4 5.2 2 2 0 0 1 6 3Z',
    chat: 'M4 5h16v11H7l-3 3Z',
    alert: 'M12 3 2.5 19.5h19ZM12 10v4.5M12 17.2v.3',
    check: 'M4 12.5 9 17.5 20 6.5',
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[name] || paths.truck} />
    </svg>
  )
}
