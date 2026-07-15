import { haversineMeters, projectPointOntoSegment, type LonLat } from './geo.js'
import type { Campsite, TrailsGeoJson } from './types.js'

export interface GraphNode {
  id: string
  lon: number
  lat: number
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  distanceMeters: number
  /** Polyline from `from` to `to`, inclusive of both endpoints, used for elevation sampling and route drawing. */
  polyline: LonLat[]
}

export interface TrailGraph {
  nodes: Map<string, GraphNode>
  adjacency: Map<string, GraphEdge[]>
  /** One direction of every edge in the graph, useful for warming caches etc. */
  edges: GraphEdge[]
  /** campsite id -> graph node id it was snapped to */
  campsiteNodeIds: Map<string, string>
}

const JUNCTION_SNAP_METERS = 15
/** Below this snap distance we alias the campsite directly onto the trail rather than adding a visible spur edge. */
const NEGLIGIBLE_SPUR_METERS = 3

/**
 * A small number of real, physical trail/road connections aren't contiguously digitized in the
 * OSM source data (e.g. a river crossing mapped as a separate, unnamed bridge way, or a short
 * unmapped stretch between a trailhead parking spur and where the trail itself starts) and so
 * don't get picked up by the automatic exact/fuzzy junction merge above. Rather than a blanket
 * "snap anything within N meters" heuristic — which risks fabricating shortcuts across canyon
 * switchbacks that happen to pass close to each other horizontally without being connected —
 * each of these is manually identified and verified by inspecting the underlying geometry.
 * Keyed by park id, since `nearestNodeTo` below has no distance cutoff and would otherwise
 * silently attach another park's coordinates to whichever node happens to be closest.
 */
const MANUAL_CONNECTORS: Record<string, [LonLat, LonLat][]> = {
  'grand-canyon': [
    [
      // River Trail has a ~156m gap right where it should cross the Colorado River (Silver/Black
      // Bridge) to reach Phantom Ranch and the North Kaibab Trail, which otherwise leaves
      // Cottonwood Campground unreachable from the rest of the network.
      { lon: -112.09571, lat: 36.09697 }, // River Trail, south bank
      { lon: -112.09539, lat: 36.09835 }, // River Trail, north bank (continues to North Kaibab Trail)
    ],
  ],
  'rocky-mountain': [
    [
      // Summerland Park Road ends ~100m short of where North Inlet Trail actually starts — the
      // gap is the short walk across the trailhead parking area, not captured by either way.
      { lon: -105.815935, lat: 40.2563304 }, // Summerland Park Road, north (parking) end
      { lon: -105.8146948, lat: 40.2565483 }, // North Inlet Trail trailhead
    ],
  ],
}

function coordKey(lon: number, lat: number): string {
  return `${lon.toFixed(6)},${lat.toFixed(6)}`
}

