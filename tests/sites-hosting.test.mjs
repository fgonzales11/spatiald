import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { googleMapsKey } from '../src/data/runtime-config.js';

test('FDOT Node relay keeps credentials server-side and preserves same-origin video routes',async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 const env={CAMERA_RELAY_URL:'https://relay.test/api/camera',CAMERA_RELAY_TOKEN:'server-only-fixture'};
 try{
  globalThis.fetch=async(input,options)=>{calls.push({url:new URL(input),options});return new Response('#EXTM3U\n/api/highway-cameras/2262/stream?path=segment.ts\n',{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});};
  const response=await worker.fetch(new Request('https://geobound.test/api/highway-cameras/2262/stream?path=child.m3u8',{headers:{Authorization:'Bearer browser-supplied'}}),env);
  assert.equal(response.status,200);
  const body=await response.text();assert.match(body,/\/api\/highway-cameras\/2262\/stream/);assert.ok(!body.includes(env.CAMERA_RELAY_TOKEN));
  assert.equal(calls[0].url.origin,'https://relay.test');assert.equal(calls[0].url.searchParams.get('path'),'child.m3u8');
  assert.equal(calls[0].options.headers.Authorization,'Bearer server-only-fixture');assert.equal(calls[0].options.redirect,'manual');
  assert.equal((await worker.fetch(new Request('https://geobound.test/api/highway-cameras/0/stream'),env)).status,404);
  assert.equal((await worker.fetch(new Request('https://geobound.test/api/highway-cameras/2262/stream',{method:'POST'}),env)).status,405);
  assert.equal(calls.length,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('hosted mode distinguishes unavailable analysis and valid camera catalogs',async()=>{
 const unavailable=await worker.fetch(new Request('https://geobound.test/api/analysis/health'),{});
 assert.equal(unavailable.status,503);assert.match((await unavailable.json()).detail,/Python/);
 const catalog=await (await worker.fetch(new Request('https://geobound.test/api/analysis/cameras'),{})).json();
 assert.ok(catalog.some(c=>c.provider==='Caltrans'));assert.ok(catalog.some(c=>c.provider==='FDOT'));
 assert.equal((await worker.fetch(new Request('https://geobound.test/api/highway-cameras/0/stream'),{})).status,404);
 const camera=catalog.find(c=>c.provider==='Caltrans'&&c.snapshot);
 const invalid=await worker.fetch(new Request('https://geobound.test'+camera.stream+'?path=https%3A%2F%2Fevil.test%2Fsecret'),{});
 assert.equal(invalid.status,400);
});

test('precompressed tiles keep encoding and normal assets pass through',async()=>{
 const assets={fetch:async req=>new Response(new URL(req.url).pathname,{headers:{'Content-Type':'application/octet-stream'}})};
 const tile=await worker.fetch(new Request('https://geobound.test/data/us-transmission/tiles/1/0/1.pbf',{headers:{'Accept-Encoding':'gzip'}}),{ASSETS:assets});
 assert.equal(tile.headers.get('content-encoding'),'gzip');assert.match(await tile.text(),/\.pbf.gz$/);
 assert.equal(await (await worker.fetch(new Request('https://geobound.test/index.html'),{ASSETS:assets})).text(),'/index.html');
});

test('camera relay supports edge redirect modes, rejects redirects, and preserves binary data',async()=>{
 const originalFetch=globalThis.fetch;
 const calls=[];
 try{
  globalThis.fetch=async(input,options={})=>{
   calls.push({url:String(input),redirect:options.redirect});
   if(options.redirect==='error')throw new TypeError('Edge runtime does not implement redirect:error');
   const url=new URL(String(input));
   if(url.pathname.includes('GetVideoUrl'))return Response.json('?token=fixture');
   if(url.pathname.endsWith('.m3u8'))return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n',{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
   return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
  };
  const image=await worker.fetch(new Request('https://geobound.test/api/highway-cameras/2262/snapshot'),{});
  assert.equal(image.status,200);assert.equal((await image.arrayBuffer()).byteLength,4);
  const playlist=await worker.fetch(new Request('https://geobound.test/api/highway-cameras/2262/stream'),{});
  assert.equal(playlist.status,200);assert.match(await playlist.text(),/\/api\/highway-cameras\/2262\/stream\?path=/);
  const catalog=await (await worker.fetch(new Request('https://geobound.test/api/analysis/cameras'),{})).json();
  const camera=catalog.find(c=>c.provider==='Caltrans'&&c.snapshot&&c.inService);
  assert.equal((await worker.fetch(new Request('https://geobound.test'+camera.snapshot),{})).status,200);
  assert.ok(calls.some(c=>c.redirect==='manual'));assert.ok(calls.every(c=>c.redirect!=='error'));
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://unlisted.test'}});
  assert.equal((await worker.fetch(new Request('https://geobound.test'+camera.snapshot),{})).status,502);
 }finally{globalThis.fetch=originalFetch;}
});

test('map configuration resolves the named browser key at runtime and keeps unrelated secrets out',async()=>{
 const response=await worker.fetch(new Request('https://geobound.test/api/map-config'),{VITE_GOOGLE_MAPS_API_KEY:' fixture-browser-key ',ANALYSIS_BEARER_TOKEN:'unrelated-secret'});
 assert.equal(response.headers.get('cache-control'),'no-store');
 const text=await response.text();assert.ok(!text.includes('unrelated-secret'));
 assert.equal(await googleMapsKey('',async()=>new Response(text,{headers:{'Content-Type':'application/json'}})),'fixture-browser-key');
 assert.equal(await googleMapsKey('build-key',async()=>new Response(null,{status:404})),'build-key');
 assert.equal(await googleMapsKey('',async()=>{throw new Error('Offline');}),'');
});

test('GOOGLE_API_KEY takes precedence at runtime without returning server secrets',async()=>{
 const env={GOOGLE_API_KEY:' primary-browser-key ',VITE_GOOGLE_MAPS_API_KEY:'legacy-browser-key',ANALYSIS_BEARER_TOKEN:'never-expose'};
 const response=await worker.fetch(new Request('https://geobound.test/api/map-config'),env);
 assert.deepEqual(await response.json(),{googleMapsApiKey:'primary-browser-key'});
 const fallback=await worker.fetch(new Request('https://geobound.test/api/map-config'),{GOOGLE_API_KEY:' ',VITE_GOOGLE_MAPS_API_KEY:'legacy'});
 assert.deepEqual(await fallback.json(),{googleMapsApiKey:'legacy'});
 assert.equal((await worker.fetch(new Request('https://geobound.test/api/map-config',{method:'POST'}),env)).status,405);
});

test('local map config matches hosted resolution and leaves other routes alone',async()=>{
 const { createMapConfigMiddleware }=await import('../server/map-config.js');
 const middleware=createMapConfigMiddleware({GOOGLE_API_KEY:'local-browser-key',ANALYSIS_BEARER_TOKEN:'server-only'});
 let next=false;middleware({url:'/',method:'GET'},{},()=>{next=true;});assert.equal(next,true);
 const result={};const res={writeHead(status,headers){Object.assign(result,{status,headers});},end(body){result.body=JSON.parse(body);}};
 middleware({url:'/api/map-config',method:'GET'},res,()=>assert.fail('Unexpected fallthrough'));
 assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store');
 assert.deepEqual(result.body,{googleMapsApiKey:'local-browser-key'});
 middleware({url:'/api/map-config',method:'POST'},res,()=>assert.fail('Unexpected fallthrough'));
 assert.equal(result.status,405);assert.deepEqual(result.body,{detail:'Only GET is supported'});
});
