/* Independent test. Never reads/writes courier_routes_v3; no customer data leaves the device. */
(() => {
  'use strict';
  const KEY = 'courier_map_lab_v1', CACHE = 'courier-map-lab-v1', $ = id => document.getElementById(id);
  const state = { stops: [], mode: 'walk' }, stats = { version: 1, startedAt: new Date().toISOString(), frames: [] };
  let pack, map, worker, ready = false, generation = 0, busy = false, timer, importedBackup, editing = -1;
  function normal(s) { return String(s).toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/(?:^|[\s,])(?:улица|ул\.|переулок|пер\.|проспект|просп\.|дом|д\.)(?=[\s,]|$)/gu, ' ').replace(/корпус|корп\./gu, 'к').replace(/строение|стр\./gu, 'с').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
  const compact = s => normal(s).replaceAll(' ', '');
  const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
  function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.setAttribute('aria-hidden', 'true'); svg.append(use); return svg; }
  function minutes(seconds) { const m = Math.ceil(seconds / 60), h = Math.floor(m / 60); return h ? `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}` : `${m} мин`; }
  const km = meters => meters < 1000 ? `${Math.round(meters)} м` : `${(meters / 1000).toLocaleString('ru', { maximumFractionDigits: 1 })} км`;
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { $('searchHint').textContent = 'Не удалось сохранить тестовые точки. Рабочее приложение не затронуто.'; } }
  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (['walk', 'metro'].includes(s.mode)) state.mode = s.mode;
      if (Array.isArray(s.stops)) state.stops = s.stops.slice(0, 12).filter(v => typeof v.label === 'string' && v.label.length <= 200 && Array.isArray(v.p) && v.p.length === 2 && v.p.every(Number.isFinite) && inZone(v.p)).map(v => ({ label: v.label, p: v.p, source: ['address', 'example'].includes(v.source) ? v.source : 'point' }));
    } catch (_) { /* Invalid test state is ignored, never repairs the courier DB. */ }
  }
  function inZone(p) { const lon = pack.origin[0] + p[0] / pack.scale[0], lat = pack.origin[1] + p[1] / pack.scale[1]; return lon >= pack.bbox[0] && lon <= pack.bbox[2] && lat >= pack.bbox[1] && lat <= pack.bbox[3]; }
  function clearRoute() {
    generation++; clearTimeout(timer); busy = false; $('routeError').hidden = true; $('legsCard').hidden = true;
    $('eta').textContent = state.stops.length < 2 ? 'Добавьте две остановки' : 'Маршрут ещё не рассчитан';
    $('etaDetail').textContent = 'По реальным улицам и проходам, не по прямой'; map?.setRoute(state.stops); refreshControls();
  }
  function refreshControls() {
    $('calculate').disabled = !ready || busy || state.stops.length < 2;
    $('calculate').querySelector('span').textContent = busy ? 'Рассчитываем на телефоне…' : 'Построить маршрут';
    $('placePoint').disabled = !ready || state.stops.length >= 12;
    $('publicExample').disabled = !ready;
    $('exportMetrics').disabled = !ready;
    $('stopsCount').textContent = `${state.stops.length} из 12`;
    $('emptyState').hidden = state.stops.length > 0;
    $('walkMode').setAttribute('aria-pressed', String(state.mode === 'walk'));
    $('metroMode').setAttribute('aria-pressed', String(state.mode === 'metro'));
    $('modeNotice').hidden = state.mode !== 'metro'; $('metroParameters').hidden = state.mode !== 'metro';
  }
  function renderStops() {
    const list = $('stopsList'); list.replaceChildren();
    state.stops.forEach((s, i) => {
      const row = text('li', '', 'stop-row'); row.append(text('span', i + 1, 'stop-number'));
      const copy = text('button', s.label, 'stop-copy'); copy.type = 'button'; copy.append(text('small', s.source === 'address' ? 'Адрес из локальной базы' : s.source === 'example' ? 'Публичная тестовая точка' : 'Точка, выбранная вручную'));
      copy.addEventListener('click', () => { editing = i; $('pointLabel').value = s.label; $('pointDialog').showModal(); }); row.append(copy);
      const actions = text('div', '', 'stop-buttons');
      for (const [kind, label] of [['up', 'Выше'], ['down', 'Ниже'], ['delete', 'Удалить']]) {
        const b = text('button', ''); b.type = 'button'; b.className = kind; b.setAttribute('aria-label', `${label}: ${s.label}`); b.append(icon(kind === 'delete' ? 'close' : 'arrow'));
        b.disabled = kind === 'up' && i === 0 || kind === 'down' && i === state.stops.length - 1;
        b.addEventListener('click', () => { if (kind === 'delete') state.stops.splice(i, 1); else { const target = i + (kind === 'up' ? -1 : 1); [state.stops[i], state.stops[target]] = [state.stops[target], state.stops[i]]; } save(); clearRoute(); renderStops(); }); actions.append(b);
      }
      row.append(actions); list.append(row);
    });
    refreshControls(); map?.setRoute(state.stops);
  }
  function addStop(s) {
    if (state.stops.length >= 12) { showError('В этом тесте максимум 12 остановок.'); return; }
    if (!inZone(s.p)) { showError('Эта точка вне скачанной тестовой зоны.'); return; }
    state.stops.push(s); save(); clearRoute(); renderStops();
  }
  function search(query, limit = 10) {
    const tokens = normal(query).split(' ').filter(Boolean), c = compact(query), rows = [];
    if (!tokens.length) return [];
    for (let i = 0; i < pack.addresses.length; i++) {
      const a = pack.addresses[i], n = a.normal, match = tokens.every(t => n.includes(t));
      if (!match && !a.compact.includes(c)) continue;
      let score = a.compact === c ? 100 : a.compact.startsWith(c) ? 50 : 10;
      const number = tokens.find(t => /^\d/u.test(t));
      if (number && compact(a.label.split(',').at(-1)) === number) score += 20;
      rows.push({ a, score });
    }
    return rows.sort((a, b) => b.score - a.score || a.a.label.localeCompare(b.a.label, 'ru', { numeric: true })).slice(0, limit).map(v => v.a);
  }
  function displayResults() {
    if (!ready) return;
    const query = $('addressSearch').value.trim(), results = $('searchResults'); results.replaceChildren();
    results.hidden = !query; $('addressSearch').setAttribute('aria-expanded', String(Boolean(query)));
    if (!query) return;
    const rows = search(query);
    if (!rows.length) { results.append(text('p', 'Адрес не найден в тестовой зоне. Проверьте написание или поставьте точку на карте. Полная Москва и область пока не включены.', 'no-results')); return; }
    rows.forEach(a => { const b = text('button', ''); b.type = 'button'; b.append(icon('pin'), text('span', a.label)); b.addEventListener('click', () => { addStop({ label: a.label, p: a.p, source: 'address' }); $('addressSearch').value = ''; results.hidden = true; $('addressSearch').setAttribute('aria-expanded', 'false'); $('addressSearch').blur(); map.fitRoute(); }); results.append(b); });
  }
  function showError(message) { $('routeError').textContent = message; $('routeError').hidden = false; }
  function options() {
    const read = (id, min, max) => { const v = Number($(id).value); if (!Number.isFinite(v) || $(id).value === '' || v < min || v > max) throw new Error(`Проверьте значение поля «${$(id).parentElement.firstChild.textContent.trim()}».`); return v; };
    return { mode: state.mode, walkSpeed: read('walkSpeed', 2, 7),
      metroSpeed: state.mode === 'metro' ? read('metroSpeed', 15, 70) : 35,
      dwell: state.mode === 'metro' ? read('metroDwell', 0, 120) : 30,
      accessMinutes: state.mode === 'metro' ? read('accessMinutes', 0, 15) : 3 };
  }
  function calculate() {
    if (!ready || busy || state.stops.length < 2) return;
    let params; try { params = options(); } catch (error) { showError(error.message); return; }
    const id = ++generation; clearTimeout(timer); $('routeError').hidden = true; busy = true; refreshControls();
    $('eta').textContent = 'Рассчитываем на телефоне…';
    stats.parameters = params;
    worker.postMessage({ type: 'route', id, stops: state.stops.map(s => ({ p: s.p })), options: params });
    timer = setTimeout(() => { if (generation !== id) return; generation++; busy = false; refreshControls(); $('eta').textContent = 'Расчёт не завершён'; showError('Расчёт превысил 45 секунд. Сократите число точек. Для повторного теста перезагрузите страницу: это остановит занятого исполнителя.'); }, 45000);
  }
  function paintResult(result, milliseconds) {
    map.setRoute(state.stops, result.legs); map.fitRoute();
    $('eta').textContent = `≈ ${minutes(result.seconds)} на маршрут`;
    const rail = result.legs.some(l => l.mode === 'metro');
    $('etaDetail').textContent = `${km(result.meters)} · ${rail ? 'пешком и метро по модели' : 'пешком'} · ${state.stops.length} остановки`;
    $('estimateCaption').textContent = rail ? 'Модельная оценка · без расписания, ожидания, текущих пробок и вручения' : 'Приблизительное время · без учёта текущих пробок, вручения и перерывов';
    $('routeMetric').textContent = `${Math.round(milliseconds)} мс`;
    stats.lastRoute = { milliseconds: Math.round(milliseconds), stopCount: state.stops.length,
      meters: Math.round(result.meters), seconds: Math.round(result.seconds), modes: result.legs.map(l => l.mode),
      snapOffsetsMeters: result.legs.map(l => l.snapOffsets?.map(Math.round)) };
    const list = $('legsList'); list.replaceChildren();
    result.legs.forEach(l => {
      const row = text('div', '', 'leg-row'), title = text('div', '', 'leg-title');
      title.append(text('span', `${l.from + 1} → ${l.to + 1} · ${state.stops[l.to].label}`), text('strong', `≈ ${minutes(l.seconds)}`)); row.append(title);
      row.append(text('p', l.mode === 'metro' ? `Пешком → ${l.boarding} → линия ${l.line} → ${l.alighting} → пешком. ${l.stations} перегонов. Без пересадок и ожидания.` : `${km(l.meters)} пешком${l.names.length ? ` · ${l.names.slice(0, 5).join(' → ')}` : ''}`));
      if (l.snapOffsets?.some(v => v > 20)) row.append(text('p', `Подход к улице приблизительный: ${l.snapOffsets.map(v => `${Math.round(v)} м`).join(' / ')}. Вход уточняйте на месте.`));
      list.append(row);
    }); $('legsCard').hidden = false;
  }
  async function offlineInstall() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      const service = reg.installing || reg.waiting || reg.active;
      if (service?.state !== 'activated') await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Истёк срок установки офлайн-пакета.')), 70000);
        const check = () => { if (service.state === 'activated') { clearTimeout(t); service.removeEventListener('statechange', check); resolve(); } else if (service.state === 'redundant') { clearTimeout(t); service.removeEventListener('statechange', check); reject(new Error('Не удалось сохранить офлайн-пакет.')); } };
        service.addEventListener('statechange', check); check();
      });
      const cache = await caches.open(CACHE);
      return Boolean(await cache.match(new URL('./data/moscow-test.json', location.href)));
    } catch (error) { stats.offlineError = error.message; return false; }
  }
  async function init() {
    try {
      const started = performance.now(), offline = await offlineInstall();
      const cache = 'caches' in window ? await caches.open(CACHE) : null;
      const response = await cache?.match(new URL('./data/moscow-test.json', location.href)) || await fetch('./data/moscow-test.json');
      if (!response.ok) throw new Error('Файл данных не загрузился. Проверьте, что папка data/ загружена вместе с тестом.');
      const raw = await response.arrayBuffer(); stats.packBytes = raw.byteLength;
      pack = JSON.parse(new TextDecoder().decode(raw)); stats.loadMilliseconds = Math.round(performance.now() - started);
      if (pack.version !== 1 || !Array.isArray(pack.nodes) || !Array.isArray(pack.edges) || !Array.isArray(pack.addresses)) throw new Error('Неподдерживаемый пакет карты.');
      worker = new Worker('./worker.js');
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          ready = true; stats.graphInitMilliseconds = Math.round(data.milliseconds);
          stats.graphTypedBytes = data.graphTypedBytes;
          stats.graphMemoryNote = 'Числовые буферы графа и рабочего поиска; не полная память приложения.';
          $('initMetric').textContent = `${Math.round(data.milliseconds)} мс`;
          $('mapLoading').hidden = true; $('addressSearch').disabled = false;
          $('offlineStatus').textContent = offline ? 'Готово офлайн' : 'Карта загружена'; $('offlineStatus').dataset.state = offline ? 'ready' : '';
          if (!offline) $('searchHint').textContent = 'Карта работает, но сохранение офлайн-пакета не подтверждено. Не закрывайте страницу без сети.';
          refreshControls();
        } else if (data.id === generation) {
          clearTimeout(timer); busy = false; refreshControls();
          if (data.type === 'error') { $('eta').textContent = 'Маршрут не найден'; showError(data.message); }
          else if (data.type === 'route') paintResult(data.result, data.milliseconds);
        }
      };
      worker.onerror = () => { busy = false; ready = false; refreshControls(); showError('Локальный расчёт остановился. Попробуйте перезагрузить тест.'); };
      worker.postMessage({ type: 'init', graph: { nodes: pack.nodes, edges: pack.edges, streets: pack.streets, metro: pack.metro } });
      stats.addressCount = pack.addresses.length; stats.nodeCount = pack.nodes.length; stats.edgeCount = pack.edges.length;
      // Main thread never routes; remove its edge list after the structured clone.
      delete pack.edges;
      // Keep renderer coordinates packed, not hundreds of thousands of JS arrays.
      const coords = new Float32Array(pack.nodes.length * 2);
      pack.nodes.forEach((p, i) => { coords[2 * i] = p[0]; coords[2 * i + 1] = p[1]; });
      pack.nodes = coords;
      pack.addresses = pack.addresses.map(a => ({ label: a[0], p: [a[1], a[2]], osm: a[3], city: a[4], normal: normal(a[0]), compact: compact(a[0]) }));
      restore();
      // Renderer consumes compact address rows, not search metadata.
      map = new VectorMap($('mapCanvas'), { ...pack, addresses: pack.addresses.map(a => [a.label, ...a.p]) }, p => {
        if (!inZone(p)) { showError('Точка вне тестовой зоны.'); return; }
        addStop({ label: `Точка ${state.stops.length + 1} на карте`, p: p.map(v => Math.round(v * 10) / 10), source: 'point' });
        map.picking = false; $('placement').hidden = true; $('placePoint').textContent = 'Точка на карте';
      }, ms => { stats.frames.push(Math.round(ms * 10) / 10); if (stats.frames.length > 100) stats.frames.shift(); $('frameMetric').textContent = `${Math.round(ms)} мс`; });
      renderStops(); if (state.stops.length) map.fitRoute();
      $('packMetric').textContent = `${(stats.packBytes / 1048576).toLocaleString('ru', { maximumFractionDigits: 1 })} МБ`;
      $('addressMetric').textContent = stats.addressCount.toLocaleString('ru'); $('graphMetric').textContent = stats.edgeCount.toLocaleString('ru');
      if (!offline) $('offlineStatus').title = stats.offlineError || 'Офлайн-кэш не подтверждён';
    } catch (error) {
      $('loadTitle').textContent = 'Карта не загрузилась'; $('loadDetail').textContent = error.message;
      document.querySelector('.spinner').hidden = true; $('offlineStatus').textContent = 'Ошибка загрузки'; $('offlineStatus').dataset.state = 'error';
      showError(error.message);
    }
  }
  $('addressSearch').addEventListener('input', displayResults);
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); displayResults(); });
  $('calculate').addEventListener('click', calculate);
  $('walkMode').addEventListener('click', () => { state.mode = 'walk'; save(); clearRoute(); });
  $('metroMode').addEventListener('click', () => { state.mode = 'metro'; save(); clearRoute(); });
  for (const id of ['walkSpeed', 'metroSpeed', 'metroDwell', 'accessMinutes']) $(id).addEventListener('input', clearRoute);
  $('fitMap').addEventListener('click', () => map?.fitRoute()); $('zoomIn').addEventListener('click', () => map?.zoom(1.6)); $('zoomOut').addEventListener('click', () => map?.zoom(1 / 1.6));
  $('placePoint').addEventListener('click', () => { map.picking = !map.picking; $('placement').hidden = !map.picking; $('placePoint').textContent = map.picking ? 'Отменить выбор' : 'Точка на карте'; if (map.picking) $('mapWrap').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
  $('publicExample').addEventListener('click', () => {
    // Explicit user-invoked test addresses, never demo data in the courier app.
    const points = state.mode === 'metro'
      ? ['ВДНХ', 'Сухаревская'].map(name => { const s = pack.metro.stations.find(v => v.name === name && v.line === '6'); return s && { label: `Метро ${name}`, p: s.p, source: 'example' }; })
      : ['Тверская улица, 10', 'улица Петровка, 18', 'Тверская улица, 17'].map(label => { const a = pack.addresses.find(a => a.compact === compact(label)); return a && { label: a.label, p: a.p, source: 'address' }; });
    if (points.some(v => !v)) { showError('Пример не найден в этой версии данных. Выберите два адреса вручную.'); return; }
    if (state.stops.length && !confirm('Заменить только тестовые точки примером? Рабочие маршруты не меняются.')) return;
    state.stops = points; save(); clearRoute(); renderStops(); map.fitRoute(); calculate();
  });
  $('pointDialog').addEventListener('close', () => { if ($('pointDialog').returnValue !== 'save' || editing < 0 || !state.stops[editing]) return; const label = $('pointLabel').value.trim(); if (label) { state.stops[editing].label = label; save(); clearRoute(); renderStops(); } });
  $('exportMetrics').addEventListener('click', () => {
    // No address/client/order/phone/coordinates are included in the diagnostic file.
    const report = { ...stats, viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio,
      browser: navigator.userAgent, onlineAtExport: navigator.onLine,
      jsHeapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
      heapNote: 'Chromium-only estimate, excludes worker and GPU; not a peak memory measurement.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'map-lab-test.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  $('backupFile').addEventListener('change', async () => {
    importedBackup = null; $('backupDays').hidden = true; $('importReport').textContent = '';
    const file = $('backupFile').files[0]; if (!file) return;
    if (file.size > 20 * 1048576) { $('importReport').textContent = 'Для теста поддерживаются резервные копии до 20 МБ.'; return; }
    try {
      const db = JSON.parse(await file.text()); if (db.version !== 3 || !db.days || typeof db.days !== 'object' || Array.isArray(db.days)) throw new Error('Нужна резервная копия курьерского приложения version: 3.');
      const days = Object.entries(db.days).filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray(day?.deliveries)).sort((a, b) => b[0].localeCompare(a[0]));
      if (!days.length) throw new Error('В файле не найдены дни с записями.');
      // Retain only addresses, no unrelated private fields from the backup.
      importedBackup = Object.fromEntries(days.map(([date, day]) => [date, day.deliveries.filter(d => d && typeof d.address === 'string').map(d => d.address.trim()).filter(Boolean)]));
      $('backupDate').replaceChildren(...days.map(([date]) => { const o = text('option', date); o.value = date; return o; })); $('backupDays').hidden = false;
    } catch (error) { $('importReport').textContent = error.message; }
  });
  $('importDay').addEventListener('click', () => {
    if (!ready || !importedBackup) return;
    const labels = importedBackup[$('backupDate').value] || [], accepted = [], rejected = [];
    for (const label of labels) { const query = label.replace(/^Москва[,\s]+/iu, ''), rows = search(query, 2), exact = rows.filter(a => a.compact === compact(query)); if (exact.length === 1) accepted.push({ label: exact[0].label, p: exact[0].p, source: 'address' }); else rejected.push(label); }
    const available = 12 - state.stops.length;
    for (const s of accepted.slice(0, available)) state.stops.push(s);
    save(); clearRoute(); renderStops(); map.fitRoute();
    $('importReport').textContent = `Добавлено: ${Math.min(available, accepted.length)}.${accepted.length > available ? ' Остальные не поместились: предел 12 точек.' : ''}${rejected.length ? ` Не найдены однозначно в зоне: ${rejected.join('; ')}. Их можно выбрать в поиске или на карте.` : ''} Домашние этапы из настроек автоматически не добавляются.`;
  });
  window.addEventListener('offline', () => { $('offlineStatus').textContent = 'Без интернета · локальный расчёт'; });
  init();
})();
