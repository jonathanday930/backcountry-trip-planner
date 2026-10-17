/**
 * Diagnoses a leg whose distance is way off from Komoot (a routing-gap symptom, as opposed to
 * elevation being off with distance close — that's a filter-tuning problem, see
 * sweepElevationFilter.ts instead). See testing/README.md's "Diagnosing a routing gap" section.
 *
 * Usage (run from backend/):
 *   npx tsx src/scripts/diagnoseRoutingGap.ts --park <parkId> --from <campsiteId> --to <campsiteId>
 *
 * Prints:
 *   - whether a path exists at all, and its length vs. the straight-line distance (a ratio over
 *     ~3-4x on a real maintained trail usually means a genuine gap, not just a winding trail —
 *     but confirm terrain first, some real trails do wind that much)
 *   - if a path exists but the ratio is high: the nearest non-adjacent node to each endpoint,
 *     which is the fastest way to spot a small (tens-to-hundreds of meters) real digitization gap
 *     worth a MANUAL_CONNECTORS entry in graph.ts
 *
 * To verify a candidate connector actually closes the gap before committing it to graph.ts, add
 * `--verify-connector <nodeIdA> <nodeIdB>` — this patches a synthetic edge into an in-memory copy
 * of the graph and re-checks shortestPath. IMPORTANT: a verified-nearby node is not automatically
 * a real fix — this session found three cases (Mono Creek/Bear Ridge and others in
 * sierra-national-forest, West Fork White River/Lake Eleanor Camp in mount-rainier) where the
 * nearest non-adjacent node was itself an isolated dead-end fragment that didn't lead anywhere
 * closer, meaning the underlying corridor is either off-network (no real maintained trail exists,
 * confirmed via web research) or has a much deeper multi-fragment digitization gap than a single
 * connector can close. Don't add a connector just because a nearby node exists — verify it
 * actually shortens the path first.
 */
import { loadParkNetwork } from '../parkNetwork.js'
import { shortestPath, type TrailGraph, type GraphEdge } from '../graph.js'
import { PARKS } from '../parks.js'

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const [lat1, lon1] = a
  const [lat2, lon2] = b
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function component(graph: TrailGraph, start: string): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const u = queue.pop()!
    for (const edge of graph.adjacency.get(u) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return seen
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i === -1 ? undefined : args[i + 1]
  }
  const vc = args.indexOf('--verify-connector')
  return {
    park: get('--park'),
    from: get('--from'),
    to: get('--to'),
    verifyConnector: vc === -1 ? undefined : ([args[vc + 1], args[vc + 2]] as [string, string]),
    radius: get('--radius') != null ? Number(get('--radius')) : 700,
  }
}

