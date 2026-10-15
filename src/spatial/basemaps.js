import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { esc } from '../components/ui.js';

export const localStyle = () => ({
  version: 8, sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#102332' } }],
});

export async function fetchBasemapStyle(basemap, signal = AbortSignal.timeout(15000)) {
  if (basemap.type === 'blank') return localStyle();
  if (basemap.type === 'raster') return {
    ...localStyle(), sources: { 'basemap-raster': { type: 'raster', tiles: [basemap.url], tileSize: 256, attribution: esc(basemap.attribution) } },
    layers: [...localStyle().layers, { id: 'basemap-raster', type: 'raster', source: 'basemap-raster' }],
  };
  const response = await fetch(basemap.url, { signal });
  if (!response.ok) throw new Error(`Basemap returned HTTP ${response.status}.`);
  const style = await response.json();
  const errors = validateStyleMin(style);
  if (errors.length) throw new Error(`Invalid MapLibre style: ${errors[0].message}`);
  if ([...Object.keys(style.sources), ...style.layers.map(layer => layer.id)].some(id => /^(tb-|osm-|dynamic-|deck-maplibre-)/.test(id)))
    throw new Error('Basemap uses a reserved overlay ID. Rename IDs starting with tb-, osm-, dynamic-, or deck-maplibre-.');
  // Style JSON is fetched directly; resolve resources against its URL before handing it to MapLibre.
  const base = response.url || basemap.url;
  const resolve = value => /^https?:|^data:/i.test(value) ? value : new URL(value, base).href.replaceAll('%7B', '{').replaceAll('%7D', '}');
  if (style.glyphs) style.glyphs = resolve(style.glyphs);
  if (typeof style.sprite === 'string') style.sprite = resolve(style.sprite);
  else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map(s => ({ ...s, url: resolve(s.url) }));
  for (const source of Object.values(style.sources)) {
    if (source.url) source.url = resolve(source.url);
    if (source.tiles) source.tiles = source.tiles.map(resolve);
    if (source.type === 'geojson' && typeof source.data === 'string') source.data = resolve(source.data);
    if (source.type === 'image' && source.url) source.url = resolve(source.url);
  }
  if (basemap.quiet) quietStyle(style);
  // Keep place/POI symbology off in every vector basemap, including after a
  // basemap switch. Utility overlays are added separately by the map view.
  for (const layer of style.layers) {
    if (layer.type === 'symbol' && (
      /^(poi|place|poi_label|place_label|aerodrome_label)$/.test(layer['source-layer'] || '') ||
      /(^|[-_])(poi|place|settlement|airport)([-_]|$)/i.test(layer.id)
    )) layer.layout = { ...layer.layout, visibility: 'none' };
  }
  return style;
}

function quietStyle(style) {
  // Omit bright highway bridge/tunnel overlays and repeated wetland reeds.
  style.layers = style.layers.filter(
    (layer) =>
      !/wetland|marsh|swamp/i.test(layer.id) &&
      !(
        layer.type === "line" &&
        layer["source-layer"] === "transportation" &&
        /^(bridge|tunnel)_(motorway|link|trunk_primary|secondary_tertiary)(_|$)/.test(layer.id)
      ),
  );
  // Keep the geographic context quiet so utility overlays remain legible.
  for (const layer of style.layers) {
    if (layer.type === "symbol" && layer["source-layer"] === "poi")
      layer.filter = [
        "all",
        ...(layer.filter ? [layer.filter] : []),
        ["match", ["get", "class"], ["bus", "rail", "ferry", "public_transport"], false, true],
        ["match", ["get", "subclass"], ["bus_stop", "bus_station", "tram_stop", "subway_entrance", "ferry_terminal", "platform"], false, true],
      ];
    if (layer.type === "background")
      layer.paint = { ...layer.paint, "background-color": "#112b36" };
    if (layer.type === "fill" && /water/i.test(layer.id))
      layer.paint = { ...layer.paint, "fill-color": "#0b2238" };
    else if (
      layer.type === "fill" &&
      /land|park|building|residential|industrial/i.test(layer.id)
    )
      layer.paint = { ...layer.paint, "fill-color": "#1b3640" };
    if (
      layer.type === "line" &&
      /road|transport|highway|street/i.test(layer.id)
    )
      layer.paint = { ...layer.paint, "line-color": "#3d5057" };
    if (layer.type === "symbol")
      layer.paint = {
        ...layer.paint,
        "text-color": "#abc0c5",
        "text-halo-color": "#16313b",
        "text-halo-width": 1,
      };
  }
  return style;
}
