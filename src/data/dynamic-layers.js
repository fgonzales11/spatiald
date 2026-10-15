// User map context is stored separately from canonical utility assets.
export const BUILTIN_BASEMAPS = [
  { id: 'default', name: 'SPATIAL D dark', type: 'style', url: 'https://tiles.openfreemap.org/styles/liberty', quiet: true },
  { id: 'streets', name: 'OpenFreeMap streets', type: 'style', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'light', name: 'OpenFreeMap light', type: 'style', url: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'blank', name: 'Plain background', type: 'blank' },
];
export const MAX_LAYER_BYTES = 20 * 1024 * 1024;
export const emptyCatalog = () => ({ layers: [], basemaps: [], basemapId: 'default' });

export function sourceUrl(value, tiles = false) {
  const text = String(value || '').trim();
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a complete HTTP or HTTPS source URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  if (tiles && !['{z}', '{x}', '{y}'].every(token => text.includes(token)))
    throw new Error('Tile URLs must contain {z}, {x}, and {y}.');
  return text;
}

export function validateGeoJson(value) {
  if (value?.crs && !['urn:ogc:def:crs:OGC:1.3:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'].includes(value.crs.properties?.name))
    throw new Error('GeoJSON must use WGS84 longitude and latitude (EPSG:4326).');
  const features = value?.type === 'FeatureCollection' ? value.features : value?.type === 'Feature' ? [value] : null;
  if (!Array.isArray(features) || !features.length) throw new Error('Provide a GeoJSON Feature or a nonempty FeatureCollection.');
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  function position(p) {
    if (!Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)
      throw new Error('GeoJSON contains invalid WGS84 coordinates.');
    west = Math.min(west, p[0]); east = Math.max(east, p[0]);
    south = Math.min(south, p[1]); north = Math.max(north, p[1]);
  }
  function sequence(c, min, ring = false) {
    if (!Array.isArray(c) || c.length < min) throw new Error('GeoJSON contains incomplete geometry.');
    c.forEach(position);
    if (ring && (c[0].length !== c.at(-1).length || c[0].some((v, i) => v !== c.at(-1)[i])))
      throw new Error('GeoJSON polygon rings must be closed.');
  }
  function polygon(c) {
    if (!Array.isArray(c) || !c.length) throw new Error('GeoJSON contains an empty polygon.');
    c.forEach(ring => sequence(ring, 4, true));
  }
  function multi(c, fn) {
    if (!Array.isArray(c) || !c.length) throw new Error('GeoJSON contains empty geometry.');
    c.forEach(fn);
  }
  function geometry(g, depth = 0) {
    if (!g || depth > 16) throw new Error('GeoJSON contains missing or overly nested geometry.');
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': position(c); break;
      case 'MultiPoint': sequence(c, 1); break;
      case 'LineString': sequence(c, 2); break;
      case 'MultiLineString': multi(c, line => sequence(line, 2)); break;
      case 'Polygon': polygon(c); break;
      case 'MultiPolygon': multi(c, polygon); break;
      case 'GeometryCollection': multi(g.geometries, child => geometry(child, depth + 1)); break;
      default: throw new Error('Unsupported GeoJSON geometry type.');
    }
  }
  for (const feature of features) {
    if (feature?.type !== 'Feature' || (feature.properties !== null && (typeof feature.properties !== 'object' || Array.isArray(feature.properties))))
      throw new Error('GeoJSON features must have an object or null properties field.');
    geometry(feature.geometry);
  }
  return { data: { type: 'FeatureCollection', features }, bounds: [west, south, east, north] };
}

export function mapSource({ name, type, url, attribution, color = '#50c9de' }, basemap = false) {
  name = String(name || '').trim();
  if (!name || name.length > 100) throw new Error('Use a name between 1 and 100 characters.');
  if (!(basemap ? ['style', 'raster'] : ['geojson', 'file', 'raster']).includes(type)) throw new Error('Unsupported map source type.');
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Choose a valid layer color.');
  return {
    id: `custom-${crypto.randomUUID()}`, name, type: type === 'file' ? 'geojson' : type,
    ...(type !== 'file' ? { url: sourceUrl(url, type === 'raster') } : {}),
    attribution: String(attribution || '').trim().slice(0, 500), color, visible: true,
  };
}

export async function loadGeoJsonSource(source, file) {
  if (file?.size > MAX_LAYER_BYTES) throw new Error('GeoJSON files must be 20 MB or smaller.');
  let text;
  if (file) text = await file.text();
  else {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_LAYER_BYTES) throw new Error('GeoJSON sources must be 20 MB or smaller.');
    text = await response.text();
  }
  if (new Blob([text]).size > MAX_LAYER_BYTES) throw new Error('GeoJSON sources must be 20 MB or smaller.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('The source did not contain valid GeoJSON JSON.'); }
  return { ...source, ...validateGeoJson(value), savedAt: new Date().toISOString() };
}

export class MapCatalogRepository {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }
  async open() {
    if (this.db) return this.db;
    if (!this.indexedDB) throw new Error('Browser storage is unavailable. Map sources could not be saved.');
    this.db = await new Promise((resolve, reject) => {
      const req = this.indexedDB.open('tidebound-map-catalog-v1', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('catalog');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Map storage is blocked. Close other tabs and reload.'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }
  async read() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('catalog').objectStore('catalog').get('saved');
      req.onsuccess = () => resolve(req.result || emptyCatalog());
      req.onerror = () => reject(req.error);
    });
  }
  async save(value) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('catalog', 'readwrite');
      tx.objectStore('catalog').put(value, 'saved');
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Map sources could not be saved.'));
    });
  }
  dispose() { this.db?.close(); }
}
