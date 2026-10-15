import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {distributionMetadata,distributionPlan} from '../src/simulation/distribution-geometry.js';
const origin=process.env.SIMULATION_ORIGIN||'http://127.0.0.1:5187';
const config=origin.includes('127.0.0.1')?await fetch('https://gis.n2wm787gnp.chatgpt.site/api/map-config').then(r=>r.json()):null;
const key='CKT_1002_15515';
const read=async kind=>JSON.parse(gunzipSync(await readFile(new URL(`../public/simulation/${kind}/${key}.json.gz`,import.meta.url))));
const plan=distributionPlan(distributionMetadata(await read('geometry'),await read('models')).solver);
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[],responses=new Map();page.on('pageerror',error=>errors.push(error.message.replace(/AIza[\w-]+/g,'[redacted]')));page.on('response',r=>{if(r.url().includes('/simulation/equipment/'))responses.set(r.url().split('/').at(-1),r.status());});
try{
 if(config)await page.route('**/api/map-config',route=>route.fulfill({json:config}));
 await page.goto(origin+'/#simulation');await page.waitForSelector('gmp-map-3d',{timeout:45000});await page.waitForFunction(()=>document.querySelectorAll('#simulation-circuit option').length>4000);
 await page.locator('#simulation-circuit').selectOption(key);await page.locator('[data-simulation-action="load"]').click();await page.waitForFunction(()=>!document.querySelector('[data-simulation-action="run"]').disabled,null,{timeout:90000});
 const targets=[['pole-mounted transformer',plan.transformers.find(t=>t.mounted)],['pad-mounted transformer',plan.transformers.find(t=>!t.mounted)],['switch open',plan.switches.find(s=>!s.closed)]];
 const checks=[];
 for(const [kind,target]of targets){
  if(!target)throw Error('Missing source equipment: '+kind);
  await page.locator('gmp-map-3d').evaluate(async(map,point)=>{await map.stopCameraAnimation();await map.flyCameraTo({endCamera:{center:{lng:point[0],lat:point[1],altitude:0},altitudeMode:'RELATIVE_TO_GROUND',range:140,tilt:65,heading:25},durationMillis:700});},target.point);
  await page.waitForTimeout(2000);await page.waitForSelector(`[data-simulation-equipment="${kind}"]`,{state:'attached',timeout:10000});
  checks.push({kind,sourceId:target.id,models:await page.locator(`[data-simulation-equipment="${kind}"]`).count()});
  await page.screenshot({path:`../simulation-browser/${kind.replaceAll(' ','-')}.png`});
 }
 if([...responses.values()].some(status=>status!==200)||errors.length)throw Error('Equipment failed to load');
 console.log(JSON.stringify({checks,modelResponses:Object.fromEntries(responses),errors},null,2));
 await writeFile('../simulation-browser/equipment-result.json',JSON.stringify({origin,key,checks,modelResponses:Object.fromEntries(responses),errors},null,2));
} catch(error){console.log('EQUIPMENT ERROR',error.message,'status',await page.locator('#simulation-status').innerText(),'camera',await page.locator('gmp-map-3d').evaluate(m=>({center:{lat:m.center.lat,lng:m.center.lng,altitude:m.center.altitude},range:m.range,tilt:m.tilt})));process.exitCode=1;}finally{await browser.close();}
