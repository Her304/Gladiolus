import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Polyline, Circle, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CORRIDOR_POINTS, SITES } from '../data/corridor.js'
import { NODES } from '../data/regional-graph.js'
import { hosStatus, clockLeftMs, fmtClock } from '../engine/hos.js'
import { HOS_COLOUR, LEVEL_COLOUR, fmtTime } from '../format.js'
import { breadcrumbHistory } from '../domain/history.js'
import { routePoints } from '../driver/model.js'
import truckMarkerSvg from '../assets/local_shipping_24dp_1F1F1F_FILL0_wght400_GRAD0_opsz24.svg'

const DESTINATION_BY_ID = new Map([
  ...SITES.map((site) => [site.id, site]),
  ...NODES.map((node) => [node.id, node]),
])

/** Use the same bundled road trace as DriverMap. The old dispatcher-only graph
 * linked regional nodes with straight lines, which visually sent trucks across
 * the lake even though their driver map showed the 401. */
function truckRoutePath(truck) {
  if (!truck?.loadId || !truck?.destinationId) return null
  const destination = DESTINATION_BY_ID.get(truck.destinationId)
  if (!destination) return null
  return routePoints(truck, destination)
}

/**
 * Basemap toggle (Phase 5): a satellite basemap with source attribution, so a
 * judge can switch basemaps for yard/dock inspection. The OSM standard layer is
 * the default (key-free); the satellite layer is Esri World Imagery, also
 * key-free, with its required attribution.
 */