class UnionFind {
  private parent = new Map<string, string>()

  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    let cur = id
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

export function buildGraph(trails: TrailsGeoJson, campsites: Campsite[], parkId: string): TrailGraph {
  let nodeSeq = 0
  let edgeSeq = 0
  const rawNodes = new Map<string, GraphNode>()
  const coordKeyToNodeId = new Map<string, string>()

  function getOrCreateRawNode(lon: number, lat: number): string {
    const key = coordKey(lon, lat)
    let id = coordKeyToNodeId.get(key)
    if (!id) {
      id = `n${nodeSeq++}`
      rawNodes.set(id, { id, lon, lat })
      coordKeyToNodeId.set(key, id)
    }
    return id
  }

  const rawEdges: GraphEdge[] = []
  const endpointNodeIds = new Set<string>()
  /** Which trail feature(s) each node belongs to, so endpoint bridging can exclude a node's own trail. */
  const nodeFeatureIndex = new Map<string, Set<number>>()
  function tagNodeFeature(nodeId: string, featureIdx: number) {
    if (!nodeFeatureIndex.has(nodeId)) nodeFeatureIndex.set(nodeId, new Set())
    nodeFeatureIndex.get(nodeId)!.add(featureIdx)
  }

  trails.features.forEach((feature, featureIdx) => {
    const coords = feature.geometry.coordinates
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i]
      const [lon2, lat2] = coords[i + 1]
      const fromId = getOrCreateRawNode(lon1, lat1)
      const toId = getOrCreateRawNode(lon2, lat2)
      tagNodeFeature(fromId, featureIdx)
      tagNodeFeature(toId, featureIdx)
      if (i === 0) endpointNodeIds.add(fromId)
      if (i === coords.length - 2) endpointNodeIds.add(toId)
      if (fromId === toId) continue
      const a: LonLat = { lon: lon1, lat: lat1 }
      const b: LonLat = { lon: lon2, lat: lat2 }
      rawEdges.push({ id: `e${edgeSeq++}`, from: fromId, to: toId, distanceMeters: haversineMeters(a, b), polyline: [a, b] })
    }
  })

  // Merge near-miss junctions (different trail features whose *endpoints* are close but not
  // exactly coincident) so the network is fully connected across trail names. This is
  // deliberately restricted to feature endpoints, not interior vertices: tight switchbacks on
  // trails like Hermit or Bright Angel can bring two unrelated interior points within a few
  // meters of each other horizontally despite being hundreds of feet apart vertically, and
  // fuzzy-merging those would fabricate a "shortcut" edge straight through the mountainside.
  // Real junctions, by contrast, occur at trail endpoints (or already share exact coordinates,
  // handled by getOrCreateRawNode above). With ~17k vertices in the OSM data, a naive O(n^2)
  // comparison is far too slow, so endpoint nodes are bucketed into a coarse grid and only
  // compared against neighboring cells.
  const uf = new UnionFind()
  for (const id of rawNodes.keys()) uf.add(id)

  const METERS_PER_DEGREE_LAT = 111320
  const cellSizeDeg = JUNCTION_SNAP_METERS / METERS_PER_DEGREE_LAT
  const grid = new Map<string, string[]>()
  function cellKeyFor(lon: number, lat: number): [number, number] {
    return [Math.floor(lon / cellSizeDeg), Math.floor(lat / cellSizeDeg)]
  }
  const endpointIds = [...endpointNodeIds]
  for (const id of endpointIds) {
    const node = rawNodes.get(id)!
    const [cx, cy] = cellKeyFor(node.lon, node.lat)
    const key = `${cx},${cy}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(id)
  }

  for (const id of endpointIds) {
    const node = rawNodes.get(id)!
    const [cx, cy] = cellKeyFor(node.lon, node.lat)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighbors = grid.get(`${cx + dx},${cy + dy}`)
        if (!neighbors) continue
        for (const otherId of neighbors) {
          if (otherId <= id) continue // each unordered pair considered once
          if (uf.find(id) === uf.find(otherId)) continue
          const other = rawNodes.get(otherId)!
          if (haversineMeters(node, other) <= JUNCTION_SNAP_METERS) uf.union(id, otherId)
        }
      }
    }
  }
  const nodeIds = [...rawNodes.keys()]

  const nodes = new Map<string, GraphNode>()
  for (const id of nodeIds) {
    const root = uf.find(id)
    if (!nodes.has(root)) nodes.set(root, rawNodes.get(root)!)
  }

  const adjacency = new Map<string, GraphEdge[]>()
  const canonicalEdges: GraphEdge[] = []

  function addUndirectedEdge(edge: GraphEdge) {
    if (edge.from === edge.to) return
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
    adjacency.get(edge.from)!.push(edge)
    adjacency.get(edge.to)!.push({ ...edge, from: edge.to, to: edge.from, polyline: [...edge.polyline].reverse() })
    canonicalEdges.push(edge)
  }

  for (const e of rawEdges) {
    addUndirectedEdge({ ...e, from: uf.find(e.from), to: uf.find(e.to) })
  }

  function nearestNodeTo(point: LonLat): GraphNode {
    let best: { node: GraphNode; d: number } | null = null
    for (const node of nodes.values()) {
      const d = haversineMeters(point, node)
      if (!best || d < best.d) best = { node, d }
    }
    return best!.node
  }

  for (const [pointA, pointB] of MANUAL_CONNECTORS[parkId] ?? []) {
    const nodeA = nearestNodeTo(pointA)
    const nodeB = nearestNodeTo(pointB)
    addUndirectedEdge({
      id: `e${edgeSeq++}`,
      from: nodeA.id,
      to: nodeB.id,
      distanceMeters: haversineMeters(nodeA, nodeB),
      polyline: [nodeA, nodeB],
    })
  }

  function removeEdge(target: GraphEdge) {
    const fwd = adjacency.get(target.from)
    if (fwd) adjacency.set(target.from, fwd.filter((e) => e.id !== target.id))
    const bwd = adjacency.get(target.to)
    if (bwd) adjacency.set(target.to, bwd.filter((e) => e.id !== target.id))
    const idx = canonicalEdges.findIndex((e) => e.id === target.id)
    if (idx >= 0) canonicalEdges.splice(idx, 1)
  }

  // Snap each campsite onto the nearest point on the trail network, splitting that edge
  // and adding a short spur edge if the campsite sits off the digitized trail line.
  const campsiteNodeIds = new Map<string, string>()

  for (const site of campsites) {
    const p: LonLat = { lon: site.lon, lat: site.lat }

    let best: { edge: GraphEdge; proj: LonLat; distanceMeters: number } | null = null
    for (const edge of canonicalEdges) {
      const a = nodes.get(edge.from)!
      const b = nodes.get(edge.to)!
      const { point, distanceMeters } = projectPointOntoSegment(p, a, b)
      if (!best || distanceMeters < best.distanceMeters) best = { edge, proj: point, distanceMeters }
    }

    if (!best) {
      throw new Error(`No trail edges available to snap campsite ${site.id}`)
    }

    const { edge, proj, distanceMeters } = best
    const a = nodes.get(edge.from)!
    const b = nodes.get(edge.to)!

    const atA = haversineMeters(proj, a) < 0.5
    const atB = haversineMeters(proj, b) < 0.5

    let trailNodeId: string
    if (atA) {
      trailNodeId = a.id
    } else if (atB) {
      trailNodeId = b.id
    } else {
      trailNodeId = `n${nodeSeq++}`
      nodes.set(trailNodeId, { id: trailNodeId, lon: proj.lon, lat: proj.lat })
      removeEdge(edge)
      addUndirectedEdge({
        id: `e${edgeSeq++}`,
        from: edge.from,
        to: trailNodeId,
        distanceMeters: haversineMeters(a, proj),
        polyline: [a, proj],
      })
      addUndirectedEdge({
        id: `e${edgeSeq++}`,
        from: trailNodeId,
        to: edge.to,
        distanceMeters: haversineMeters(proj, b),
        polyline: [proj, b],
      })
    }

    if (distanceMeters < NEGLIGIBLE_SPUR_METERS) {
      campsiteNodeIds.set(site.id, trailNodeId)
      // Keep the node's displayed coordinate as the campsite's own surveyed position.
      nodes.set(trailNodeId, { id: trailNodeId, lon: site.lon, lat: site.lat })
    } else {
      const siteNodeId = `campsite:${site.id}`
      nodes.set(siteNodeId, { id: siteNodeId, lon: site.lon, lat: site.lat })
      addUndirectedEdge({
        id: `e${edgeSeq++}`,
        from: siteNodeId,
        to: trailNodeId,
        distanceMeters,
        polyline: [p, proj],
      })
      campsiteNodeIds.set(site.id, siteNodeId)
    }
  }

  return { nodes, adjacency, edges: canonicalEdges, campsiteNodeIds }
}

let adhocSeq = 0

/**
 * Snaps an arbitrary map-clicked point onto the nearest point of the trail network, splicing it
 * in exactly like campsite snapping does, so a route can be computed to/from any spot a user
 * picks rather than only the curated campsite list. Mutates the graph in place (adds nodes/edges)
 * using a separate id namespace ("adhoc-...") so it can never collide with ids created at graph
 * build time. This is a small, unbounded accumulation over a server's lifetime, which is fine for
 * an MVP running as a single long-lived dev/local process; it isn't persisted or replayed.
 */
export function attachPointToNetwork(graph: TrailGraph, point: LonLat): string {
  let best: { edge: GraphEdge; proj: LonLat; distanceMeters: number } | null = null
  for (const edge of graph.edges) {
    const a = graph.nodes.get(edge.from)!
    const b = graph.nodes.get(edge.to)!
    const { point: proj, distanceMeters } = projectPointOntoSegment(point, a, b)
    if (!best || distanceMeters < best.distanceMeters) best = { edge, proj, distanceMeters }
  }
  if (!best) throw new Error('No trail edges available to attach point to')

  const { edge, proj, distanceMeters } = best
  const a = graph.nodes.get(edge.from)!
  const b = graph.nodes.get(edge.to)!

  function addUndirectedEdge(e: GraphEdge) {
    if (e.from === e.to) return
    if (!graph.adjacency.has(e.from)) graph.adjacency.set(e.from, [])
    if (!graph.adjacency.has(e.to)) graph.adjacency.set(e.to, [])
    graph.adjacency.get(e.from)!.push(e)
    graph.adjacency.get(e.to)!.push({ ...e, from: e.to, to: e.from, polyline: [...e.polyline].reverse() })
    graph.edges.push(e)
  }
  function removeEdge(target: GraphEdge) {
    const fwd = graph.adjacency.get(target.from)
    if (fwd) graph.adjacency.set(target.from, fwd.filter((x) => x.id !== target.id))
    const bwd = graph.adjacency.get(target.to)
    if (bwd) graph.adjacency.set(target.to, bwd.filter((x) => x.id !== target.id))
    const idx = graph.edges.findIndex((x) => x.id === target.id)
    if (idx >= 0) graph.edges.splice(idx, 1)
  }

  const atA = haversineMeters(proj, a) < 0.5
  const atB = haversineMeters(proj, b) < 0.5

  let trailNodeId: string
  if (atA) {
    trailNodeId = a.id
  } else if (atB) {
    trailNodeId = b.id
  } else {
    trailNodeId = `adhoc-n${adhocSeq++}`
    graph.nodes.set(trailNodeId, { id: trailNodeId, lon: proj.lon, lat: proj.lat })
    removeEdge(edge)
    addUndirectedEdge({ id: `adhoc-e${adhocSeq++}`, from: edge.from, to: trailNodeId, distanceMeters: haversineMeters(a, proj), polyline: [a, proj] })
    addUndirectedEdge({ id: `adhoc-e${adhocSeq++}`, from: trailNodeId, to: edge.to, distanceMeters: haversineMeters(proj, b), polyline: [proj, b] })
  }

  if (distanceMeters < NEGLIGIBLE_SPUR_METERS) {
    return trailNodeId
  }

  const pointNodeId = `adhoc-p${adhocSeq++}`
  graph.nodes.set(pointNodeId, { id: pointNodeId, lon: point.lon, lat: point.lat })
  addUndirectedEdge({ id: `adhoc-e${adhocSeq++}`, from: pointNodeId, to: trailNodeId, distanceMeters, polyline: [point, proj] })
  return pointNodeId
}

export interface PathResult {
  edges: GraphEdge[]
  totalDistanceMeters: number
}

export function shortestPath(graph: TrailGraph, fromNodeId: string, toNodeId: string): PathResult | null {
  const dist = new Map<string, number>([[fromNodeId, 0]])
  const prevEdge = new Map<string, GraphEdge>()
  const visited = new Set<string>()
  const pq: [string, number][] = [[fromNodeId, 0]]

  while (pq.length > 0) {
    pq.sort((a, b) => a[1] - b[1])
    const [u, d] = pq.shift()!
    if (visited.has(u)) continue
    visited.add(u)
    if (u === toNodeId) break

    for (const edge of graph.adjacency.get(u) ?? []) {
      if (visited.has(edge.to)) continue
      const nd = d + edge.distanceMeters
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd)
        prevEdge.set(edge.to, edge)
        pq.push([edge.to, nd])
      }
    }
  }

  const total = dist.get(toNodeId)
  if (total === undefined) return null

  const edges: GraphEdge[] = []
  let cur = toNodeId
  while (cur !== fromNodeId) {
    const edge = prevEdge.get(cur)
    if (!edge) return null
    edges.unshift(edge)
    cur = edge.from
  }

  return { edges, totalDistanceMeters: total }
}
