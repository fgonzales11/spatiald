import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { publicMap, ready } from './helpers/public-map.js';
import { pointInFootprint, PV_UNKNOWN_COLOR } from '../../src/spatial/pv-buildings.js';

const data=JSON.parse(await readFile(new URL('../../public/data/solar/teco-pv-buildings.json',import.meta.url),'utf8'));
function interior(feature) {
  const ring=feature.geometry.coordinates[0], xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);
  const w=Math.min(...xs),e=Math.max(...xs),s=Math.min(...ys),n=Math.max(...ys);
  for(let x=1;x<10;x++) for(let y=1;y<10;y++) {
    const p=[w+(e-w)*x/10,s+(n-s)*y/10];
    if(pointInFootprint(p,feature.geometry)) return p;
  }
  throw new Error('No roof interior available for browser verification');
}
async function clickRoof(page,feature) {
  const center=interior(feature);
  await page.evaluate(center=>window.__testMap.jumpTo({center,zoom:19}),center);
  await page.waitForFunction(()=>window.__testMap.loaded());
  const p=await page.evaluate(center=>{const p=window.__testMap.project(center);return {x:p.x,y:p.y};},center);
  await page.locator('[data-testid="map-canvas"]').click({position:p});
}

test('real public capacities color individual roofs, unknown sizes stay yellow, and visibility persists',async ({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await publicMap(page);
  await page.goto('/');await ready(page);
  await expect(page.locator('.solar-pv-status')).toContainText('36 sized sites');
  await expect(page.locator('.solar-pv-status')).toContainText('108 nearest buildings');
  await openMapLayers(page);
  await page.getByRole('button',{name:'PV legend and details'}).click();
  await expect(page.getByLabel('PV system size')).toBeChecked();
  await expect(page.getByLabel('PV capacity legend')).toContainText('Size unreported');
  await openMapLayers(page);
  await page.getByLabel('PKL PV buildings').uncheck();
  await openMapLayers(page);
  await page.getByLabel('Highway cameras').uncheck();
  expect(await page.evaluate(()=>['tb-pv-site-overview','tb-pv-unmatched-sites'].some(id=>window.__testMap.getLayer(id)))).toBe(false);
  const known=data.buildings.features.find(f=>f.properties.size_kw!==null && f.geometry.coordinates[0][0][1]<27.935);
  await clickRoof(page,known);
  await expect(page.locator('.solar-pv-popup')).toContainText('kW');
  const published=data.sites.find(s=>s.site_id===known.properties.site_ids[0]);
  await expect(page.locator('.solar-pv-popup a').first()).toHaveAttribute('href',published.source_url);
  const rendered=await page.evaluate(key=>window.__testMap.queryRenderedFeatures({layers:['tb-pv-buildings']}).find(f=>f.properties.key===key)?.properties.color,known.properties.key);
  expect(rendered).toBe(known.properties.color);
  const unknown=data.buildings.features.find(f=>f.properties.size_kw===null && f.geometry.coordinates[0][0][1]<27.935);
  expect(unknown.properties.color).toBe(PV_UNKNOWN_COLOR);
  await clickRoof(page,unknown);
  await expect(page.locator('.solar-pv-popup')).toContainText('PV · size not reported');
  await openMapLayers(page);
  await page.getByLabel('PV system size').uncheck();
  await expect(page.locator('.solar-pv-popup')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__testMap.getLayoutProperty('tb-pv-buildings','visibility'))).toBe('none');
  await page.reload();await ready(page);
  await expect(page.getByLabel('PV system size')).not.toBeChecked();
  await expect(page.locator('.solar-pv-status')).toContainText('108 nearest buildings');
  expect(await page.evaluate(()=>window.__testMap.getLayoutProperty('tb-pv-buildings','visibility'))).toBe('none');
  await openMapLayers(page);
  await page.getByLabel('PV system size').check();
  await clickRoof(page,known);
  await expect(page.locator('.solar-pv-popup')).toContainText('kW');
  expect(errors).toEqual([]);
});

test('PKL generators render red roofs with model popups and independent persistent visibility',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const pkl=JSON.parse(await readFile(new URL('../../public/data/solar/teco-pkl-pv-buildings.json',import.meta.url),'utf8'));
  await publicMap(page);await page.goto('/');await ready(page);
  await expect(page.locator('.pkl-pv-status')).toContainText('463 model generators');
  await expect(page.locator('.pkl-pv-status')).toContainText('462 red OSM buildings');
  await expect(page.getByLabel('PKL PV buildings')).toBeChecked();
  await openMapLayers(page);
  await page.getByLabel('Highway cameras').uncheck();
  const roof=pkl.buildings.features[0];
  await clickRoof(page,roof);
  await expect(page.locator('.pkl-pv-popup h3')).toHaveText('PKL PV building');
  await expect(page.locator('.pkl-pv-popup')).toContainText('modeled active power');
  const generator=pkl.sites.find(s=>s.site_id===roof.properties.site_ids[0]);
  await expect(page.locator('.pkl-pv-popup')).toContainText(generator.source_model);
  const properties=await page.evaluate(key=>window.__testMap.queryRenderedFeatures({layers:['tb-pkl-pv-buildings']}).find(f=>f.properties.key===key)?.properties,roof.properties.key);
  expect(properties.color).toBe('#ff0000');
  expect(await page.evaluate(()=>window.__testMap.getLayer('tb-pkl-pv-buildings').type)).toBe('fill');
  await openMapLayers(page);
  await page.getByLabel('PKL PV buildings').uncheck();
  await expect(page.locator('.pkl-pv-popup')).toHaveCount(0);
  await expect(page.getByLabel('PV system size')).toBeChecked();
  expect(await page.evaluate(()=>window.__testMap.getLayoutProperty('tb-pkl-pv-buildings','visibility'))).toBe('none');
  await page.reload();await ready(page);
  await expect(page.locator('.pkl-pv-status')).toContainText('462 red OSM buildings');
  await expect(page.getByLabel('PKL PV buildings')).not.toBeChecked();
  await expect(page.getByLabel('PV system size')).toBeChecked();
  await openMapLayers(page);
  await page.getByLabel('PKL PV buildings').check();
  await clickRoof(page,roof);
  await expect(page.locator('.pkl-pv-popup h3')).toHaveText('PKL PV building');
  // Restoring a style recreates both independent layers and keeps red above public colors.
  await page.evaluate(()=>window.__testMap.setStyle({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#102332'}}]}));
  await page.waitForFunction(()=>window.__testMap.loaded()&&window.__testMap.getLayer('tb-pkl-pv-buildings'));
  expect(await page.evaluate(()=>{
    const ids=window.__testMap.getStyle().layers.map(l=>l.id);return ids.indexOf('tb-pkl-pv-buildings')>ids.indexOf('tb-pv-outlines');
  })).toBe(true);
  expect(errors).toEqual([]);
});

test('solar fetch failures offer a retry that restores the data and map',async ({page})=>{
  await publicMap(page);
  let fail=true;
  await page.route('**/data/solar/teco-pv-buildings.json',async route=>fail ? route.fulfill({status:503,body:'Unavailable'}) : route.continue());
  await page.goto('/');await ready(page);
  await expect(page.locator('.solar-pv-status')).toContainText('503');
  fail=false;
  await openMapLayers(page);
  await page.getByRole('button',{name:'Retry solar layer'}).click();
  await expect(page.locator('.solar-pv-status')).toContainText('108 nearest buildings');
  await page.waitForFunction(()=>window.__testMap.getLayer('tb-pv-buildings'));
});