const BASEMAPS = [
  { id: 'osm', label: 'Map', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 },
  { id: 'sat', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
]

/**
 * Every marker is a divIcon, so Leaflet's default icon assets are never
 * requested — which sidesteps the broken marker-image paths bundlers produce.
 */
function truckIcon(colour, heading, dimmed) {
  const roundedHeading = Math.round((heading || 0) / 5) * 5
  const key = `${colour}:${roundedHeading}:${dimmed ? 1 : 0}`
  if (TRUCK_ICON_CACHE.has(key)) return TRUCK_ICON_CACHE.get(key)
  const icon = L.divIcon({
    className: 'truck-icon',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div style="background:${colour};opacity:${dimmed ? 0.45 : 1};transform:rotate(${roundedHeading}deg);mask-image:url('${truckMarkerSvg}');-webkit-mask-image:url('${truckMarkerSvg}')"></div>`,
  })
  TRUCK_ICON_CACHE.set(key, icon)
  return icon
}
const TRUCK_ICON_CACHE = new Map()

function FlyTo({ coord }) {
  const map = useMap()
  useEffect(() => {
    if (coord) map.flyTo(coord, Math.max(map.getZoom(), 10), { duration: 0.8 })
  }, [coord, map])
  return null
}

export default function MapPane({ world, pings = [], incidents = [], board = [], focusId, focusCoord, isolateId, onSelectTruck }) {
  const trucks = useMemo(() => Object.values(world.trucks), [world])
  // When a task card is expanded, the map isolates that one driver + route:
  // only their marker stays full-strength and only their route is drawn, so
  // the centre pane reads as "this driver's task" rather than the whole fleet.
  const isolating = isolateId ? world.trucks[isolateId] : null
  const levelBySite = useMemo(
    () => Object.fromEntries(board.map((p) => [p.site.id, p.level])),
    [board],
  )
  const [basemap, setBasemap] = useState('osm')
  const layer = BASEMAPS.find((b) => b.id === basemap)
  const trace = useMemo(() => {
    if (!focusId) return null
    const history = breadcrumbHistory(pings.filter((e) => e.truck?.coord), world.clock)
    const points = history.breadcrumbs.slice(-300)
    if (!points.length) return null
    const firstOdo = points.find((p) => Number.isFinite(p.odometerKm))?.odometerKm
    const lastOdo = points.findLast((p) => Number.isFinite(p.odometerKm))?.odometerKm
    const moving = points.filter((p) => Number.isFinite(p.speedKph))
    return {
      ...history, points,
      distanceKm: firstOdo != null && lastOdo != null ? Math.max(0, lastOdo - firstOdo) : null,
      averageKph: moving.length ? moving.reduce((sum, p) => sum + p.speedKph, 0) / moving.length : null,
      maxKph: moving.length ? Math.max(...moving.map((p) => p.speedKph)) : null,
    }
  }, [pings, focusId, world.clock])

  return (
    <div className="map-wrap">
      <MapContainer center={[43.15, -81.2]} zoom={7} scrollWheelZoom style={{ height: '100%' }}>
        <TileLayer key={layer.id} url={layer.url} maxZoom={layer.maxZoom} attribution={layer.attribution} />
        {focusCoord && <FlyTo coord={focusCoord} />}

        <Polyline positions={CORRIDOR_POINTS} pathOptions={{ color: '#4ea3ff', weight: 2, opacity: 0.45 }} />
        {trace?.points.length > 1 && (
          <Polyline positions={trace.points.map((p) => p.coord)} pathOptions={{ color: '#ffb020', weight: 5, opacity: 0.9 }} />
        )}

        {/* Active load routes share DriverMap's road-snapped fallback, so the
            dispatcher, customer and driver all see the same route geometry. */}
        {trucks
          .filter((t) => t.laden && t.loadId && (!isolating || t.id === isolating.id))
          .map((t) => {
            const path = truckRoutePath(t)
            if (!path || path.length < 2) return null
            return <Polyline key={`route-${t.id}`} positions={path} pathOptions={{ color: '#16a34a', weight: 4, opacity: 0.7 }} />
          })}

        {SITES.map((s) => {
          const colour = s.kind === 'parking' ? (LEVEL_COLOUR[levelBySite[s.id]] ?? '#8b97a8') : '#8b97a8'
          return (
            <Circle
              key={s.id}
              center={s.coord}
              radius={s.radiusM}
              pathOptions={{
                color: colour,
                weight: 1,
                opacity: 0.85,
                fillOpacity: s.kind === 'parking' ? 0.18 : 0.07,
              }}
            >
              <Tooltip>
                <strong>{s.name}</strong>
                <br />
                {s.kind === 'parking' ? `${s.spaces} spaces` : 'Customer / DC'} · {s.radiusM} m fence
              </Tooltip>
            </Circle>
          )
        })}

        {incidents.map((inc) => (
          <Circle
            key={inc.id}
            center={inc.coord}
            radius={2400}
            pathOptions={{ color: '#ffb020', weight: 1, fillOpacity: 0.16 }}
          >
            <Tooltip>
              <strong>{inc.road}</strong> — {inc.direction}
              <br />
              {inc.description}
            </Tooltip>
          </Circle>
        ))}

        {trucks.map((t) => {
          const status = hosStatus(t)
          const dimmed = (t.parked || false) || (isolating ? t.id !== isolating.id : false)
          return (
            <Marker
              key={t.id}
              position={t.coord}
              icon={truckIcon(HOS_COLOUR[status], t.heading ?? 0, dimmed)}
              eventHandlers={onSelectTruck ? { click: () => onSelectTruck(t.id) } : undefined}
            >
              <Tooltip direction="top" offset={[0, -8]}>
                <strong>{t.id}</strong> · {t.driverName}
                <br />
                {t.parked ? 'Parked' : `${t.speedKph} km/h`} · {t.laden ? `load ${t.loadId}` : 'empty'}
                <br />
                Clock {fmtClock(clockLeftMs(t))} left
              </Tooltip>
            </Marker>
          )
        })}
      </MapContainer>

      <div className="basemap-toggle">
        {BASEMAPS.map((b) => (
          <button key={b.id} className={basemap === b.id ? 'active' : ''} onClick={() => setBasemap(b.id)}>{b.label}</button>
        ))}
      </div>

      <div className="map-legend">
        <b>Hours of service</b>
        <div><i style={{ background: HOS_COLOUR.ok }} /> Over 90 min left</div>
        <div><i style={{ background: HOS_COLOUR.warn }} /> Under 90 min</div>
        <div><i style={{ background: HOS_COLOUR.critical }} /> Under 30 min</div>
      </div>

      {focusId && (
        <div className="trace-inspector">
          <div><b>{focusId} trace</b><button onClick={() => onSelectTruck?.(null)} aria-label="Close trace">×</button></div>
          {trace ? (
            <>
              <p><strong>{trace.points.length}</strong> breadcrumbs · <strong>{trace.legs.length}</strong> leg{trace.legs.length === 1 ? '' : 's'}</p>
              <p>{trace.distanceKm == null ? 'Distance unavailable' : `${trace.distanceKm.toFixed(1)} km`} · avg {Math.round(trace.averageKph || 0)} km/h · max {Math.round(trace.maxKph || 0)} km/h</p>
              <div className="trace-speeds" aria-label="Recent speed history">
                {trace.points.slice(-30).map((p, i) => <i key={`${p.at}-${i}`} title={`${fmtTime(p.at)} · ${Math.round(p.speedKph || 0)} km/h`} style={{ height: `${Math.max(3, Math.min(42, (p.speedKph || 0) / 3))}px` }} />)}
              </div>
              <small>{trace.points.at(-1).source} · last point {fmtTime(trace.points.at(-1).at)}</small>
            </>
          ) : <p>No breadcrumb history received for this truck.</p>}
        </div>
      )}
    </div>
  )
}
