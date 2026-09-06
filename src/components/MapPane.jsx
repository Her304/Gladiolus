import { useMemo } from 'react'
import { MapContainer, TileLayer, Polyline, Circle, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CORRIDOR_POINTS, SITES } from '../data/corridor.js'
import { hosStatus, clockLeftMs, fmtClock } from '../engine/hos.js'
import { HOS_COLOUR, LEVEL_COLOUR } from '../format.js'

/**
 * Every marker is a divIcon, so Leaflet's default icon assets are never
 * requested — which sidesteps the broken marker-image paths bundlers produce.
 */
function truckIcon(colour, heading, dimmed) {
  return L.divIcon({
    className: 'truck-icon',
    iconSize: [11, 11],
    iconAnchor: [6, 6],
    html: `<div style="background:${colour};opacity:${dimmed ? 0.45 : 1};transform:rotate(${heading}deg)"></div>`,
  })
}

function FlyTo({ coord }) {
  const map = useMap()
  if (coord) map.flyTo(coord, Math.max(map.getZoom(), 10), { duration: 0.8 })
  return null
}

export default function MapPane({ world, incidents = [], board = [], focusCoord, onSelectTruck }) {
  const trucks = useMemo(() => Object.values(world.trucks), [world])
  const levelBySite = useMemo(
    () => Object.fromEntries(board.map((p) => [p.site.id, p.level])),
    [board],
  )

  return (
    <div className="map-wrap">
      <MapContainer center={[43.15, -81.2]} zoom={7} scrollWheelZoom style={{ height: '100%' }}>
        {/* Plain OSM tiles, darkened in CSS. The hosted dark basemaps (CARTO,
            Stadia) all watermark or reject unkeyed requests, and staying
            key-free is the point: nothing here needs a signup to run. */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        {focusCoord && <FlyTo coord={focusCoord} />}

        <Polyline positions={CORRIDOR_POINTS} pathOptions={{ color: '#4ea3ff', weight: 2, opacity: 0.45 }} />

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
          return (
            <Marker
              key={t.id}
              position={t.coord}
              icon={truckIcon(HOS_COLOUR[status], t.heading ?? 0, t.parked)}
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

      <div className="map-legend">
        <b>Hours of service</b>
        <div><i style={{ background: HOS_COLOUR.ok }} /> Over 90 min left</div>
        <div><i style={{ background: HOS_COLOUR.warn }} /> Under 90 min</div>
        <div><i style={{ background: HOS_COLOUR.critical }} /> Under 30 min</div>
      </div>
    </div>
  )
}
