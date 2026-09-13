import { useEffect, useState, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { roadPosition, routePoints } from './model.js'
import { roadRoute } from '../services/routing.js'
import carIcon from '../assets/directions-car.svg'

function Camera({ truck, target, recenter, viewMode, collapsed }) {
  const map = useMap()
  const followPosition = viewMode === 'follow' ? `${truck.coord[0].toFixed(4)},${truck.coord[1].toFixed(4)}` : ''
  useEffect(() => {
    const root = map.getContainer().closest('.dp-app')
    const card = root.querySelector('.dp-card')
    const header = root.querySelector('.dp-route-header')
    let frame
    const fit = () => {
      const box = map.getContainer().getBoundingClientRect()
      const cardBox = card?.getBoundingClientRect()
      const headerBox = header?.getBoundingClientRect()
      const desktop = box.width >= 760
      const top = desktop ? 90 : Math.max(120, (headerBox?.bottom || 160) - box.top + 22)
      const bottom = desktop ? 100 : Math.min(box.height - top - 65, Math.max(250, box.bottom - (cardBox?.top || box.bottom - 340) + 25))
      const paddingTopLeft = [35, top]
      const paddingBottomRight = desktop && !collapsed ? [480, bottom] : [35, bottom]
      map.invalidateSize()
      if (viewMode === 'follow') {
        map.setView(truck.coord, 15, { animate: false })
        map.panBy([0, -Math.min(115, box.height * 0.14)], { animate: false })
        return
      }
      map.fitBounds(L.latLngBounds(target ? [truck.coord, target.coord] : [truck.coord, truck.coord]), {
        paddingTopLeft, paddingBottomRight, maxZoom: 12, animate: false,
      })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) }
    const observer = new ResizeObserver(schedule)
    if (card) observer.observe(card)
    if (header) observer.observe(header)
    observer.observe(map.getContainer())
    schedule()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
    // Overview keeps a driver's pan; Follow deliberately advances the camera
    // with the truck so its marker stays in the lower third of the road ahead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, target?.id, recenter, viewMode, collapsed, followPosition])
  return null
}
export default function DriverMap({ truck, target, recenter, viewMode = 'overview', collapsed = false, pins = [] }) {
  const [failed, setFailed] = useState(false), [roadPoints, setRoadPoints] = useState(null)
  const mapTruck = useMemo(() => ({ ...truck, coord: roadPosition(truck.coord) }), [truck])
  const fallbackPoints = useMemo(() => routePoints(truck, target), [truck.chainage, target?.id])
  const routeKey = target ? `${target.id}:${Math.floor(truck.chainage / 2)}` : 'none'
  useEffect(() => {
    setRoadPoints(null)
    if (!target || fallbackPoints.length < 2) return
    const controller = new AbortController()
    roadRoute(mapTruck.coord, target.coord, { signal: controller.signal }).then(setRoadPoints).catch(() => {})
    return () => controller.abort()
    // Refresh after each two kilometres, not on every telemetry tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, target?.coord?.[0], target?.coord?.[1]])
  const points = roadPoints || fallbackPoints
  const arrow = useMemo(() => L.divIcon({ className: 'dp-truck-marker', iconSize: [40, 40], iconAnchor: [20, 20], html: `<img class="dp-truck-navigation-icon" src="${carIcon}" alt="" />` }), [])
  const glyph = { parking: 'P', scale: 'S', incident: '!' }[target?.kind] || '●'
  const stop = useMemo(() => L.divIcon({ className: `dp-stop-marker ${target?.kind || ''}`, iconSize: [28, 28], html: glyph }), [target?.kind, glyph])
  // The "ahead" family of screens shows every parking site and inspection
  // station on the corridor at once — not just the one the driver opened. Each
  // is a quiet pin the same colour as its kind; the selected one grows and gets
  // the same marker treatment as the single-target route above.
  const pinIcon = useMemo(() => (p) => {
    const g = { parking: 'P', scale: 'S', incident: '!' }[p.kind] || '●'
    const active = target?.id === p.id
    return L.divIcon({ className: `dp-stop-marker ${p.kind || ''} ${active ? 'active' : 'dim'}`, iconSize: active ? [28, 28] : [20, 20], html: g })
  }, [target?.id])
  return <div className="dp-map" aria-label="Driver route map">
    <MapContainer center={truck.coord} zoom={11} zoomControl={false} attributionControl={true}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={18} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' eventHandlers={{ tileerror: () => setFailed(true), tileload: () => setFailed(false) }} />
      <Camera truck={mapTruck} target={target} recenter={recenter} viewMode={viewMode} collapsed={collapsed} />
      {points.length > 0 && <Polyline positions={points} interactive={false} pathOptions={{ className: 'dp-driving-route-casing', color: '#ffffff', weight: 12, opacity: 0.96 }} />}
      {points.length > 0 && <Polyline positions={points} interactive={false} pathOptions={{ className: 'dp-driving-route', color: '#138269', weight: 7, opacity: 1 }} />}
      {pins.map(p => <Marker key={p.id} position={p.coord} icon={pinIcon(p)} eventHandlers={{ click: () => p.onSelect?.(p.id) }}><Tooltip>{p.name}</Tooltip></Marker>)}
      <Marker position={mapTruck.coord} icon={arrow}><Tooltip>{truck.driverName} · {truck.id}</Tooltip></Marker>
      {target && <Marker position={target.coord} icon={stop}><Tooltip>{target.name}</Tooltip></Marker>}
    </MapContainer>
    <span className="dp-map-note">{failed ? 'Map tiles unavailable · route shown' : roadPoints ? 'Road route · OpenStreetMap' : 'Road trace · offline'}</span>
  </div>
}
