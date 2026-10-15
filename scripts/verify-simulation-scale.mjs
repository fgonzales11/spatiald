import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const origin=process.env.SIMULATION_ORIGIN||'http://127.0.0.1:5187';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.addInitScript(()=>localStorage.setItem('tidebound.preferences.v1',JSON.stringify({defaultMap:'2d'})));
 await page.goto(origin+'/#simulation');
 await page.waitForFunction(()=>document.querySelectorAll('#simulation-circuit option').length>4000,null,{timeout:30000});
 const network=await page.evaluate(()=>fetch('/simulation/catalog.json').then(r=>r.json()).then(c=>c.networks.filter(n=>n.available).sort((a,b)=>b.edge_count-a.edge_count)[0]));
 console.log('Largest model',network.circuit_key,network.bus_count,'buses',network.edge_count,'connections');
 await page.locator('#simulation-circuit').selectOption(network.circuit_key);await page.locator('[data-simulation-action="load"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-simulation-action="run"]').disabled,null,{timeout:60000});
 const start=Date.now();await page.locator('[data-simulation-action="run"]').click();
 await page.waitForFunction(()=>['converged','nonconverged','error'].includes(document.querySelector('#simulation-status').dataset.state),null,{timeout:240000});
 const state=await page.locator('#simulation-status').getAttribute('data-state'),message=await page.locator('#simulation-status').innerText(),detail=await page.locator('#simulation-detail').innerText();
 console.log('Largest model result',state,message,Date.now()-start,'ms');
 await writeFile('../simulation-browser/scale-result.json',JSON.stringify({circuit_key:network.circuit_key,buses:network.bus_count,connections:network.edge_count,state,message,detail,wall_seconds:(Date.now()-start)/1000,errors},null,2));
 if(state==='error'||errors.length)throw Error('Largest model verification failed');
}catch(error){console.log('Failure body',await page.locator('body').innerText());console.log('Page errors',errors);throw error;}finally{await browser.close();}
