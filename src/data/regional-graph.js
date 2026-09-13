/**
 * Regional road graph (Phase 5).
 *
 * Replaces the single Windsor→Scarborough chainage line with a small road
 * graph covering the brief's Southern Ontario region (plan §5 Phase 5):
 * London and Milton hubs and routes toward Barrie, Peterborough/Pickering, and
 * Niagara Falls using the 401, 403, 400, QEW, and required connectors.
 *
 * The graph is separate from the v1 CORRIDOR polyline (which the physical
 * simulator still drives). Graph routing is used between corridors and
 * junctions; per-corridor measured paths remain where useful. The edges carry
 * highway designation, direction, and a `closed`/`closureKind` so a full
 * mainline closure can invalidate the edge (Phase 3 routeFeasibility).
 *
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {[number,number]} coord  [lat, lon]
 * @property {'hub'|'junction'|'destination'} kind
 *
 * @typedef {Object} GraphEdge
 * @property {string} from
 * @property {string} to
 * @property {string} highway       '401'|'403'|'400'|'QEW'|'connector'
 * @property {number} km
 * @property {boolean} [closed]
 * @property {'mainline'|'ramp'} [closureKind]
 * @property {boolean} [rampUsedByPlan]
 */
import { haversine } from '../engine/geo.js'

export const NODES = Object.freeze([
  // Hubs
  { id: 'london', label: 'London', coord: [42.9836, -81.2497], kind: 'hub' },
  { id: 'milton', label: 'Milton', coord: [43.5183, -79.8860], kind: 'hub' },
  // Destinations the brief names
  { id: 'barrie', label: 'Barrie', coord: [44.3894, -79.6903], kind: 'destination' },
  { id: 'peterborough', label: 'Peterborough', coord: [44.3001, -78.3162], kind: 'destination' },
  { id: 'pickering', label: 'Pickering', coord: [43.8384, -79.0866], kind: 'destination' },
  { id: 'niagara-falls', label: 'Niagara Falls', coord: [43.0896, -79.0940], kind: 'destination' },
  { id: 'kitchener', label: 'Kitchener', coord: [43.4516, -80.4925], kind: 'destination' },
  // Junctions (where highways meet)
  { id: 'j401-403', label: '401/403 junction (Woodstock)', coord: [43.1339, -80.7460], kind: 'junction' },
  { id: 'j401-400', label: '401/400 junction (Toronto)', coord: [43.7615, -79.5108], kind: 'junction' },
  { id: 'j400-401', label: '400/401 interchange', coord: [43.7500, -79.5000], kind: 'junction' },
  { id: 'j401-qew', label: '401/QEW junction', coord: [43.6200, -79.7000], kind: 'junction' },
  { id: 'j403-qew', label: '403/QEW junction (Burlington)', coord: [43.3260, -79.7990], kind: 'junction' },
  { id: 'j407-400', label: '407/400 junction', coord: [43.7800, -79.5600], kind: 'junction' },
  // Corridor anchors retained from v1
  { id: 'windsor', label: 'Windsor', coord: [42.3149, -83.0364], kind: 'hub' },
  { id: 'scarborough', label: 'Scarborough', coord: [43.777, -79.345], kind: 'hub' },
  { id: 'cambridge', label: 'Cambridge', coord: [43.3616, -80.3144], kind: 'hub' },
  { id: 'mississauga', label: 'Mississauga', coord: [43.589, -79.6441], kind: 'hub' },
])

const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n]))

/**
 * Edges are bidirectional unless marked; each carries the highway it belongs to.
 * Distances are great-circle approximations — sufficient for a demonstration
 * graph; a production system uses road-snapped OSRM distances.
 */
function edge(a, b, highway, extras = {}) {
  const na = NODE_BY_ID[a], nb = NODE_BY_ID[b]
  if (!na || !nb) throw new Error(`unknown node: ${a} or ${b}`)
  return { from: a, to: b, highway, km: Math.round(haversine(na.coord, nb.coord) * 10) / 10, ...extras }
}

