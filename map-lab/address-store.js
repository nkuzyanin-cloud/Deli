/* Lazy local address search. At most four decompressed shards retained in RAM. */
(function (global) {
  'use strict';
  const normal = s => String(s).toLocaleLowerCase('ru').replaceAll('ё', 'е')
    .replace(/(?:^|[\s,])(?:улица|ул\.|переулок|пер\.|проспект|просп\.|дом|д\.)(?=[\s,]|$)/gu, ' ')
    .replace(/корпус|корп\./gu, 'к').replace(/строение|стр\./gu, 'с')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const compact = s => normal(s).replaceAll(' ', '');
  async function readJSON(url, cacheName) {
    const cache = 'caches' in global ? await caches.open(cacheName) : null;
    const response = await cache?.match(new URL(url, location.href)) || await fetch(url);
    if (!response.ok) throw new Error('Не загрузилась часть локальной карты. Загрузите всю папку data/ из ZIP.');
    let raw = await response.arrayBuffer();
    const bytes = raw.byteLength;
    if (new Uint8Array(raw)[0] === 0x1f && new Uint8Array(raw)[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('Нужен Safari / iOS 16.4 или новее.');
      raw = await new Response(new Response(raw).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    return { value: JSON.parse(new TextDecoder().decode(raw)), bytes, unpackedBytes: raw.byteLength };
  }
  class AddressStore {
    constructor(catalog, cacheName) {
      this.catalog = catalog; this.cacheName = cacheName;
      this.streets = catalog.streets.map(([name, files]) => ({ normal: normal(name), compact: compact(name), files }));
      this.cache = new Map(); this.pending = new Map(); this.loaded = new Set();
    }
    async shard(file) {
      if (this.cache.has(file)) { const rows = this.cache.get(file); this.cache.delete(file); this.cache.set(file, rows); return rows; }
      if (this.pending.has(file)) return this.pending.get(file);
      const promise = readJSON('./data/' + file, this.cacheName).then(({ value }) => {
        const rows = value.map(a => ({ label: a[0], p: [a[1], a[2]], osm: a[3], city: a[4], normal: normal(a[0]), compact: compact(a[0]) }));
        this.cache.set(file, rows); this.loaded.add(file);
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
        return rows;
      }).finally(() => this.pending.delete(file));
      this.pending.set(file, promise); return promise;
    }
    async search(query, limit = 10) {
      const tokens = normal(query).split(' ').filter(Boolean), c = compact(query);
      if (!tokens.length) return [];
      // Numeric-only queries would decompress the entire database. Ask for a street.
      const streetTokens = tokens.filter(t => !/^\d/u.test(t) && t !== 'к' && t !== 'с');
      if (!streetTokens.length) return [];
      const files = new Set();
      for (const s of this.streets) if (streetTokens.every(t => s.normal.includes(t)) || s.compact.includes(c))
        s.files.forEach(f => files.add(f));
      let best = [];
      // Sequential shards bound transient memory; no all-district Promise.all.
      for (const file of files) {
        for (const a of await this.shard(file)) {
          if (!tokens.every(t => a.normal.includes(t)) && !a.compact.includes(c)) continue;
          let score = a.compact === c ? 100 : a.compact.startsWith(c) ? 50 : 10;
          const number = tokens.find(t => /^\d/u.test(t));
          if (number && compact(a.label.split(',').at(-1)) === number) score += 20;
          best.push({ a, score });
        }
        best.sort((a, b) => b.score - a.score || a.a.label.localeCompare(b.a.label, 'ru', { numeric: true }));
        best = best.slice(0, limit);
      }
      return best.map(v => v.a);
    }
    async visible(left, bottom, right, top) {
      const cx = (left + right) / 4000, cy = (bottom + top) / 4000;
      const files = this.catalog.shards.map(s => {
        const [x, y] = s.file.split('/').at(-1).split('.')[0].split('_').map(Number);
        return { file: s.file, x, y, d: Math.hypot(x + .5 - cx, y + .5 - cy) };
      }).filter(s => (s.x + 1) * 2000 >= left && s.x * 2000 <= right && (s.y + 1) * 2000 >= bottom && s.y * 2000 <= top)
        .sort((a, b) => a.d - b.d).slice(0, 4);
      const rows = [];
      for (const s of files) rows.push(...await this.shard(s.file));
      return rows.map(a => [a.label, ...a.p]);
    }
  }
  global.LocalAddresses = { AddressStore, normal, compact, readJSON };
})(typeof self !== 'undefined' ? self : globalThis);
