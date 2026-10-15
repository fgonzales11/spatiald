// Local browser regression against the real GIS circuit and rendered TRON layers.
// Instrumentation is applied only to intercepted Vite responses, never app source.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {geospatialNetwork} from '../src/simulation/geospatial-network.js';
import {distributionPlan} from '../src/simulation/distribution-geometry.js';

const origin=process.env.SIMULATION_ORIGIN||'http://127.0.0.1:5187';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('This verifier requires the local Vite preview.');
const key='CKT_114_16955',out=new URL('../../pole-placement-browser/',import.meta.url);
await mkdir(out,{recursive:true});
const read=async kind=>JSON.parse(gunzipSync(await readFile(new URL(`../public/simulation/${kind}/${key}.json.gz`,import.meta.url))));
const [old,model,reference]=await Promise.all(['geometry','models','geospatial'].map(read));
const geometry=geospatialNetwork(old,model,reference),sourceBefore=JSON.stringify(geometry),plan=distributionPlan(geometry.solver);
const curveBounds=[-118.1355229,34.0983314,-118.1354178,34.0983777],curveCenter=[-118.13547035,34.09835455];
const inside=(p,b)=>p[0]>=b[0]-1e-10&&p[0]<=b[2]+1e-10&&p[1]>=b[1]-1e-10&&p[1]<=b[3]+1e-10;
const distance=(a,b)=>Math.hypot((b[0]-a[0])*111320*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*111320);
const curve=geometry.solver.features.find(f=>f.id==='gis-route:0:56');
assert.equal(curve.geometry.coordinates.filter(p=>inside(p,curveBounds)).length,38);
assert.equal(plan.nodes.filter(n=>inside(n.point,curveBounds)).length,0);
assert.equal(JSON.stringify(geometry),sourceBefore);
const targets=['80254','148379','173390'].map(id=>plan.transformers.find(t=>t.id===`TCGOGESW_UG_TRANSFORMER_LOCATION:${id}`));
assert.ok(targets.every(t=>t?.displayPoint&&t.displayOffsetMeters>=4));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],responses=new Map();
page.on('pageerror',e=>errors.push(e.message.replace(/AIza[\w-]+/g,'[redacted]')));
page.on('response',r=>{if(r.url().includes('/simulation/equipment/'))responses.set(r.url().split('/').at(-1).split('?')[0],r.status());});
await page.addInitScript(()=>localStorage.setItem('tidebound.preferences.v1',JSON.stringify({defaultMap:'tron'})));
await page.route('**/src/spatial/map2d.js*',async route=>{
 const response=await route.fetch(),source=await response.text(),needle='const map = new Map(';
 assert.ok(source.includes(needle),'Map construction instrumentation must match actual source');
 await route.fulfill({response,body:source.replace(needle,'const map = window.__polePlacementMap = new Map(')});
});
await page.route('**/src/spatial/tron-scene.js*',async route=>{
 const response=await route.fetch(),source=await response.text(),needle='setLayers(baseLayers);';
 assert.ok(source.includes(needle),'Layer instrumentation must match actual source');
 await route.fulfill({response,body:source.replace(needle,'window.__polePlacementLayers = baseLayers; setLayers(baseLayers);')});
});
async function inspect(center){
 await page.evaluate(center=>window.__polePlacementMap.jumpTo({center,zoom:20.4,pitch:67,bearing:25}),center);
 await page.waitForFunction(center=>{const m=window.__polePlacementMap,c=m.getCenter();return Math.abs(c.lng-center[0])<1e-8&&Math.abs(c.lat-center[1])<1e-8&&!m.isMoving();},center);
 await page.waitForTimeout(400);
 await page.waitForFunction(()=>window.__polePlacementLayers?.filter(l=>l.id.startsWith('tron-equipment-')).length>0&&window.__polePlacementLayers.filter(l=>l.id.startsWith('tron-equipment-')).every(l=>l.isLoaded),null,{timeout:30000});
 await page.waitForTimeout(300);
 return page.evaluate(()=>({metadata:{...document.querySelector('[data-map-view="tron"]').dataset},layers:window.__polePlacementLayers.filter(l=>l.id.startsWith('tron-equipment-')).map(l=>({id:l.id,isLoaded:l.isLoaded,positions:l.props.data.map(d=>l.props.getPosition(d))}))}));
}
try{
 await page.goto(origin+'/#simulation');
 await page.waitForSelector('[data-map-view="tron"]',{timeout:30000});
 await page.waitForFunction(()=>document.querySelectorAll('#simulation-circuit option').length>4000);
 await page.locator('#simulation-circuit').selectOption(key);await page.locator('[data-simulation-action="load"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-simulation-action="run"]').disabled,null,{timeout:60000});
 await page.locator('[data-nav="spatial"]').click();
 const curveView=await inspect(curveCenter);
 const curvePoles=curveView.layers.filter(l=>['tron-equipment-pole','tron-equipment-pole-transformer'].includes(l.id)).flatMap(l=>l.positions);
 assert.equal(curvePoles.filter(p=>inside(p,curveBounds)).length,0,'Every pole in the dense curve must be absent from rendered layer data');
 assert.ok(curvePoles.length>0,'Ordinary nearby poles must remain visible');
 assert.equal(Number(curveView.metadata.suppressedGeneratedPoles),plan.placement.suppressedGeneratedPoles);
 await page.screenshot({path:new URL('curve-without-pole-wall.png',out).pathname});
 // Temporarily hide TRON buildings so the ground cabinets can be inspected.
 await page.locator('[data-nav="settings"]').click();
 await page.locator('[data-tron-setting="buildings"]').uncheck();
 await page.locator('[data-nav="spatial"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-map-view="tron"]').dataset.tronBuildingsEnabled==='false');
 const padmounts=[];
 for(const target of targets){
  const view=await inspect(target.point),pads=view.layers.find(l=>l.id==='tron-equipment-padmount-transformer')?.positions||[];
  const rendered=pads.find(p=>distance(p,target.displayPoint)<.01);
  assert.ok(rendered,`Actual ScenegraphLayer must render the display offset for ${target.id}`);
  assert.ok(distance(rendered,target.point)>4,`Cabinet must leave the recorded pole location for ${target.id}`);
  const poles=view.layers.filter(l=>['tron-equipment-pole','tron-equipment-pole-transformer'].includes(l.id)).flatMap(l=>l.positions);
  assert.ok(poles.length>0,'Clearance verification requires actual nearby rendered poles');
  const clearance=Math.min(...poles.map(p=>distance(p,rendered)));
  assert.ok(clearance>=4,`Rendered padmount must clear all rendered poles: ${clearance}`);
  assert.ok(poles.some(p=>distance(p,target.point)<.01),'Original support remains at its GIS point');
  padmounts.push({id:target.id,source:target.point,rendered,clearance,offset:distance(rendered,target.point)});
  await page.screenshot({path:new URL(`padmount-${target.id.split(':').at(-1)}.png`,out).pathname});
 }
 // Panning and zoom culling must not allow any suppressed curve poles to reappear.
 const revisited=await inspect(curveCenter);
 assert.equal(revisited.layers.filter(l=>['tron-equipment-pole','tron-equipment-pole-transformer'].includes(l.id)).flatMap(l=>l.positions).filter(p=>inside(p,curveBounds)).length,0);
 assert.equal(errors.length,0,errors.join('\n'));
 assert.ok([...responses.values()].every(status=>status===200),'Every requested equipment GLB must load');
 const result={origin,circuit:key,placement:plan.placement,curve:{center:curveCenter,originalClusterVertices:38,renderedClusterPoles:0,ordinaryVisiblePoles:curvePoles.length},padmounts,modelResponses:Object.fromEntries(responses),checks:['real circuit loaded through the app','all 38 dense curve poles absent from actual rendered layers','ordinary poles retained','all three real exact-overlap padmounts offset in rendered ScenegraphLayers','every tested padmount clears rendered pole shafts by at least 4 m','recorded pole positions retained','suppression survives camera movement and LOD updates','source GIS geometry unchanged'],errors};
 await writeFile(new URL('result.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){await page.screenshot({path:new URL('error.png',out).pathname}).catch(()=>{});throw error;}finally{await browser.close();}
