import { test, expect } from '@playwright/test';
import { publicMap, ready } from './helpers/public-map.js';

const geojson = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Custom point' }, geometry: { type: 'Point', coordinates: [-82.45, 27.94] } },
  { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-82.46, 27.94], [-82.45, 27.95]] } },
  { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-82.46, 27.94], [-82.46, 27.95], [-82.45, 27.95], [-82.46, 27.94]]] } },
] };
async function openLayers(page) {
  const button = page.getByRole('button', { name: 'Map layers and basemaps', exact: true });
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}
async function boot(page) { await publicMap(page); await page.goto('/'); await ready(page); }
async function add(page, { name, type = 'file', url, basemap = false, data = geojson }) {
  await openLayers(page);
  await page.getByRole('button', { name: basemap ? 'Add basemap' : 'Add layer', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Source type', { exact: true }).selectOption(type);
  if (type === 'file') await page.getByLabel('GeoJSON file', { exact: true }).setInputFiles({ name: 'test.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  else await page.getByLabel('Source URL', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Add and save', exact: true }).click();
}
async function rendered(page, id) {
  await page.waitForFunction(id => Boolean(window.__testMap.getLayer(`dynamic-${id}-point`)), id);
}

test('square dock opens one menu; uploaded layers render, survive style changes and reload, toggle and remove', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page);
  await expect(page.locator('#map-layers')).toBeHidden();
  const button = await page.locator('#map-layer-button').boundingBox();
  const host = await page.locator('#map-host').boundingBox();
  expect(button.width).toBe(button.height);
  expect(host.x + host.width - button.x - button.width).toBe(15);
  await openLayers(page);
  await expect(page.getByLabel('Map background')).toBeVisible();
  await add(page, { name: 'My boundaries' });
  await expect(page.locator('#map-source-dialog')).not.toBeVisible();
  const row = page.locator('[data-saved-layer]').filter({ hasText: 'My boundaries' });
  const id = await row.getAttribute('data-saved-layer');
  await rendered(page, id);
  await row.getByRole('button', { name: 'View', exact: true }).click();
  await page.waitForFunction(() => window.__testMap.loaded() && !window.__testMap.isMoving());
  await expect.poll(() => page.evaluate(id => window.__testMap.queryRenderedFeatures({ layers: ['fill', 'line', 'point'].map(kind => `dynamic-${id}-${kind}`) }).length, id)).toBeGreaterThan(0);
  const camera = await page.evaluate(() => ({ center: window.__testMap.getCenter().toArray(), zoom: window.__testMap.getZoom() }));
  await page.getByLabel('Map background').selectOption('light');
  await expect.poll(() => page.evaluate(() => window.__testMap.getLayer('tb-substations')?.id)).toBe('tb-substations');
  await rendered(page, id);
  await expect.poll(() => page.evaluate(() => ({ center: window.__testMap.getCenter().toArray(), zoom: window.__testMap.getZoom() }))).toEqual(camera);
  await page.reload(); await ready(page); await openLayers(page); await rendered(page, id);
  await expect(row).toContainText('3 features');
  await row.getByRole('checkbox').uncheck();
  await expect(row.getByRole('checkbox')).toBeFocused();
  await expect.poll(() => page.evaluate(id => Boolean(window.__testMap.getSource(`dynamic-${id}`)), id)).toBe(false);
  await page.reload(); await ready(page); await openLayers(page);
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await row.getByRole('checkbox').check(); await rendered(page, id);
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => page.evaluate(id => Boolean(window.__testMap.getSource(`dynamic-${id}`)), id)).toBe(false);
  await page.reload(); await ready(page); await openLayers(page); await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('GeoJSON URL snapshots survive provider failure; failed refresh and validation keep saved sources', async ({ page }) => {
  await boot(page); let failed = false;
  await page.route('https://example.test/overlay.geojson', route => route.fulfill({ status: failed ? 503 : 200, json: geojson }));
  await add(page, { name: 'Remote boundaries', type: 'geojson', url: 'https://example.test/overlay.geojson' });
  const row = page.locator('[data-saved-layer]').filter({ hasText: 'Remote boundaries' });
  const id = await row.getAttribute('data-saved-layer');
  await rendered(page, id); failed = true;
  await page.reload(); await ready(page); await openLayers(page); await rendered(page, id);
  await row.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('503'); await rendered(page, id);
  await add(page, { name: 'Bad geometry', data: { ...geojson, features: [{ ...geojson.features[0], geometry: { type: 'Point', coordinates: [500, 100] } }] } });
  await expect(page.locator('#map-source-form-error')).toContainText('invalid WGS84');
  await expect(page.locator('[data-saved-layer]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await add(page, { name: 'Bad tiles', type: 'raster', url: 'https://example.test/tiles' });
  await expect(page.locator('#map-source-form-error')).toContainText('{z}');
});

test('custom style and raster basemaps persist, resolve resources, recover from failure and remove', async ({ page }) => {
  await boot(page);
  const style = { version: 8, sources: {}, layers: [{ id: 'user-background', type: 'background', paint: { 'background-color': '#eeeeee' } }] };
  await page.route('https://example.test/style.json', route => route.fulfill({ json: style }));
  await add(page, { name: 'My style', type: 'style', url: 'https://example.test/style.json', basemap: true });
  await page.waitForFunction(() => window.__testMap.getLayer('user-background'));
  await page.reload(); await ready(page); await openLayers(page);
  await expect(page.getByLabel('Map background').locator('option:checked')).toHaveText('My style');
  await page.getByRole('button', { name: 'Remove selected basemap' }).click();
  await expect(page.getByLabel('Map background')).toHaveValue('default');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await page.route('https://example.test/tiles/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await add(page, { name: 'My imagery', type: 'raster', url: 'https://example.test/tiles/{z}/{x}/{y}.png', basemap: true });
  await page.waitForFunction(() => window.__testMap.getLayer('basemap-raster'));
  await page.getByLabel('Map background').selectOption('blank');
  await expect.poll(() => page.evaluate(() => Boolean(window.__testMap.getSource('basemap-raster')))).toBe(false);
  await page.route('https://tiles.openfreemap.org/styles/positron', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.getByLabel('Map background').selectOption('light');
  await expect(page.locator('#map-layers')).toContainText('Basemap returned HTTP 503');
  await page.waitForFunction(() => window.__testMap.getLayer('tb-substations'));
  await page.unroute('https://tiles.openfreemap.org/styles/positron');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#map-layers .map-source-error')).toHaveCount(0);
});

test('raster overlay errors leave the basemap intact and hiding tiles stops requesting them', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page);
  await page.route('https://example.test/bad/**', route => route.fulfill({ status: 503 }));
  await add(page, { name: 'Broken tiles', type: 'raster', url: 'https://example.test/bad/{z}/{x}/{y}.png' });
  const row = page.locator('[data-saved-layer]').filter({ hasText: 'Broken tiles' });
  await expect(row).toContainText('Map source unavailable');
  await expect(page.locator('#status-map')).not.toContainText('unavailable');
  await row.getByRole('checkbox').uncheck();
  const id = await row.getAttribute('data-saved-layer');
  await expect.poll(() => page.evaluate(id => Boolean(window.__testMap.getSource(`dynamic-${id}`)), id)).toBe(false);
  expect(errors).toEqual([]);
});

test('menu and dialog remain usable on mobile; Escape closes the menu and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page);
  await openLayers(page);
  const panel = await page.locator('#map-layers').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#map-source-dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Add layer', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#map-layers')).toBeHidden();
  await expect(page.locator('#map-layer-button')).toBeFocused();
  await page.screenshot({ path: 'test-results/dynamic-layers-mobile.png' });
});


test('a storage failure rejects the source and leaves the previous catalog unchanged', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (this.name === 'tidebound-map-catalog-v1' && mode === 'readwrite')
        throw new DOMException('Map storage quota exceeded.', 'QuotaExceededError');
      return transaction.call(this, stores, mode, options);
    };
  });
  await add(page, { name: 'Unsaved layer' });
  await expect(page.locator('#map-source-form-error')).toContainText('quota exceeded');
  await expect(page.locator('[data-saved-layer]')).toHaveCount(0);
  await page.reload(); await ready(page); await openLayers(page);
  await expect(page.locator('[data-saved-layer]')).toHaveCount(0);
});

test('an older basemap request cannot overwrite the newest selection', async ({ page }) => {
  await boot(page); await openLayers(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('https://tiles.openfreemap.org/styles/positron', async route => {
    await gate;
    try { await route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'late-style', type: 'background' }] } }); } catch {}
  });
  await page.getByLabel('Map background').selectOption('light');
  await page.getByLabel('Map background').selectOption('blank');
  release();
  await expect(page.getByLabel('Map background')).toHaveValue('blank');
  await page.waitForFunction(() => window.__testMap.loaded());
  expect(await page.evaluate(() => Boolean(window.__testMap.getLayer('late-style')))).toBe(false);
  await expect(page.locator('#status-map')).toHaveText('2D · Plain background');
});
