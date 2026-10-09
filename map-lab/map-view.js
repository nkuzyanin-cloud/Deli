/* Minimal local Canvas vector map; draws downloaded OSM geometry, not tiles from a provider. */
(function (global) {
  'use strict';
  class VectorMap {
    constructor(canvas, data, onPoint, onFrame) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.data = data;
      this.onPoint = onPoint; this.onFrame = onFrame; this.scale = .11;
      this.cx = 0; this.cy = 0; this.stops = []; this.legs = []; this.pending = false;
      this.pointers = new Map(); this.picking = false; this.features = []; this.grid = new Map();
      this.gridSize = 500; this.frameTimes = []; this.indexFeatures();
      this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(canvas);
      this.installGestures(); this.fitZone();
    }
    addFeature(type, value, points) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      const f = { type, value, minX, minY, maxX, maxY }, id = this.features.length;
      this.features.push(f);
      for (let x = Math.floor(minX / this.gridSize); x <= Math.floor(maxX / this.gridSize); x++) for (let y = Math.floor(minY / this.gridSize); y <= Math.floor(maxY / this.gridSize); y++) {
        const key = `${x},${y}`; if (!this.grid.has(key)) this.grid.set(key, []); this.grid.get(key).push(id);
      }
    }
    indexFeatures() {
      this.data.roads.forEach(r => this.addFeature('road', r, r[2].map(i => this.node(i))));
      this.data.polygons.forEach(p => {
        const ps = [];
        for (const poly of p[1]) for (const ring of poly) for (let i = 0; i < ring.length; i += 2) ps.push([ring[i], ring[i + 1]]);
        this.addFeature('polygon', p, ps);
      });
      this.data.metro.edges.forEach(e => this.addFeature('rail', e, e.coords));
      const xs = this.data.bbox;
      this.zone = { left: (xs[0] - this.data.origin[0]) * this.data.scale[0],
        right: (xs[2] - this.data.origin[0]) * this.data.scale[0],
        bottom: (xs[1] - this.data.origin[1]) * this.data.scale[1],
        top: (xs[3] - this.data.origin[1]) * this.data.scale[1] };
    }
    node(i) { return [this.data.nodes[2 * i], this.data.nodes[2 * i + 1]]; }
    resize() {
      const rect = this.canvas.getBoundingClientRect(), ratio = Math.min(2, devicePixelRatio || 1);
      this.width = rect.width; this.height = rect.height; this.ratio = ratio;
      this.canvas.width = Math.round(rect.width * ratio); this.canvas.height = Math.round(rect.height * ratio);
      this.requestDraw();
    }
    toScreen(p) { return [(p[0] - this.cx) * this.scale + this.width / 2, (this.cy - p[1]) * this.scale + this.height / 2]; }
    toWorld(x, y) { return [(x - this.width / 2) / this.scale + this.cx, this.cy - (y - this.height / 2) / this.scale]; }
    eventPoint(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    installGestures() {
      this.canvas.addEventListener('pointerdown', e => {
        this.canvas.setPointerCapture(e.pointerId); const p = this.eventPoint(e);
        this.pointers.set(e.pointerId, p); this.tapStart = { p, at: performance.now(), moved: false };
        this.gesture = { cx: this.cx, cy: this.cy, scale: this.scale, points: [...this.pointers.values()] };
        if (this.pointers.size > 1) this.tapStart.moved = true;
      });
      this.canvas.addEventListener('pointermove', e => {
        if (!this.pointers.has(e.pointerId)) return;
        const p = this.eventPoint(e); this.pointers.set(e.pointerId, p);
        if (Math.hypot(p[0] - this.tapStart.p[0], p[1] - this.tapStart.p[1]) > 6) this.tapStart.moved = true;
        const now = [...this.pointers.values()], initial = this.gesture.points;
        if (now.length === 1 && initial.length === 1) {
          this.cx = this.gesture.cx - (now[0][0] - initial[0][0]) / this.scale;
          this.cy = this.gesture.cy + (now[0][1] - initial[0][1]) / this.scale;
        } else if (now.length >= 2 && initial.length >= 2) {
          const d0 = Math.hypot(initial[1][0] - initial[0][0], initial[1][1] - initial[0][1]);
          const d1 = Math.hypot(now[1][0] - now[0][0], now[1][1] - now[0][1]);
          const oldMid = [(initial[0][0] + initial[1][0]) / 2, (initial[0][1] + initial[1][1]) / 2];
          const newMid = [(now[0][0] + now[1][0]) / 2, (now[0][1] + now[1][1]) / 2];
          this.scale = Math.max(.025, Math.min(2.4, this.gesture.scale * d1 / (d0 || 1)));
          const anchor = [(oldMid[0] - this.width / 2) / this.gesture.scale + this.gesture.cx,
            this.gesture.cy - (oldMid[1] - this.height / 2) / this.gesture.scale];
          this.cx = anchor[0] - (newMid[0] - this.width / 2) / this.scale;
          this.cy = anchor[1] + (newMid[1] - this.height / 2) / this.scale;
        }
        this.constrain(); this.requestDraw();
      });
      const end = e => {
        const p = this.pointers.get(e.pointerId), tap = e.type === 'pointerup' && this.pointers.size === 1 && this.tapStart && !this.tapStart.moved;
        this.pointers.delete(e.pointerId);
        if (tap && this.picking && p) this.onPoint(this.toWorld(...p));
        if (this.pointers.size) this.gesture = { cx: this.cx, cy: this.cy, scale: this.scale, points: [...this.pointers.values()] };
      };
      this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end);
      this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, this.eventPoint(e)); }, { passive: false });
      this.canvas.addEventListener('keydown', e => {
        const moves = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
        if (moves[e.key]) { e.preventDefault(); this.cx += moves[e.key][0] / this.scale; this.cy += moves[e.key][1] / this.scale; this.constrain(); this.requestDraw(); }
        if (e.key === '+' || e.key === '=') this.zoom(1.4);
        if (e.key === '-') this.zoom(1 / 1.4);
      });
    }
    constrain() {
      if (!this.zone) return;
      this.cx = Math.max(this.zone.left - 500, Math.min(this.zone.right + 500, this.cx));
      this.cy = Math.max(this.zone.bottom - 500, Math.min(this.zone.top + 500, this.cy));
    }
    zoom(factor, anchor = [this.width / 2, this.height / 2]) {
      const p = this.toWorld(...anchor); this.scale = Math.max(.025, Math.min(2.4, this.scale * factor));
      this.cx = p[0] - (anchor[0] - this.width / 2) / this.scale;
      this.cy = p[1] + (anchor[1] - this.height / 2) / this.scale;
      this.constrain(); this.requestDraw();
    }
    fitZone() {
      // Start at a useful street level, not a tiny overview of the entire pack.
      this.cx = -90; this.cy = -2200; this.scale = .10; this.requestDraw();
    }
    fitRoute() {
      const points = this.stops.map(s => s.p);
      for (const leg of this.legs) for (const part of leg.parts) points.push(...part.coords);
      if (!points.length) return this.fitZone();
      let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
      for (const p of points) { left = Math.min(left, p[0]); right = Math.max(right, p[0]); bottom = Math.min(bottom, p[1]); top = Math.max(top, p[1]); }
      // Reserve the right-hand strip for zoom controls; pins must stay visible.
      this.scale = Math.max(.025, Math.min(.6, (this.width - 104) / Math.max(250, right - left), (this.height - 70) / Math.max(250, top - bottom)));
      this.cx = (left + right) / 2 + 22 / this.scale; this.cy = (bottom + top) / 2 + 5 / this.scale;
      this.constrain(); this.requestDraw();
    }
    setRoute(stops, legs = []) { this.stops = stops; this.legs = legs; this.requestDraw(); }
    requestDraw() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.draw(); }); }
    visibleFeatures() {
      const a = this.toWorld(-80, this.height + 80), b = this.toWorld(this.width + 80, -80), ids = new Set(), out = [];
      for (let x = Math.floor(a[0] / this.gridSize); x <= Math.floor(b[0] / this.gridSize); x++) for (let y = Math.floor(a[1] / this.gridSize); y <= Math.floor(b[1] / this.gridSize); y++) {
        for (const i of this.grid.get(`${x},${y}`) || []) {
          const f = this.features[i];
          if (f.type === 'polygon' && f.value[0] === 0 && this.scale < .16) continue;
          if (f.type === 'road' && !this.roadVisible(f.value[0])) continue;
          ids.add(i);
        }
      }
      for (const id of ids) { const f = this.features[id]; if (f.maxX >= a[0] && f.minX <= b[0] && f.maxY >= a[1] && f.minY <= b[1]) out.push(f); }
      return out;
    }
    roadVisible(type) {
      if (this.scale < .055) return type <= 4;
      if (this.scale < .12) return type <= 8 || type === 10;
      return true;
    }
    cachedPath(f) {
      if (f.path) return f.path;
      const p = new Path2D();
      if (f.type === 'polygon') {
        for (const poly of f.value[1]) for (const ring of poly) {
          for (let i = 0; i < ring.length; i += 2) i ? p.lineTo(ring[i], ring[i + 1]) : p.moveTo(ring[i], ring[i + 1]);
          p.closePath();
        }
      } else {
        const coords = f.type === 'road' ? f.value[2].map(i => this.node(i)) : f.value.coords;
        coords.forEach((v, i) => i ? p.lineTo(...v) : p.moveTo(...v));
      }
      f.path = p; return p;
    }
    path(points) {
      const c = this.ctx; c.beginPath();
      points.forEach((p, i) => { const [x, y] = this.toScreen(p); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    }
    draw() {
      if (!this.width || !this.height) return;
      const start = performance.now(), c = this.ctx, visible = this.visibleFeatures();
      c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0); c.fillStyle = '#f0f4f8'; c.fillRect(0, 0, this.width, this.height);
      // Reuse native paths in world coordinates. No per-vertex JS projection on pan/zoom.
      c.setTransform(this.scale * this.ratio, 0, 0, -this.scale * this.ratio,
        (this.width / 2 - this.cx * this.scale) * this.ratio, (this.height / 2 + this.cy * this.scale) * this.ratio);
      const colours = ['#dfe5ed', '#c2dff0', '#dceadf'];
      for (const kind of [2, 1, 0]) {
        c.fillStyle = colours[kind];
        for (const f of visible) if (f.type === 'polygon' && f.value[0] === kind) {
          c.fill(this.cachedPath(f), 'evenodd');
        }
      }
      const roads = visible.filter(f => f.type === 'road');
      const width = t => t <= 4 ? [7, 7, 6, 5, 4][t] : t <= 8 ? 2.5 : 1.3;
      c.lineJoin = 'round'; c.lineCap = 'round';
      // Batch same-style paths: a handful of native strokes, not thousands.
      const batches = new Map();
      for (const f of roads) {
        const type = f.value[0];
        if (!batches.has(type)) batches.set(type, new Path2D());
        batches.get(type).addPath(this.cachedPath(f));
      }
      for (const casing of [true, false]) for (const [type, path] of batches) {
        c.lineWidth = (width(type) * Math.min(1.6, Math.max(.65, this.scale * 8)) + (casing ? 1.5 : 0)) / this.scale;
        c.strokeStyle = casing ? '#dce4ee' : type <= 4 ? '#fffdfa' : '#ffffff';
        c.setLineDash(type >= 9 && this.scale > .14 ? [3 / this.scale, 2 / this.scale] : []);
        c.stroke(path);
      }
      c.setLineDash([]);
      for (const f of visible) if (f.type === 'rail') {
        c.strokeStyle = '#99afc34d'; c.lineWidth = 1 / this.scale; c.stroke(this.cachedPath(f));
      }
      c.strokeStyle = '#92b4d5'; c.lineWidth = 1 / this.scale; c.setLineDash([6 / this.scale, 5 / this.scale]);
      c.strokeRect(this.zone.left, this.zone.bottom, this.zone.right - this.zone.left, this.zone.top - this.zone.bottom);
      c.setLineDash([]);
      c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      this.drawLabels(roads);
      for (const leg of this.legs) for (const part of leg.parts) {
        this.path(part.coords); c.setLineDash([]); c.strokeStyle = '#ffffff'; c.lineWidth = part.mode === 'metro' ? 8 : 7; c.stroke();
        c.strokeStyle = part.mode === 'metro' ? part.colour : '#1477fa'; c.lineWidth = part.mode === 'metro' ? 5 : 4; c.stroke();
        c.setLineDash([3, 4]); c.strokeStyle = '#537ea8'; c.lineWidth = 2;
        for (const pair of part.connectors || []) { this.path(pair); c.stroke(); }
      }
      c.setLineDash([]);
      this.stops.forEach((s, i) => {
        const [x, y] = this.toScreen(s.p); if (x < -30 || y < -30 || x > this.width + 30 || y > this.height + 30) return;
        c.beginPath(); c.arc(x, y, 12, 0, Math.PI * 2); c.fillStyle = '#1477fa'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 3; c.stroke();
        c.font = '600 12px -apple-system, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.fillText(String(i + 1), x, y + .5);
      });
      const meterTarget = 70 / this.scale, nice = [25, 50, 100, 200, 500, 1000, 2000].filter(v => v <= meterTarget).at(-1) || 25;
      const scaleEl = document.getElementById('mapScale'); scaleEl.style.width = `${nice * this.scale}px`; scaleEl.textContent = nice >= 1000 ? `${nice / 1000} км` : `${nice} м`;
      const elapsed = performance.now() - start;
      this.frameTimes.push(elapsed); if (this.frameTimes.length > 100) this.frameTimes.shift();
      this.onFrame?.(elapsed);
    }
    drawLabels(roads) {
      const c = this.ctx, occupied = [], names = new Set(), fits = (x, y, width, height = 16) => {
        const box = [x - width / 2 - 3, y - height / 2 - 3, x + width / 2 + 3, y + height / 2 + 3];
        if (x < 30 || x > this.width - 30 || y < 15 || y > this.height - 20 || occupied.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return false;
        occupied.push(box); return true;
      };
      c.font = '11px -apple-system, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (const f of roads.sort((a, b) => a.value[0] - b.value[0])) {
        const name = this.data.streets[f.value[1]], ids = f.value[2];
        if (!name || names.has(name) || f.value[0] >= 9 || occupied.length > 20) continue;
        const p = this.node(ids[Math.floor(ids.length / 2)]), [x, y] = this.toScreen(p), w = c.measureText(name).width;
        if (!fits(x, y, w)) continue;
        names.add(name); c.strokeStyle = '#f4f7fa'; c.lineWidth = 3; c.strokeText(name, x, y); c.fillStyle = '#6a7b90'; c.fillText(name, x, y);
      }
      const stationNames = new Set();
      for (const s of this.data.metro.stations) {
        if (stationNames.has(s.name)) continue;
        const [x, y] = this.toScreen(s.p); if (x < 5 || x > this.width - 5 || y < 5 || y > this.height - 5) continue;
        stationNames.add(s.name); c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = s.colour; c.lineWidth = 2; c.stroke();
        if (this.scale > .06 && fits(x, y - 12, c.measureText(s.name).width)) { c.strokeStyle = '#f4f7fa'; c.lineWidth = 3; c.strokeText(s.name, x, y - 12); c.fillStyle = '#466180'; c.fillText(s.name, x, y - 12); }
      }
      if (this.scale > .20) {
        c.font = '10px -apple-system, sans-serif';
        for (const a of this.data.addresses) {
          const [x, y] = this.toScreen([a[1], a[2]]);
          if (x < 0 || y < 0 || x > this.width || y > this.height) continue;
          const number = a[0].slice(a[0].lastIndexOf(',') + 1).trim();
          if (!fits(x, y, c.measureText(number).width, 10)) continue;
          c.fillStyle = '#718194'; c.fillText(number, x, y);
          if (occupied.length > 75) break;
        }
      }
    }
  }
  global.VectorMap = VectorMap;
})(window);
