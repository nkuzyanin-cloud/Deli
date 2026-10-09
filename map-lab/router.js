/* Local routing experiment: OSM node topology + shortest-time search. No APIs. */
(function (global) {
  'use strict';
  const CELL = 100;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cellKey = (x, y) => `${x},${y}`;
  class Heap {
    constructor() { this.items = []; }
    push(value) {
      const xs = this.items; xs.push(value); let i = xs.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (xs[p][0] <= value[0]) break; xs[i] = xs[p]; i = p; }
      xs[i] = value;
    }
    pop() {
      const xs = this.items, first = xs[0], last = xs.pop();
      if (xs.length) {
        let i = 0;
        while (i * 2 + 1 < xs.length) {
          let c = i * 2 + 1;
          if (c + 1 < xs.length && xs[c + 1][0] < xs[c][0]) c++;
          if (xs[c][0] >= last[0]) break;
          xs[i] = xs[c]; i = c;
        }
        xs[i] = last;
      }
      return first;
    }
    get length() { return this.items.length; }
  }
  function project(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const q = [a[0] + t * dx, a[1] + t * dy];
    return { p: q, t, offset: distance(p, q) };
  }
  class Router {
    constructor(data) {
      this.nodeCount = data.nodes.length;
      this.coords = new Float32Array(this.nodeCount * 2);
      data.nodes.forEach((p, i) => { this.coords[2 * i] = p[0]; this.coords[2 * i + 1] = p[1]; });
      this.edgeNodes = new Uint32Array(data.edges.length * 2);
      this.edgeLengths = new Float32Array(data.edges.length);
      this.edgeFlags = new Uint8Array(data.edges.length);
      this.edgeStreets = new Uint32Array(data.edges.length);
      data.edges.forEach((e, i) => {
        this.edgeNodes[i * 2] = e[0]; this.edgeNodes[i * 2 + 1] = e[1];
        this.edgeLengths[i] = e[2]; this.edgeFlags[i] = e[3]; this.edgeStreets[i] = e[4];
      });
      this.streets = data.streets;
      this.metro = data.metro;
      this.grid = new Map();
      const counts = new Uint32Array(this.nodeCount);
      for (let i = 0; i < data.edges.length; i++) {
        const [a, b, , flags] = data.edges[i];
        if (!(flags & 4)) counts[a]++;
        if (!(flags & 2)) counts[b]++;
        const p = this.node(a), q = this.node(b);
        for (let x = Math.floor(Math.min(p[0], q[0]) / CELL); x <= Math.floor(Math.max(p[0], q[0]) / CELL); x++) {
          for (let y = Math.floor(Math.min(p[1], q[1]) / CELL); y <= Math.floor(Math.max(p[1], q[1]) / CELL); y++) {
            const key = cellKey(x, y);
            if (!this.grid.has(key)) this.grid.set(key, []);
            this.grid.get(key).push(i);
          }
        }
      }
      this.starts = new Uint32Array(this.nodeCount + 1);
      for (let i = 0; i < counts.length; i++) this.starts[i + 1] = this.starts[i] + counts[i];
      this.targets = new Uint32Array(this.starts.at(-1));
      this.edgeIds = new Uint32Array(this.targets.length);
      const cursor = this.starts.slice();
      data.edges.forEach(([a, b, , flags], i) => {
        if (!(flags & 4)) { const k = cursor[a]++; this.targets[k] = b; this.edgeIds[k] = i; }
        if (!(flags & 2)) { const k = cursor[b]++; this.targets[k] = a; this.edgeIds[k] = i; }
      });
      for (const [key, values] of this.grid) this.grid.set(key, Uint32Array.from(values));
      this.workDist = new Float64Array(this.nodeCount);
      this.workPrev = new Int32Array(this.nodeCount);
      this.workEdges = new Int32Array(this.nodeCount);
      this.typedBytes = [this.coords, this.edgeNodes, this.edgeLengths, this.edgeFlags, this.edgeStreets,
        this.starts, this.targets, this.edgeIds, this.workDist, this.workPrev, this.workEdges]
        .reduce((n, a) => n + a.byteLength, 0) + [...this.grid.values()].reduce((n, a) => n + a.byteLength, 0);
      this.stations = this.prepareStations();
    }
    node(i) { return [this.coords[2 * i], this.coords[2 * i + 1]]; }
    edge(i) { return [this.edgeNodes[2 * i], this.edgeNodes[2 * i + 1], this.edgeLengths[i], this.edgeFlags[i], this.edgeStreets[i]]; }
    snap(p, limit = 150) {
      let best = null;
      const checked = new Set();
      for (let x = Math.floor((p[0] - limit) / CELL); x <= Math.floor((p[0] + limit) / CELL); x++) {
        for (let y = Math.floor((p[1] - limit) / CELL); y <= Math.floor((p[1] + limit) / CELL); y++) {
          for (const id of this.grid.get(cellKey(x, y)) || []) {
            if (checked.has(id)) continue;
            checked.add(id);
            const e = this.edge(id), candidate = project(p, this.node(e[0]), this.node(e[1]));
            if (candidate.offset <= limit && (!best || candidate.offset < best.offset)) best = { ...candidate, id };
          }
        }
      }
      return best;
    }
    edgeMeters(id) { return this.edgeLengths[id] * (this.edgeFlags[id] & 1 ? 1.5 : 1); }
    // Dijkstra is used rather than a geographic heuristic: input geometry length
    // is rounded, and retaining exact shortest paths is more valuable here.
    walk(from, to, speed = 4.8, limit = 150) {
      if (distance(from, to) < .1) return { mode: 'walk', coords: [from, to], meters: 0, seconds: 0, snapOffsets: [0, 0], connectors: [], names: [], visited: 0 };
      const s = this.snap(from, limit), t = this.snap(to, limit);
      if (!s || !t) return null;
      const se = this.edge(s.id), te = this.edge(t.id);
      const dist = this.workDist; dist.fill(Infinity);
      const prev = this.workPrev; prev.fill(-1);
      const previousEdge = this.workEdges; previousEdge.fill(-1);
      const queue = new Heap(), endCosts = new Map();
      if (!(te[3] & 4)) endCosts.set(te[0], t.t * this.edgeMeters(t.id));
      if (!(te[3] & 2)) endCosts.set(te[1], (1 - t.t) * this.edgeMeters(t.id));
      const seeds = [];
      if (!(se[3] & 2)) seeds.push([se[0], s.t * this.edgeMeters(s.id)]);
      if (!(se[3] & 4)) seeds.push([se[1], (1 - s.t) * this.edgeMeters(s.id)]);
      for (const [v, d] of seeds) { if (d < dist[v]) { dist[v] = d; queue.push([d, v]); } }
      let bestCost = Infinity, last = -1;
      let direct = false;
      if (s.id === t.id && ((t.t >= s.t && !(se[3] & 4)) || (t.t <= s.t && !(se[3] & 2)))) {
        bestCost = Math.abs(s.t - t.t) * this.edgeMeters(s.id); direct = true;
      }
      let visited = 0;
      while (queue.length) {
        const [cost, u] = queue.pop();
        if (cost !== dist[u]) continue;
        if (cost >= bestCost) break;
        visited++;
        if (endCosts.has(u) && cost + endCosts.get(u) < bestCost) {
          bestCost = cost + endCosts.get(u); last = u; direct = false;
        }
        for (let k = this.starts[u]; k < this.starts[u + 1]; k++) {
          const v = this.targets[k], id = this.edgeIds[k], nd = cost + this.edgeMeters(id);
          if (nd < dist[v]) { dist[v] = nd; prev[v] = u; previousEdge[v] = id; queue.push([nd, v]); }
        }
      }
      if (!Number.isFinite(bestCost)) return null;
      const path = [], pathEdges = [];
      if (!direct) {
        for (let v = last; v !== -1; v = prev[v]) { path.push(v); if (previousEdge[v] !== -1) pathEdges.push(previousEdge[v]); }
        path.reverse(); pathEdges.reverse();
      }
      const coords = direct ? [s.p, t.p] : [s.p, ...path.map(i => this.node(i)), t.p];
      let meters = 0;
      for (let i = 1; i < coords.length; i++) meters += distance(coords[i - 1], coords[i]);
      const names = [...new Set([se[4], ...pathEdges.map(id => this.edgeStreets[id]), te[4]].map(i => this.streets[i]).filter(Boolean))];
      const offsets = s.offset + t.offset;
      return { mode: 'walk', coords, meters: meters + offsets,
        seconds: (bestCost + offsets) / (speed / 3.6), snapOffsets: [s.offset, t.offset],
        connectors: [[from, s.p], [t.p, to]].filter(pair => distance(...pair) > 1), names, visited };
    }
    prepareStations() {
      const stations = [], indices = new Map();
      this.metro.stations.forEach((s, i) => {
        // OSM maps the two branches of line 4 as 4 / 4А / 4A.
        const line = /^4[AА]$/i.test(s.line) ? '4' : s.line;
        // Opposite platforms on the same line are one station in this model.
        let index = stations.findIndex(v => v.name === s.name && v.line === line && distance(v.p, s.p) < 400);
        if (index < 0) { index = stations.length; stations.push({ ...s, line, outgoing: [] }); }
        else stations[index].entrances = [...(stations[index].entrances || []), ...(s.entrances || [])];
        indices.set(i, index);
      });
      this.metro.edges.forEach((e, i) => {
        const a = indices.get(e.a), b = indices.get(e.b);
        if (a === b) return;
        if (!stations[a].outgoing.some(v => v.to === b)) stations[a].outgoing.push({ to: b, edge: i });
      });
      // Only mapped interchanges connect lines. Close stations are not proof
      // of an underground passage (and must not become fake transfers).
      for (const t of this.metro.transfers || []) {
        const a = indices.get(t.a), b = indices.get(t.b);
        if (a === undefined || b === undefined || a === b) continue;
        for (const [from, to] of [[a, b], [b, a]]) {
          if (!stations[from].outgoing.some(e => e.transfer && e.to === to))
            stations[from].outgoing.push({ to, transfer: true, source: t.source });
        }
      }
      stations.forEach(s => {
        const entrances = (s.entrances || []).map(p => ({ p, snap: this.snap(p, 150) })).filter(v => v.snap);
        const entry = entrances.sort((a, b) => a.snap.offset - b.snap.offset)[0];
        s.access = entry?.p || s.p; s.accessApproximate = !entry;
        s.snap = entry?.snap || this.snap(s.p, 300);
      });
      return stations;
    }
    metroPath(a, b, metroSpeed, dwell, transferMinutes = 5, waitMinutes = 0) {
      const queue = new Heap(), costs = Array(this.stations.length).fill(Infinity), prev = [];
      costs[a] = 0; queue.push([0, a]);
      while (queue.length) {
        const [cost, u] = queue.pop(); if (cost !== costs[u]) continue;
        if (u === b) {
          const edges = [], transfers = [];
          for (let v = b; v !== a; v = prev[v].from) {
            const step = prev[v];
            if (step.transfer) { const s = this.stations[step.from], t = this.stations[v];
              edges.push({ mode: 'transfer', fromStation: s.name, toStation: t.name,
                lineFrom: s.line, lineTo: t.line, coords: [s.p, t.p],
                meters: distance(s.p, t.p), seconds: transferMinutes * 60,
                source: step.source }); transfers.push(step);
            } else edges.push({ mode: 'metro', ...this.metro.edges[step.edge], line: this.stations[step.from].line,
              boarding: this.stations[step.from].name, alighting: this.stations[v].name,
              seconds: this.metro.edges[step.edge].meters / (metroSpeed / 3.6) + dwell });
          }
          edges.reverse();
          return { seconds: cost, parts: edges, transfers: transfers.length };
        }
        for (const e of this.stations[u].outgoing) {
          const leg = this.metro.edges[e.edge], seconds = e.transfer ? (transferMinutes + waitMinutes) * 60 : leg.meters / (metroSpeed / 3.6) + dwell;
          const next = cost + seconds;
          if (next < costs[e.to]) { costs[e.to] = next; prev[e.to] = { from: u, ...e }; queue.push([next, e.to]); }
        }
      }
      return null;
    }
    mixed(from, to, options) {
      const { walkSpeed, metroSpeed, dwell, accessMinutes, transferMinutes = 5, waitMinutes = 0 } = options;
      const fallback = this.walk(from, to, walkSpeed);
      let best = fallback ? { mode: 'walk', seconds: fallback.seconds, meters: fallback.meters, parts: [fallback], names: fallback.names, snapOffsets: fallback.snapOffsets } : null;
      const candidates = p => this.stations.map((s, i) => ({ s, i, d: distance(s.access, p) }))
        .filter(v => v.s.snap && v.d < 2300).sort((a, b) => a.d - b.d).slice(0, 5);
      const starts = candidates(from), ends = candidates(to), walkCache = new Map();
      const getWalk = (kind, item) => {
        const key = `${kind}:${item.i}`;
        if (!walkCache.has(key)) walkCache.set(key, kind === 's' ? this.walk(from, item.s.access, walkSpeed, 300) : this.walk(item.s.access, to, walkSpeed, 300));
        return walkCache.get(key);
      };
      for (const a of starts) for (const b of ends) {
        if (a.i === b.i) continue;
        const rail = this.metroPath(a.i, b.i, metroSpeed, dwell, transferMinutes, waitMinutes);
        if (!rail) continue;
        const enter = getWalk('s', a), exit = getWalk('t', b);
        if (!enter || !exit) continue;
        const accessSeconds = accessMinutes * 60 * 2, waitSeconds = waitMinutes * 60 * (rail.transfers + 1);
        // rail.seconds already contains waits after transfers.
        const seconds = enter.seconds + exit.seconds + rail.seconds + accessSeconds + waitMinutes * 60;
        if (best && seconds >= best.seconds) continue;
        const parts = [enter, ...rail.parts, exit];
        best = { mode: 'metro', seconds, meters: parts.reduce((n, p) => n + p.meters, 0), parts,
          boarding: a.s.name, alighting: b.s.name, line: a.s.line,
          lines: [...new Set(rail.parts.filter(p => p.mode === 'metro').map(p => p.line))],
          stations: rail.parts.filter(p => p.mode === 'metro').length, transfers: rail.transfers,
          walkSeconds: enter.seconds + exit.seconds, rideSeconds: rail.parts.filter(p => p.mode === 'metro').reduce((n, p) => n + p.seconds, 0),
          transferSeconds: rail.transfers * transferMinutes * 60, accessSeconds, waitSeconds,
          accessApproximate: a.s.accessApproximate || b.s.accessApproximate,
          names: [...enter.names, ...exit.names], snapOffsets: [enter.snapOffsets[0], exit.snapOffsets[1]] };
      }
      return best;
    }
    route(stops, options) {
      for (const [key, min, max] of [['walkSpeed',2,7], ['metroSpeed',15,70], ['dwell',0,120], ['accessMinutes',0,15], ['transferMinutes',1,15], ['waitMinutes',0,15]]) {
        if ((options.mode === 'metro' || key === 'walkSpeed') && options[key] !== undefined &&
          (!Number.isFinite(options[key]) || options[key] < min || options[key] > max)) throw new Error('Недопустимые параметры расчёта.');
      }
      const legs = [];
      for (let i = 1; i < stops.length; i++) {
        const from = stops[i - 1], to = stops[i];
        const result = options.mode === 'metro' ? this.mixed(from.p, to.p, options) : this.walk(from.p, to.p, options.walkSpeed);
        if (!result) throw new Error(`Не найден связный пеший путь между точками ${i} и ${i + 1}. Уточните точки или выберите адреса внутри тестовой зоны.`);
        const leg = result.parts ? result : { ...result, parts: [result] };
        legs.push({ ...leg, from: i - 1, to: i });
      }
      return { legs, seconds: legs.reduce((n, l) => n + l.seconds, 0), meters: legs.reduce((n, l) => n + l.meters, 0) };
    }
  }
  const exports = { Router, Heap, project, distance };
  global.LocalRouter = exports;
  if (typeof module !== 'undefined') module.exports = exports;
})(typeof self !== 'undefined' ? self : globalThis);