export const EDGES = Object.freeze([
  // 401 spine (Windsor → Scarborough via London, Milton)
  edge('windsor', 'london', '401'),
  edge('london', 'j401-403', '401'),
  edge('j401-403', 'cambridge', '401'),
  edge('cambridge', 'milton', '401'),
  edge('milton', 'mississauga', '401'),
  edge('mississauga', 'j401-400', '401'),
  edge('j401-400', 'scarborough', '401'),
  // 403: Woodstock junction → Hamilton/Burlington (toward Niagara)
  edge('j401-403', 'j403-qew', '403'),
  // 400: 401 junction → Barrie
  edge('j401-400', 'barrie', '400'),
  // QEW: 401/QEW → Niagara Falls, and 403/QEW → 401/QEW
  edge('j401-qew', 'niagara-falls', 'QEW'),
  edge('j403-qew', 'j401-qew', 'QEW'),
  edge('mississauga', 'j401-qew', 'QEW'),
  // Connectors to the named destinations
  edge('j401-400', 'pickering', 'connector'),
  edge('scarborough', 'pickering', 'connector'),
  edge('barrie', 'peterborough', 'connector'),
  edge('pickering', 'peterborough', 'connector'),
  edge('cambridge', 'kitchener', 'connector'),
  edge('kitchener', 'j401-403', 'connector'),
  // Milton/London hub connectors
  edge('milton', 'j401-400', 'connector'),
  edge('london', 'kitchener', 'connector'),
])

/** Adjacency list. */
export const ADJACENCY = (() => {
  const adj = new Map()
  for (const n of NODES) adj.set(n.id, [])
  for (const e of EDGES) {
    adj.get(e.from).push({ to: e.to, edge: e })
    adj.get(e.to).push({ to: e.from, edge: { ...e, from: e.to, to: e.from } })
  }
  return adj
})()

/**
 * Shortest path (Dijkstra) between two nodes, avoiding closed mainline edges.
 * Returns the ordered node ids, the edges traversed, and the total km. Used for
 * graph routing between corridors and junctions (plan §5 Phase 5).
 *
 * @param {string} from
 * @param {string} to
 * @param {object} [opts] { avoidClosed: true }
 * @returns {{path:string[], edges:object[], km:number}|null}
 */
export function shortestPath(from, to, opts = {}) {
  if (!NODE_BY_ID[from] || !NODE_BY_ID[to]) return null
  if (from === to) return { path: [from], edges: [], km: 0 }
  const avoidClosed = opts.avoidClosed !== false
  const dist = new Map()
  const prev = new Map()
  const prevEdge = new Map()
  for (const n of NODES) dist.set(n.id, Infinity)
  dist.set(from, 0)
  const queue = new Set(NODES.map((n) => n.id))
  while (queue.size) {
    let u = null, best = Infinity
    for (const id of queue) { if (dist.get(id) < best) { best = dist.get(id); u = id } }
    if (u === null || best === Infinity) break
    queue.delete(u)
    if (u === to) break
    for (const { to: v, edge } of (ADJACENCY.get(u) || [])) {
      if (!queue.has(v)) continue
      // A closed mainline edge is impassable (Phase 3). A closed ramp blocks
      // only if the plan uses it — represented here by skipping only mainline.
      if (avoidClosed && edge.closed && edge.closureKind === 'mainline') continue
      const alt = dist.get(u) + edge.km
      if (alt < dist.get(v)) {
        dist.set(v, alt)
        prev.set(v, u)
        prevEdge.set(v, edge)
      }
    }
  }
  if (dist.get(to) === Infinity) return null
  const path = []
  const edges = []
  let cur = to
  while (cur !== from) {
    path.unshift(cur)
    edges.unshift(prevEdge.get(cur))
    cur = prev.get(cur)
  }
  path.unshift(from)
  return { path, edges, km: Math.round(dist.get(to) * 10) / 10 }
}

/** The named regional branches the brief requires demonstrated. */
export const REGIONAL_BRANCHES = Object.freeze([
  { id: 'milton-london', from: 'milton', to: 'london', via: '401' },
  { id: 'london-kitchener', from: 'london', to: 'kitchener', via: 'connector' },
  { id: 'milton-barrie', from: 'milton', to: 'barrie', via: '400' },
  { id: 'milton-peterborough', from: 'milton', to: 'peterborough', via: '401' },
  { id: 'milton-pickering', from: 'milton', to: 'pickering', via: '401' },
  { id: 'milton-niagara', from: 'milton', to: 'niagara-falls', via: 'QEW' },
])

/**
 * Is the route between two nodes currently passable (no closed mainline edge)?
 * Used by Phase 3's routeFeasibility against the regional graph.
 *
 * @returns {{passable:boolean, blockedEdge?:object}}
 */
export function routePassable(from, to) {
  const p = shortestPath(from, to, { avoidClosed: false })
  if (!p) return { passable: false }
  for (const e of p.edges) {
    if (e.closed && e.closureKind === 'mainline') {
      return { passable: false, blockedEdge: e }
    }
  }
  return { passable: true }
}
