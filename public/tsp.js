// /public/tsp.js
// Heuristic TSP (Nearest-Neighbor + 2-Opt) บนกราฟ indoor ที่มีอยู่
// ต้องมีฟังก์ชัน global: buildGlobalGraph, dijkstra, pathToFloorSegments
// ใช้งาน: window.TSP.solve({ byFloor, adjPerFloor, stops, opts })

(function () {
  // -------- Utils --------
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

  function sumPathMeters(path, byFloor) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const [fa, ida] = path[i].split(':');
      const [fb, idb] = path[i + 1].split(':');
      const A = byFloor[fa]?.[ida];
      const B = byFloor[fb]?.[idb];
      assert(A && B, `Node not found: ${path[i]} or ${path[i+1]}`);
      // Haversine (เมตร)
      const toRad = (d) => d * Math.PI / 180;
      const R = 6371000;
      const dLat = toRad(B.lat - A.lat);
      const dLon = toRad(B.lon - A.lon);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(A.lat))*Math.cos(toRad(B.lat))*Math.sin(dLon/2)**2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      total += R * c;
    }
    return total;
  }

  function keyOfStop(s) { return `${s.floor}:${s.id}`; }

  // -------- Pairwise shortest paths --------
  async function computePairwise(byFloor, adjPerFloor, stops, opts) {
    assert(stops.length >= 2, 'Need at least 2 stops');
    const G = window.buildGlobalGraph(byFloor, adjPerFloor, { avoidStairs: !!opts.avoidStairs }, opts.floorCost ?? 25);
    const n = stops.length;
    const dist = Array.from({ length: n }, () => Array(n).fill(Infinity));
    const path = Array.from({ length: n }, () => Array(n).fill(null));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { dist[i][j] = 0; continue; }
        const sKey = keyOfStop(stops[i]);
        const gKey = keyOfStop(stops[j]);
        const p = window.dijkstra(G, sKey, gKey);
        if (!p || p.length === 0) continue;
        path[i][j] = p;
        dist[i][j] = sumPathMeters(p, byFloor);
      }
    }
    return { dist, path };
  }

  // -------- TSP Nearest-Neighbor --------
  function tspNearestNeighbor(dist, startIdx = 0) {
    const n = dist.length;
    const used = Array(n).fill(false);
    const order = [startIdx];
    used[startIdx] = true;
    for (let k = 1; k < n; k++) {
      const last = order[order.length - 1];
      let best = -1, bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (!used[j] && dist[last][j] < bestD) { bestD = dist[last][j]; best = j; }
      }
      if (best === -1) break;
      used[best] = true;
      order.push(best);
    }
    return order;
  }

  // -------- 2-Opt improvement --------
  function routeDistance(order, dist, returnToStart) {
    let s = 0;
    for (let i = 0; i < order.length - 1; i++) s += dist[order[i]][order[i+1]];
    if (returnToStart && order.length > 1) s += dist[order[order.length-1]][order[0]];
    return s;
  }

  function twoOpt(orderInit, dist, { maxIter = 1000, returnToStart = false } = {}) {
    let best = orderInit.slice();
    let bestLen = routeDistance(best, dist, returnToStart);
    let improved = true, iter = 0;
    while (improved && iter < maxIter) {
      improved = false; iter++;
      for (let i = 1; i < best.length - 1; i++) {
        for (let k = i + 1; k < best.length; k++) {
          const newOrder = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          const newLen = routeDistance(newOrder, dist, returnToStart);
          if (newLen + 1e-6 < bestLen) {
            best = newOrder; bestLen = newLen; improved = true;
          }
        }
      }
    }
    return best;
  }

  // -------- Assemble result for UI --------
  function assembleRoute(byFloor, stops, order, pathMatrix, { returnToStart = false } = {}) {
    const legs = [];
    const segments = [];
    const points = [];
    const seq = order.slice();
    if (returnToStart) seq.push(order[0]);

    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      const p = pathMatrix[a][b];
      if (!p) throw new Error(`No path between ${stops[a].floor}:${stops[a].id} -> ${stops[b].floor}:${stops[b].id}`);
      const segs = window.pathToFloorSegments(p, byFloor);
      legs.push({ from: stops[a], to: stops[b], path: p, segs });
      segs.forEach(s => segments.push(s));
      segs.forEach(s => s.points.forEach(pt => points.push(pt)));
    }
    return { legs, segments, points };
  }

  // -------- Public API --------
  async function solve({ byFloor, adjPerFloor, stops, opts = {} }) {
    const { dist, path } = await computePairwise(byFloor, adjPerFloor, stops, opts);
    // เลือก start: คงที่หรือหา start ที่ NN route สั้นสุด
    const candidateStarts = typeof opts.startIndex === 'number'
      ? [opts.startIndex]
      : Array.from({ length: stops.length }, (_, i) => i);
    let bestOrder = null, bestCost = Infinity;

    for (const s of candidateStarts) {
      const nn = tspNearestNeighbor(dist, s);
      const improved = twoOpt(nn, dist, { maxIter: opts.maxIter ?? 800, returnToStart: !!opts.returnToStart });
      const cost = routeDistance(improved, dist, !!opts.returnToStart);
      if (cost < bestCost) { bestCost = cost; bestOrder = improved; }
    }
    const result = assembleRoute(byFloor, stops, bestOrder, path, { returnToStart: !!opts.returnToStart });
    return { order: bestOrder, costMeters: bestCost, ...result };
  }

  // attach
  window.TSP = { solve };
})();