import {chromium} from '@playwright/test';import {writeFile,mkdir} from 'node:fs/promises';
const origin=process.env.SIMULATION_ORIGIN||'http://127.0.0.1:5187',out=new URL('../../tron-browser/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,250));});
await page.addInitScript(()=>{
 if(!localStorage.getItem('tidebound.preferences.v1'))localStorage.setItem('tidebound.preferences.v1',JSON.stringify({defaultMap:'tron'}));
 const original=Worker.prototype.postMessage;Worker.prototype.postMessage=function(data,transfer){if(data.catalog&&data.model&&window.__oneIteration)data.parameters={MaxIter:1};return original.call(this,data,transfer);};
});
try{
 await page.goto(origin+'/#simulation');await page.waitForSelector('[data-map-view="tron"]',{timeout:30000});await page.waitForFunction(()=>document.querySelectorAll('#simulation-circuit option').length>4000);
 await page.locator('#simulation-circuit').selectOption('CKT_1001_15510');await page.locator('[data-simulation-action="load"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-simulation-action="run"]').disabled,null,{timeout:60000});
 await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronBuildings)>0,null,{timeout:30000});
 console.log('Loaded TRON',await page.locator('[data-map-view="tron"]').evaluate(e=>({...e.dataset})));
 await page.locator('[data-simulation-action="run"]').click();await page.waitForFunction(()=>['converged','nonconverged','error'].includes(document.querySelector('#simulation-status').dataset.state),null,{timeout:180000});
 if(await page.locator('#simulation-status').getAttribute('data-state')!=='converged')throw Error(await page.locator('#simulation-status').innerText());
 await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronGlowCount)>0);
 const before=await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase');await page.waitForTimeout(350);const after=await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase');if(before!==after)throw Error('Power-flow animation is still active');
 if(await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-count')!=='0')throw Error('Moving power-flow particles are still present');
 await page.screenshot({path:new URL('tron-network.png',out).pathname});
 // Zoom in to inspect real GLB equipment and building wireframes.
 for(let i=0;i<3;i++)await page.locator('[data-zoom="1"]').click();
 await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronEquipment)>0);
 await page.waitForTimeout(1500);await page.screenshot({path:new URL('tron-equipment.png',out).pathname});
 const detail=await page.locator('[data-map-view="tron"]').evaluate(e=>({...e.dataset}));
 // Settings apply in place to a solved circuit and persist on this origin.
 await page.locator('[data-nav="settings"]').click();
 for(const key of ['transit','buildings','interactive'])await page.locator(`[data-tron-setting="${key}"]`).uncheck();
 await page.screenshot({path:new URL('tron-settings.png',out).pathname});
 await page.locator('[data-nav="simulation"]').click();
 await page.waitForFunction(()=>{const d=document.querySelector('[data-map-view="tron"]').dataset;return d.tronBuildings==='0'&&d.tronBuildingsEnabled==='false'&&d.tronTransitEnabled==='false'&&d.tronAnimatedEnabled==='false'&&d.tronInteractiveEnabled==='false';});
 const frozen=await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase');
 await page.waitForTimeout(500);if(frozen!==await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase'))throw Error('Power-flow phase changed despite steady glow');
 if(await page.locator('#simulation-status').getAttribute('data-state')!=='converged')throw Error('Settings discarded solved circuit');
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('tidebound.preferences.v1')).tronSettings);
 if(Object.values(stored).some(v=>v!==false))throw Error('Settings were not saved');
 await page.locator('[data-nav="settings"]').click();
 for(const key of ['transit','buildings','interactive'])await page.locator(`[data-tron-setting="${key}"]`).check();
 await page.locator('[data-nav="simulation"]').click();
 await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronBuildings)>0);
 const resumed=await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase');await page.waitForTimeout(350);
 if(resumed!==await page.locator('[data-map-view="tron"]').getAttribute('data-tron-flow-phase'))throw Error('Settings re-enabled power-flow animation');

 await page.locator('#simulation-visible').uncheck();await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronConnections)===0&&Number(document.querySelector('[data-map-view="tron"]').dataset.tronEquipment)===0);
 await page.locator('#simulation-visible').check();await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]').dataset.tronConnections)>0);
 await page.locator('[data-map-mode="2d"]').click();await page.waitForSelector('[data-map-mode="2d"][aria-pressed="true"]');await page.waitForSelector('canvas.maplibregl-canvas');
 if(await page.locator('.tron-credit').count())throw Error('TRON scene did not dispose');
 await page.locator('[data-map-mode="tron"]').click();await page.waitForFunction(()=>Number(document.querySelector('[data-map-view="tron"]')?.dataset.tronConnections)>0);
 await page.evaluate(()=>{window.__oneIteration=true;});await page.locator('[data-simulation-action="run"]').click();await page.waitForFunction(()=>document.querySelector('#simulation-status').dataset.state==='nonconverged',null,{timeout:30000});
 await page.waitForFunction(()=>document.querySelector('[data-map-view="tron"]').dataset.tronNetworkState==='nonconverged'&&Number(document.querySelector('[data-map-view="tron"]').dataset.tronFlowCount)===0);
 await page.screenshot({path:new URL('tron-nonconverged.png',out).pathname});
 await page.locator('[data-nav="settings"]').click();await page.locator('[data-tron-setting="transit"]').uncheck();
 await page.reload();await page.waitForSelector('[data-map-view="tron"]',{state:'attached'});if(await page.locator('[data-map-mode="tron"]').getAttribute('aria-pressed')!=='true')throw Error('TRON preference did not survive reload');
 if(await page.locator('[data-tron-setting="transit"]').isChecked())throw Error('TRON settings did not survive reload');
 await page.locator('[data-nav="simulation"]').click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('tron-mobile.png',out).pathname});
 const result={origin,detail,checks:['third mode active','source vector buildings loaded','raised GLB equipment','actual WASM convergence and steady line glow','nonconvergence retains steady failure glow','single network visibility toggle','switch 2D/TRON retains loaded network','TRON preference survives reload','three settings apply in place and persist','no power-flow animation after settings changes'],errors};
 await writeFile(new URL('result.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(errors.length)throw Error('Browser errors');
}catch(e){console.log('TRON ERROR',e.message,'status',await page.locator('#simulation-status').innerText().catch(()=>''),'notice',await page.locator('#map-notice').innerText().catch(()=>''));await page.screenshot({path:new URL('error.png',out).pathname});process.exitCode=1;}finally{await browser.close();}
