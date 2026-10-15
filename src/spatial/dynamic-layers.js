import { esc } from '../components/ui.js';

export function createDynamicMapLayers(map) {
  const attached = new Map();
  const sourceId = id => `dynamic-${id}`;
  const ids = layer => layer.type === 'raster' ? [sourceId(layer.id)] : ['fill', 'line', 'point'].map(kind => `${sourceId(layer.id)}-${kind}`);
  function remove(layer) {
    for (const id of ids(layer)) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(sourceId(layer.id))) map.removeSource(sourceId(layer.id));
    attached.delete(layer.id);
  }
  return {
    sourceLayerId: source => [...attached.keys()].find(id => sourceId(id) === source),
    sync(layers) {
      for (const layer of attached.values()) if (!layers.some(next => next.id === layer.id)) remove(layer);
      for (const layer of layers) {
        const source = sourceId(layer.id);
        const previous = attached.get(layer.id);
        // Hidden sources are detached so tile providers receive no requests.
        if (!layer.visible) { if (previous) remove(previous); continue; }
        if (!map.getSource(source)) map.addSource(source, layer.type === 'raster'
          ? { type: 'raster', tiles: [layer.url], tileSize: 256, attribution: esc(layer.attribution) }
          : { type: 'geojson', data: layer.data, attribution: esc(layer.attribution) });
        else if (layer.type === 'geojson' && previous?.data !== layer.data) map.getSource(source).setData(layer.data);
        const before = map.getLayer('tb-area') ? 'tb-area' : undefined;
        if (layer.type === 'raster') {
          if (!map.getLayer(source)) map.addLayer({ id: source, source, type: 'raster', paint: { 'raster-opacity': 0.7 } }, before);
        } else {
          const definitions = [
            { type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': layer.color, 'fill-opacity': 0.28 } },
            { type: 'line', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': layer.color, 'line-width': 2 } },
            { type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': layer.color, 'circle-radius': 5, 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } },
          ];
          definitions.forEach((definition, i) => {
            if (!map.getLayer(ids(layer)[i])) map.addLayer({ id: ids(layer)[i], source, ...definition }, before);
          });
        }
        attached.set(layer.id, layer);
      }
    },
    dispose() { attached.clear(); },
  };
}
