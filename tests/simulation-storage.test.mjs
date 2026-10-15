import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {simulationStorage} from '../worker/simulation-storage.js';
const revision='a'.repeat(64),file='models/CKT_1001_15510.json.gz';
function memoryBucket(){const objects=new Map();return {objects,async head(key){return objects.has(key)?{key}:null;},async put(key,value,options){objects.set(key,{value,options});},async get(key){const value=objects.get(key);return value?{body:value.value,size:value.value.byteLength,httpEtag:'"test"'}:null;},async list({prefix}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}};}
function batch(path=file){const bytes=Buffer.from('compressed-fixture');const header=Buffer.from(JSON.stringify([{path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]));const size=Buffer.alloc(4);size.writeUInt32LE(header.length);return Buffer.concat([size,header,bytes]);}
const request=(action,body,authorized=true)=>new Request(`https://site.example/api/simulation-assets/${action}?revision=${revision}`,{method:'POST',headers:authorized?{authorization:'Bearer owner-only-fixture'}:{},body});
test('model storage blocks public writes, verifies owner imports and seals complete immutable revisions',async()=>{
 const bucket=memoryBucket(),env={BUCKET:bucket,SIMULATION_IMPORT_TOKEN:'owner-only-fixture',ASSETS:{fetch:async()=>Response.json({storage_revision:revision,networks:[]})}};
 const catalog=()=>simulationStorage(new Request('https://site.example/simulation/catalog.json'),env);
 assert.equal((await catalog()).status,503);
 assert.equal((await simulationStorage(request('import',batch(),false),env)).status,404);assert.equal(bucket.objects.size,0);
 assert.equal((await simulationStorage(request('import',batch('../other')),env)).status,400);assert.equal(bucket.objects.size,0);
 assert.equal((await simulationStorage(request('import',batch()),env)).status,200);
 assert.equal((await simulationStorage(request('complete',JSON.stringify({count:2})),env)).status,409);
 assert.equal((await simulationStorage(request('complete',JSON.stringify({count:1})),env)).status,200);
 assert.equal((await catalog()).status,200);
 assert.equal((await simulationStorage(request('import',batch()),env)).status,409);
 const response=await simulationStorage(new Request(`https://site.example/simulation/data/${revision}/${file}`),env);
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/gzip');assert.equal(await response.text(),'compressed-fixture');
 assert.equal((await simulationStorage(request('import',batch()),{...env,SIMULATION_IMPORT_TOKEN:undefined})).status,404);
});
