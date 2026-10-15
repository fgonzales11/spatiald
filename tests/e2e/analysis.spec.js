import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { publicMap } from './helpers/public-map.js';

let service, directory, origin;
test.describe.configure({ timeout: 60000 });
test.beforeAll(async()=>{
  if(!existsSync('.venv/bin/python')) return;
  directory=await mkdtemp(join(tmpdir(),'geobound-browser-analysis-'));
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));origin=`http://127.0.0.1:${port}`;
  service=spawn('.venv/bin/python',['-m','uvicorn','analysis_service.app:app','--host','127.0.0.1','--port',String(port)],{env:{...process.env,ANALYSIS_DATA_DIR:directory},stdio:'ignore'});
  await expect.poll(async()=>{try{return (await fetch(origin+'/api/analysis/health')).status;}catch{return 0;}},{timeout:20000}).toBe(200);
});
test.afterAll(async()=>{if(service){service.kill('SIGTERM');await new Promise(resolve=>service.once('exit',resolve));}if(directory)await rm(directory,{recursive:true,force:true});});

async function setup(page) {
  test.skip(!origin,'Install local analysis dependencies with npm run analysis:setup');
  await publicMap(page);
  await page.route('**/api/analysis/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/analysis/cameras')return route.fulfill({json:[]});
    const response=await route.fetch({url:origin+url.pathname+url.search});
    await route.fulfill({response});
  });
  await page.goto('/#analysis');
  await expect(page.getByRole('heading',{name:'Analysis workbench'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create study',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Study name',exact:true}).fill('Isolated browser resilience review');
  await page.getByRole('button',{name:'Create study',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Exposure',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Collect complete public assets for study area',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Frozen asset snapshot',exact:true}).locator('option:checked')).toContainText('complete AOI collection');
}

test('real local jobs connect exposure, findings, plots and portable review export',async({page},testInfo)=>{
  await setup(page);
  const studyId=await page.getByRole('combobox',{name:'Study',exact:true}).inputValue();
  const hazard={name:'Isolated flood fixture',hazardType:'flood',complete:true,coverageGeometry:{type:'Polygon',coordinates:[[[-83,27],[-81,27],[-81,29],[-83,29],[-83,27]]]},data:{type:'FeatureCollection',features:[{type:'Feature',id:'h',geometry:{type:'Polygon',coordinates:[[[-83,27],[-81,27],[-81,29],[-83,29],[-83,27]]]},properties:{}}]}};
  const response=await fetch(origin+`/api/analysis/studies/${studyId}/entities/layer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(hazard)});
  expect(response.status).toBe(201);
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();
  // Reloading a study restores its immutable records; evidence selection is explicit.
  await page.reload();
  await expect(page.getByRole('checkbox',{name:'Isolated flood fixture',exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Isolated flood fixture',exact:true}).check();
  await page.getByRole('button',{name:'Analyze exposure',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Exposure results',exact:true})).toBeVisible();
  await page.locator('[data-analysis-action="select-asset"]').first().click();
  await page.getByRole('combobox',{name:'Review priority',exact:true}).selectOption('High');
  await page.getByRole('textbox',{name:'Reason for priority',exact:true}).fill('Mapped flood intersection requires field review');
  await page.getByRole('textbox',{name:'Proposed actions',exact:true}).fill('Verify surveyed equipment elevation');
  await page.getByRole('button',{name:'Save finding',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save finding',exact:true})).toBeEnabled();
  await page.getByRole('tab',{name:'Charts',exact:true}).click();
  await page.getByRole('combobox',{name:'Horizontal field',exact:true}).selectOption('assetType');
  await page.getByRole('combobox',{name:'Value field',exact:true}).selectOption('lengthM');
  await page.getByRole('combobox',{name:'Aggregation',exact:true}).selectOption('sum');
  await page.getByRole('button',{name:'Generate chart',exact:true}).click();
  await expect(page.locator('[data-analysis-chart] svg')).toBeVisible();
  await page.getByRole('button',{name:'Save chart to review',exact:true}).click();
  await page.getByRole('tab',{name:'Reviews',exact:true}).click();
  await expect(page.getByRole('cell',{name:'Mapped flood intersection requires field review',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Export study ZIP',exact:true})).toBeVisible();
  const archive=await fetch(origin+`/api/analysis/studies/${studyId}/package`);
  expect(archive.status).toBe(200);expect(archive.headers.get('content-type')).toContain('application/zip');
  await page.screenshot({path:testInfo.outputPath('workbench.png'),fullPage:true});
});

test('service offline is explicit and ordinary inventory remains usable',async({page})=>{
  await publicMap(page);
  await page.route('**/api/analysis/**',route=>route.fulfill({status:503,json:{detail:'Local analysis service is unavailable'}}));
  await page.goto('/#analysis');
  await expect(page.getByRole('heading',{name:'Local analysis service unavailable'})).toBeVisible();
  await page.getByRole('link',{name:'Assets',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Asset inventory'})).toBeVisible();
});
