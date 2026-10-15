import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.setWorkerUrl(workerUrl);

export function createAnalysisMap(host, { camera, aoi, assets = [], layers = [], output, selectedAssetId, onSelect, onHazard, onDrawPoint, onStatus } = {}) {
  const map = new maplibregl.Map({ container: host, center: camera?.center || [-82.46, 27.96], zoom: camera?.zoom || 10,
    style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#101e2b' } }] } });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  const blank = { type: 'FeatureCollection', features: [] };
  let disposed = false, ready = false, drawing = false;
  const assetFeatures = { type: 'FeatureCollection', features: assets.map(a => ({ type: 'Feature', id: a.id, geometry: a.geometry, properties: { assetId: a.id, name: a.name, assetType: a.assetType } })) };
  function add(id, data, color, fill = .2) {
    map.addSource(id, { type: 'geojson', data });
    map.addLayer({ id: `${id}-fill`, source: id, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': fill } });
    map.addLayer({ id: `${id}-line`, source: id, type: 'line', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': color, 'line-width': 2 } });
    map.addLayer({ id: `${id}-point`, source: id, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': color, 'circle-radius': 5, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' } });
  }
  function install() {
    if (disposed || ready) return;
    ready = true;
    add('study-aoi', aoi ? { type: 'Feature', geometry: aoi, properties: {} } : blank, '#38c6ed', .04);
    layers.forEach((l, i) => {
      if (l.rasterArtifact) {
        map.addSource(`hazard-${i}`, { type: 'raster', tiles: [`${location.origin}/api/analysis/studies/${encodeURIComponent(l.studyId)}/layers/${encodeURIComponent(l.id)}/tiles/{z}/{x}/{y}.png`], tileSize: 256 });
        map.addLayer({ id: `hazard-${i}-raster`, source: `hazard-${i}`, type: 'raster', paint: { 'raster-opacity': .7 } });
        return;
      }
      const colors = { flood: '#549aef', landslide: '#da9663', debris_flow: '#db7272', liquefaction: '#bb8fe0', fault: '#f4bd64', weather: '#46dca6' };
      add(`hazard-${i}`, { ...l.data, features: l.data.features.filter(f => f.geometry).map(f => ({ ...f, properties: { ...f.properties, hazardLayerId: l.id, hazardFeatureId: String(f.id) } })) }, colors[l.hazardType] || '#a4bac9');
      if (l.metric) {
        const values = l.data.features.map(f=>f.properties?.[l.metric]).filter(v=>typeof v==='number'&&Number.isFinite(v));
        if (values.length) {
          const minimum = Math.min(...values), maximum = Math.max(...values);
          const expression = ['case', ['==',['get',l.metric],null], '#667888', ['interpolate',['linear'],['to-number',['get',l.metric],minimum],minimum,'#bce8ef',maximum===minimum?maximum+1:maximum,'#b75b54']];
          map.setPaintProperty(`hazard-${i}-fill`,'fill-color',expression);
          map.setPaintProperty(`hazard-${i}-fill`,'fill-opacity',.55);
        }
      }
    });
    add('study-assets', assetFeatures, '#c8dce8');
    add('study-output', output || blank, '#f4bd64', .5);
    const selected=output?.features.find(f=>f.properties?.assetId===selectedAssetId||String(f.id)===selectedAssetId) || assetFeatures.features.find(f=>f.properties.assetId===selectedAssetId);
    if(selected){add('study-selection',{type:'FeatureCollection',features:[selected]},'#46dca6',.55);map.setPaintProperty('study-selection-line','line-width',4);map.setPaintProperty('study-selection-point','circle-radius',8);}
    add('study-draw', blank, '#46dca6');
    if (aoi && !camera) {
      const positions = [];
      function walk(c) { if (typeof c[0] === 'number') positions.push(c); else c.forEach(walk); }
      walk(aoi.coordinates);
      if (positions.length) map.fitBounds([[Math.min(...positions.map(p => p[0])), Math.min(...positions.map(p => p[1]))], [Math.max(...positions.map(p => p[0])), Math.max(...positions.map(p => p[1]))]], { padding: 25, duration: 0 });
    }
    const c=map.getCenter();
    onStatus?.(`2D analytical overlays · WGS84 · ${c.lng.toFixed(3)}, ${c.lat.toFixed(3)} · zoom ${map.getZoom().toFixed(1)}`);
  }
  map.on('load', install);
  // Geographic context can fail independently of loaded analytical geometry.
  fetch('https://tiles.openfreemap.org/styles/liberty').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(style => {
    if (disposed || drawing) return;
    ready = false; map.once('style.load', install); map.setStyle(style, { diff: false });
  }).catch(() => onStatus?.('Basemap unavailable; analytical geometry remains visible.'));
  map.on('error', () => onStatus?.('A map resource is unavailable. Analytical results remain available in the table.'));
  map.on('click', event => {
    if (drawing) return onDrawPoint?.([event.lngLat.lng, event.lngLat.lat]);
    const ids = ['study-output-point', 'study-output-line', 'study-output-fill', 'study-assets-point', 'study-assets-line', 'study-assets-fill', ...layers.flatMap((_l, i) => [`hazard-${i}-point`, `hazard-${i}-line`, `hazard-${i}-fill`])].filter(id => map.getLayer(id));
    const f = map.queryRenderedFeatures(event.point, { layers: ids })[0];
    if (f?.properties?.assetId) onSelect?.(f.properties.assetId);
    else if (f?.properties?.hazardLayerId) onHazard?.(f.properties.hazardLayerId, f.properties.hazardFeatureId);
    else if (f?.id !== undefined) onSelect?.(String(f.id));
  });
  return {
    capture: () => ({ center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }),
    draw(enabled) { drawing = enabled; map.getCanvas().style.cursor = enabled ? 'crosshair' : ''; },
    points(points) { const g = points.length >= 3 ? { type: 'Polygon', coordinates: [[...points, points[0]]] } : points.length >= 2 ? { type: 'LineString', coordinates: points } : points.length ? { type: 'Point', coordinates: points[0] } : null;
      map.getSource('study-draw')?.setData(g ? { type: 'Feature', geometry: g, properties: {} } : blank); },
    focus(geometry) { const coordinates = [];
      function walk(value) { if (typeof value[0] === 'number') coordinates.push(value); else value.forEach(walk); }
      walk(geometry.coordinates);
      if (coordinates.length) map.fitBounds([[Math.min(...coordinates.map(p => p[0])), Math.min(...coordinates.map(p => p[1]))], [Math.max(...coordinates.map(p => p[0])), Math.max(...coordinates.map(p => p[1]))]], { padding: 80, maxZoom: 17 }); },
    dispose() { disposed = true; map.remove(); },
  };
}
