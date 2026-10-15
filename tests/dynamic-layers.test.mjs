import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { mapSource, sourceUrl, validateGeoJson, MapCatalogRepository, emptyCatalog } from '../src/data/dynamic-layers.js';
import { fetchBasemapStyle } from '../src/spatial/basemaps.js';
import { createDynamicMapLayers } from '../src/spatial/dynamic-layers.js';

const point = { type: 'Feature', properties: { name: '<script>sample</script>' }, geometry: { type: 'Point', coordinates: [-82.45, 27.94] } };

test('dynamic GeoJSON validates geometry and WGS84 before returning a snapshot and bounds', () => {
  const data = validateGeoJson(point);
  assert.equal(data.data.features[0].properties.name, point.properties.name);
  assert.deepEqual(data.bounds, [-82.45, 27.94, -82.45, 27.94]);
  for (const geometry of [null, { type: 'Point', coordinates: [400, 90] }, { type: 'LineString', coordinates: [[1, 2]] }, { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0]]] }])
    assert.throws(() => validateGeoJson({ ...point, geometry }));
  assert.throws(() => validateGeoJson({ type: 'FeatureCollection', features: [] }));
  assert.throws(() => validateGeoJson({ ...point, crs: { properties: { name: 'EPSG:3857' } } }));
  assert.throws(() => validateGeoJson({ ...point, properties: 'invalid' }));
});

test('custom sources have independent identities and reject unsafe or incomplete URLs', () => {
  const fields = { name: 'User tiles', type: 'raster', url: 'https://example.test/{z}/{x}/{y}.png' };
  assert.notEqual(mapSource(fields).id, mapSource(fields).id);
  assert.throws(() => sourceUrl('javascript:alert(1)'));
  assert.throws(() => sourceUrl('https://user:secret@example.test/a'));
  assert.throws(() => sourceUrl('https://example.test/tiles', true));
  assert.throws(() => mapSource({ ...fields, name: '' }));
  assert.throws(() => mapSource({ ...fields, type: 'unknown' }));
});

test('IndexedDB round trip persists snapshots, visibility, custom basemaps and selected background', async () => {
  const repo = new MapCatalogRepository(indexedDB);
  const catalog = { ...emptyCatalog(), layers: [{ ...mapSource({ name: 'Local points', type: 'file' }), ...validateGeoJson(point), visible: false }],
    basemaps: [mapSource({ name: 'Tiles', type: 'raster', url: 'https://example.test/{z}/{x}/{y}.png' }, true)] };
  catalog.basemapId = catalog.basemaps[0].id;
  await repo.save(catalog); repo.dispose();
  const restarted = new MapCatalogRepository(indexedDB);
  assert.deepEqual(await restarted.read(), catalog);
  await restarted.save({ ...catalog, layers: [], basemaps: [], basemapId: 'default' });
  assert.deepEqual(await restarted.read(), emptyCatalog());
  restarted.dispose();
  await assert.rejects(new MapCatalogRepository(null).save(catalog), /unavailable/);
});

test('basemap style loading resolves relative resources without escaping tile and glyph templates', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ version: 8,
    glyphs: './fonts/{fontstack}/{range}.pbf', sprite: './sprites/default',
    sources: { tiles: { type: 'raster', tiles: ['./tiles/{z}/{x}/{y}.png'] } },
    layers: [{ id: 'tiles', type: 'raster', source: 'tiles' }],
  })));
  const style = await fetchBasemapStyle({ type: 'style', url: 'https://example.test/maps/style.json' });
  assert.equal(style.glyphs, 'https://example.test/maps/fonts/{fontstack}/{range}.pbf');
  assert.equal(style.sources.tiles.tiles[0], 'https://example.test/maps/tiles/{z}/{x}/{y}.png');
  assert.equal(style.sprite, 'https://example.test/maps/sprites/default');
});

test('dynamic rendering reattaches after style resets, detaches hidden tiles and removes deleted sources', () => {
  const sources = new Map(), layers = new Map(); let adds = 0;
  const map = { getLayer: id => layers.get(id), getSource: id => sources.get(id),
    addSource: (id, source) => { adds++; sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    addLayer: layer => layers.set(layer.id, layer), removeLayer: id => layers.delete(id), removeSource: id => sources.delete(id) };
  const renderer = createDynamicMapLayers(map);
  const layer = { ...mapSource({ name: 'Local', type: 'file' }), ...validateGeoJson(point) };
  const raster = mapSource({ name: 'Tiles', type: 'raster', url: 'https://example.test/{z}/{x}/{y}.png' });
  renderer.sync([layer, { ...raster, visible: false }]);
  assert.equal(adds, 1); assert.equal(layers.size, 3);
  sources.clear(); layers.clear(); renderer.sync([layer, raster]);
  assert.equal(layers.size, 4); assert.equal(sources.size, 2);
  renderer.sync([{ ...layer, visible: false }, raster]);
  assert.equal(layers.size, 1); assert.equal(sources.size, 1);
  renderer.sync([]); assert.equal(layers.size, 0); assert.equal(sources.size, 0);
});
