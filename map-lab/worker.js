/* Everything runs locally; messages contain only this experiment's selected points. */
'use strict';
importScripts('./router.js');
let router;
self.onmessage = function ({ data }) {
  try {
    if (data.type === 'init') {
      const started = performance.now();
      router = new LocalRouter.Router(data.graph);
      self.postMessage({ type: 'ready', milliseconds: performance.now() - started,
        nodes: data.graph.nodes.length, edges: data.graph.edges.length, stations: router.stations.length,
        graphTypedBytes: router.typedBytes });
      return;
    }
    if (data.type === 'route') {
      if (!router) throw new Error('Граф ещё загружается.');
      if (!Array.isArray(data.stops) || data.stops.length < 2 || data.stops.length > 12) throw new Error('Для теста нужно от 2 до 12 остановок.');
      const started = performance.now(), result = router.route(data.stops, data.options);
      self.postMessage({ type: 'route', id: data.id, result, milliseconds: performance.now() - started });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: String(error.message || error) });
  }
};
