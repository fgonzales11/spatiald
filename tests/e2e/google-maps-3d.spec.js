import { test, expect } from '@playwright/test';
import { publicMap } from './helpers/public-map.js';

async function setup(page, { fail = false, delayed = false } = {}) {
  await publicMap(page);
  await page.route('**/api/map-config', route => route.fulfill({ json: { googleMapsApiKey: 'fixture-browser-key' } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('https://maps.googleapis.com/maps/api/js?**', async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('v')).toBe('weekly');
    expect(url.searchParams.get('loading')).toBe('async');
    if (delayed) await gate;
    if (fail) return route.abort();
    await route.fulfill({ contentType: 'application/javascript', body: `
      class Map3D extends HTMLElement {
        constructor(options) { super(); Object.assign(this, options); window.__googleMap = this; }
        connectedCallback() { setTimeout(() => { const e = new Event('gmp-steadychange'); e.isSteady = true; this.dispatchEvent(e); }, 50); }
        stopCameraAnimation() {}
        flyCameraTo(options) { Object.assign(this, options.endCamera); }
      }
      class Marker3D extends HTMLElement { constructor(options) { super(); Object.assign(this, options); } }
      class Line3D extends HTMLElement { constructor(options) { super(); Object.assign(this, options); } }
      customElements.define('gmp-map-3d', Map3D);
      customElements.define('gmp-marker-3d-interactive', Marker3D);
      customElements.define('gmp-polyline-3d-interactive', Line3D);
      window.google = { maps: { importLibrary: async name => {
        if(name !== 'maps3d') throw new Error('Expected photorealistic library');
        return { Map3DElement: Map3D, Marker3DInteractiveElement: Marker3D, Polyline3DInteractiveElement: Line3D };
      } } };
      window.${url.searchParams.get('callback')}();
    ` });
  });
  return release;
}

test('Google 3D initializes, controls camera, retains viewpoint across modes and reload, and disposes overlays', async ({ page }) => {
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await setup(page); await page.goto('/');
  await expect(page.locator('#status-map')).toContainText('photorealistic terrain and buildings');
  const map=page.locator('gmp-map-3d'); await expect(map).toHaveCount(1);
  expect(await map.evaluate(m=>m.mode)).toBe('SATELLITE');
  expect(await map.evaluate(m=>m.defaultUIHidden)).toBe(false);
  await page.getByRole('button',{name:'Rotate right',exact:true}).click();
  await page.getByRole('button',{name:'Tilt camera down',exact:true}).click();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  expect(await map.evaluate(m=>({heading:m.heading,tilt:m.tilt,range:m.range}))).toEqual({heading:30,tilt:55,range:1520});
  await expect(page.locator('gmp-polyline-3d-interactive').first()).toBeAttached();
  await page.locator('gmp-polyline-3d-interactive').first().dispatchEvent('gmp-click');
  await expect(page.locator('#map-inspector')).toBeVisible();
  await page.getByLabel('Use 2D map').click();
  await expect(map).toHaveCount(0);
  await expect(page.getByRole('group',{name:'3D camera controls'})).toHaveCount(0);
  await page.getByLabel('Use 3D map').click();
  await expect(map).toHaveCount(1);
  expect(await map.evaluate(m=>({heading:m.heading,tilt:m.tilt,range:m.range}))).toEqual({heading:30,tilt:55,range:1520});
  await page.reload(); await expect(map).toHaveCount(1);
  expect(await map.evaluate(m=>m.heading)).toBe(30);
  await page.getByRole('button',{name:'Reset north',exact:true}).click();
  expect(await map.evaluate(m=>m.heading)).toBe(0);
  expect(errors).toEqual([]);
});

test('script failure retains 2D with actionable retry and permits a successful reload', async ({ page }) => {
  await setup(page,{fail:true}); await page.goto('/');
  await expect(page.locator('#map-notice')).toContainText('Google Maps could not connect');
  await expect(page.getByRole('button',{name:'Retry 3D',exact:true})).toBeVisible();
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible();
  await expect(page.locator('.google-map-loading')).toHaveCount(0);
  await setup(page); await page.getByRole('button',{name:'Retry 3D',exact:true}).click();
  await expect(page.locator('#status-map')).toContainText('photorealistic terrain and buildings');
  await page.evaluate(()=>window.gm_authFailure());
  await expect(page.locator('#map-notice')).toContainText('Google Maps rejected map access');
  await expect(page.locator('gmp-map-3d')).toHaveCount(0);
});

test('leaving while the SDK loads prevents a stale 3D mount', async ({ page }) => {
  const release=await setup(page,{delayed:true}); await page.goto('/');
  await expect(page.locator('.google-map-loading')).toBeVisible();
  await page.getByLabel('Use 2D map').click();
  release();
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.locator('gmp-map-3d')).toHaveCount(0);
  await page.getByLabel('Use 3D map').click();
  await expect(page.locator('gmp-map-3d')).toHaveCount(1);
});

test('transmission is elevated above terrain while gas stays on the ground, including selection and reload', async ({ page }) => {
  await setup(page); await page.goto('/');
  const transmission=page.locator('gmp-polyline-3d-interactive[data-asset-type="transmission_line"]').first();
  const gas=page.locator('gmp-polyline-3d-interactive[data-asset-type="gas_main"]').first();
  await expect(transmission).toBeAttached(); await expect(gas).toBeAttached();
  const placement=()=>transmission.evaluate(line=>({mode:line.altitudeMode,heights:line.path.map(p=>p.altitude)}));
  await expect.poll(placement).toEqual({mode:'RELATIVE_TO_GROUND',heights:[24,24]});
  expect(await gas.evaluate(line=>line.altitudeMode)).toBe('CLAMP_TO_GROUND');
  await transmission.dispatchEvent('gmp-click');
  await expect(page.locator('#map-inspector')).toContainText('24 m above ground · display estimate');
  await expect.poll(placement).toEqual({mode:'RELATIVE_TO_GROUND',heights:[24,24]});
  await page.reload();
  await expect.poll(placement).toEqual({mode:'RELATIVE_TO_GROUND',heights:[24,24]});
  expect(await gas.evaluate(line=>line.altitudeMode)).toBe('CLAMP_TO_GROUND');
});