function main() {
  const { park: parkId, from: fromId, to: toId, verifyConnector, radius } = parseArgs()
  if (!parkId || !fromId || !toId) {
    console.error('Usage: npx tsx src/scripts/diagnoseRoutingGap.ts --park <parkId> --from <id> --to <id> [--radius <meters>] [--verify-connector <nodeA> <nodeB>]')
    process.exit(1)
  }
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) {
    console.error('Unknown park id:', parkId)
    process.exit(1)
  }
  const { graph } = loadParkNetwork(park)
  const a = graph.campsiteNodeIds.get(fromId)
  const b = graph.campsiteNodeIds.get(toId)
  if (a == null || b == null) {
    console.error('missing node id(s):', fromId, a, toId, b)
    process.exit(1)
  }

  if (verifyConnector) {
    const [nodeAId, nodeBId] = verifyConnector
    const nodeA = graph.nodes.get(nodeAId)
    const nodeB = graph.nodes.get(nodeBId)
    if (!nodeA || !nodeB) {
      console.error('connector node not found:', nodeAId, !!nodeA, nodeBId, !!nodeB)
      process.exit(1)
    }
    const distMeters = haversineMeters([nodeA.lat, nodeA.lon], [nodeB.lat, nodeB.lon])
    const edge: GraphEdge = { id: 'verify-connector', from: nodeAId, to: nodeBId, distanceMeters: distMeters, polyline: [{ lon: nodeA.lon, lat: nodeA.lat }, { lon: nodeB.lon, lat: nodeB.lat }] }
    const reverseEdge: GraphEdge = { ...edge, id: 'verify-connector-rev', from: nodeBId, to: nodeAId, polyline: [...edge.polyline].reverse() }
    if (!graph.adjacency.has(nodeAId)) graph.adjacency.set(nodeAId, [])
    if (!graph.adjacency.has(nodeBId)) graph.adjacency.set(nodeBId, [])
    graph.adjacency.get(nodeAId)!.push(edge)
    graph.adjacency.get(nodeBId)!.push(reverseEdge)
    const path = shortestPath(graph, a, b)
    if (!path) {
      console.log('STILL NO PATH after adding', distMeters.toFixed(0), 'm connector')
    } else {
      const used = path.edges.some((e) => e.id === 'verify-connector' || e.id === 'verify-connector-rev')
      console.log(
        'With connector (' + distMeters.toFixed(0) + 'm):',
        (path.totalDistanceMeters / 1609.34).toFixed(2),
        'mi total,',
        used ? '[connector USED — this candidate helps]' : "[connector NOT used — a shorter path exists elsewhere; this candidate doesn't fix it]",
      )
    }
    return
  }

  const path = shortestPath(graph, a, b)
  const nodeA = graph.nodes.get(a)!
  const nodeB = graph.nodes.get(b)!
  const straightLine = haversineMeters([nodeA.lat, nodeA.lon], [nodeB.lat, nodeB.lon])

  const compA = component(graph, a)
  console.log('same connected component:', compA.has(b), '(compA size:', compA.size + ')')

  if (!path) {
    console.log('NO PATH FOUND. straight-line:', (straightLine / 1609.34).toFixed(2), 'mi')
  } else {
    const ratio = path.totalDistanceMeters / straightLine
    console.log(
      'path found,',
      path.edges.length,
      'edges, pathLen',
      (path.totalDistanceMeters / 1609.34).toFixed(2),
      'mi, straight-line',
      (straightLine / 1609.34).toFixed(2),
      'mi, ratio',
      ratio.toFixed(2),
      ratio > 4 ? '  <-- high; investigate (see below) before assuming this is just a winding trail' : '',
    )
  }

  // Nearest non-adjacent node to each endpoint — the fastest signal for "is there a small,
  // real digitization gap here" regardless of whether a and b are in the same overall component.
  for (const [label, nodeId] of [['from', a], ['to', b]] as const) {
    const node = graph.nodes.get(nodeId)!
    const directNeighbors = new Set((graph.adjacency.get(nodeId) ?? []).map((e) => e.to))
    directNeighbors.add(nodeId)
    const nearby: { id: string; dist: number; degree: number }[] = []
    for (const [nid, n] of graph.nodes) {
      if (directNeighbors.has(nid)) continue
      const d = haversineMeters([node.lat, node.lon], [n.lat, n.lon])
      if (d <= radius) nearby.push({ id: nid, dist: d, degree: (graph.adjacency.get(nid) ?? []).length })
    }
    nearby.sort((x, y) => x.dist - y.dist)
    console.log(`\nnearest non-adjacent nodes to "${label}" (${nodeId}) within ${radius}m:`, nearby.length)
    nearby.slice(0, 8).forEach((n) => console.log('  ', n.id, n.dist.toFixed(0) + 'm', 'degree=' + n.degree))
    if (nearby.length && nearby[0].dist < 200) {
      console.log(`  closest is only ${nearby[0].dist.toFixed(0)}m away — verify with --verify-connector ${nodeId} ${nearby[0].id} before assuming this is the fix.`)
    }
  }
}

main()
