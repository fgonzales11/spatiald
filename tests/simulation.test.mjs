import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resultIndex,simulationFeatures,createSimulation2D,createSimulation3D} from '../src/simulation/map-layer.js';

test('phase currents aggregate by physical line, retaining reverse flow and no-current branches',()=>{
  const index=resultIndex({solved:true,tables:{res_line:[{index:7,circuit:0,p_from_mw:null,i_ka:null},{index:7,circuit:1,p_from_mw:-.2,i_ka:.12},{index:7,circuit:2,p_from_mw:-.1,i_ka:.08},{index:8,p_from_mw:0,i_ka:0}]}});
  assert.equal(index.get('7').current,.12);assert.ok(Math.abs(index.get('7').power+.3)<1e-10);
  assert.equal(index.get('8').current,0);assert.equal(resultIndex({solved:false,tables:{res_line:[{index:7,i_ka:99}]}}).size,0);
});
const feature={type:'Feature',id:'line:7',properties:{kind:'line',index:7,from_bus:1,to_bus:2,in_service:true},geometry:{type:'LineString',coordinates:[[-118,34,10],[-118.001,34.001,10]]}};
test('only converged results energize current; failure is red and one visibility control removes all geometry',()=>{
  const layer={visible:true,status:'converged',topology:'solver',geometry:{solver:{type:'FeatureCollection',features:[feature]}},result:{solved:true,tables:{res_line:[{index:7,p_from_mw:-1,i_ka:.2}]}}};
  const p=simulationFeatures(layer).features[0].properties;
  assert.equal(p.color,'#3dff96');assert.equal(p.flow_direction,-1);assert.equal(p.flow_current,.2);assert.equal(p.glowing,true);
  assert.equal(simulationFeatures({...layer,visible:false}).features.length,0);
  assert.equal(simulationFeatures({...layer,status:'nonconverged',result:{solved:false}}).features[0].properties.color,'#ff4c61');
  assert.equal(simulationFeatures({...layer,status:'nonconverged',result:{solved:false}}).features[0].properties.flow_current,0);
});
test('native 3D uses steady result glow without animation and removes all network elements',async()=>{
  let frames=[];globalThis.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};globalThis.cancelAnimationFrame=()=>{};
  class Polyline {constructor(value){assert.ok(value.path.length>=2);Object.assign(this,value);this.dataset={};}remove(){this.removed=true;}}
  const elements=[];const map={append:e=>elements.push(e)};
  const renderer=createSimulation3D(map,{Polyline3DElement:Polyline});
  await renderer.set({circuit_key:'test',visible:true,topology:'solver',status:'converged',geometry:{solver:{type:'FeatureCollection',features:[feature]}},result:{solved:true,tables:{res_line:[{index:7,p_from_mw:1,i_ka:.2}]}}});
  assert.equal(elements.filter(e=>e.dataset.simulationFlow).length,0);
  assert.ok(elements.length>0);assert.ok(elements.some(e=>e.outerWidth>0));
  assert.equal(frames.length,0);
  renderer.dispose();assert.ok(elements.every(e=>e.removed));
});
test('2D draws steady success and failure glow without a particle source or animation frame',async()=>{
  const sources=new Map(),layers=[];let frames=0;globalThis.requestAnimationFrame=()=>++frames;
  const map={isStyleLoaded:()=>true,on(){},off(){},getSource:id=>sources.get(id),addSource(id,value){sources.set(id,{data:value.data,setData(data){this.data=data;}});},addLayer:layer=>layers.push(layer)};
  const renderer=createSimulation2D(map),state={circuit_key:'test',visible:true,topology:'solver',status:'converged',geometry:{solver:{features:[feature]}},result:{solved:true,tables:{res_line:[{index:7,p_from_mw:1,i_ka:.2}]}}};
  await renderer.set(state);
  assert.equal(sources.size,1);assert.equal(layers.length,2);assert.equal(frames,0);
  assert.ok(layers.some(layer=>layer.id.endsWith('-glow')));
  assert.equal(sources.get('sce-simulation-network').data.features[0].properties.glowing,true);
  await renderer.set({...state,status:'nonconverged',result:{solved:false}});
  const failed=sources.get('sce-simulation-network').data.features[0].properties;
  assert.equal(failed.glowing,true);assert.equal(failed.color,'#ff4c61');assert.equal(frames,0);
  await renderer.set({...state,visible:false});assert.equal(sources.get('sce-simulation-network').data.features.length,0);
  renderer.dispose();
});
test('network transfer accepts both raw gzip and already-decoded transport, and rejects changed data',async()=>{
  globalThis.location={origin:'https://simulation.invalid'};
  const {fetchDocument}=await import('../src/simulation/controller.js');
  const bytes=Buffer.from('{"circuit_key":"test"}');const hash=createHash('sha256').update(bytes).digest('hex');const original=globalThis.fetch;
  try{
    for(const body of [gzipSync(bytes),bytes]){
      globalThis.fetch=async()=>new Response(body);
      const doc=await fetchDocument('models/test.json.gz',hash);assert.equal(doc.value.circuit_key,'test');
    }
    globalThis.fetch=async()=>new Response('{"modified":true}');
    await assert.rejects(fetchDocument('models/test.json.gz',hash),/integrity/);
    await assert.rejects(fetchDocument('https://other.invalid/model',hash),/Invalid network/);
  }finally{globalThis.fetch=original;}
});
test('catalog binds its actual solver and runtime, exposes unique model keys, and defaults to solver topology',async()=>{
  const base=new URL('../public/simulation/',import.meta.url),catalog=JSON.parse(await readFile(new URL('catalog.json',base)));
  assert.equal(catalog.default_topology,'solver');assert.equal(new Set(catalog.networks.map(n=>n.circuit_key)).size,catalog.networks.length);
  for(const [file,hash]of [['multiconductor.zip',catalog.solver_sha256],['solver_runtime.py',catalog.runtime_sha256]])assert.equal(createHash('sha256').update(await readFile(new URL(file,base))).digest('hex'),hash);
  assert.ok(catalog.networks.filter(n=>n.available).every(n=>n.model_sha256&&n.geometry_sha256&&n.bounds.length===4));
});
test('cancelling a load during camera flight clears the model and cannot enable Run later',async()=>{
  globalThis.location={origin:'https://simulation.invalid'};
  const {createSimulationController}=await import('../src/simulation/controller.js');
  const model=Buffer.from(JSON.stringify({circuit_key:'test'}));
  const geometry=Buffer.from(JSON.stringify({circuit_key:'test',bounds:[-118,33,-117,34]}));
  const reference=Buffer.from(JSON.stringify({circuit_key:'test',reference_routes:{features:[feature]},equipment:{features:[]}}));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const catalog={networks:[{circuit_key:'test',available:true,model_url:'models/test.json.gz',model_sha256:hash(model),geometry_url:'geometry/test.json.gz',geometry_sha256:hash(geometry)}]};
  const previous=globalThis.fetch;
  let entered,finish;const focusEntered=new Promise(resolve=>entered=resolve),flight=new Promise(resolve=>finish=resolve);
  globalThis.fetch=async url=>new Response(String(url).endsWith('catalog.json')?JSON.stringify(catalog):String(url).endsWith('geospatial/index.json')?JSON.stringify({networks:[{circuit_key:'test',url:'geospatial/test.json.gz',sha256:hash(reference)}]}):String(url).includes('/geospatial/')?reference:String(url).includes('/models/')?model:geometry);
  const controller=createSimulationController({onLayer:()=>{},onFocus:()=>{entered();return flight;}});
  try{
    await controller.catalog();controller.select('test');const loading=controller.load();await focusEntered;
    assert.equal(controller.getState().status,'loading');assert.ok(controller.getState().geometry);
    controller.cancel();finish();await loading;
    assert.equal(controller.getState().status,'idle');assert.equal(controller.getState().loadedKey,'');assert.equal(controller.getState().geometry,null);
  }finally{controller.dispose();globalThis.fetch=previous;}
});


import {construction,distributionMetadata,distributionPlan,nearbyDetails,DISTRIBUTION_STYLE} from '../src/simulation/distribution-geometry.js';
test('blank line types use source conductor labels, preserve cables and flag unspecified construction',()=>{
  assert.equal(construction({__float__:'nan'},'4_ACSR_1PH_4KV').construction,'overhead');
  for(const label of ['1/0_JCN_3PH_12KV','2_CLP_2PH_12KV','500_EPR_3PH'])assert.equal(construction(null,label).construction,'underground');
  assert.match(construction(null,'4_CU_1PH').construction_basis,/unspecified/);
  const model={tables:{line:{columns:['std_type','type','from_phase'],index:[[7,0],[7,1],[7,2],[7,3]],data:[["ACSR",null,0],["ACSR",null,1],["ACSR",null,2],["ACSR",null,3]]}}};
  const geo=distributionMetadata({solver:{features:[feature]}},model);
  assert.deepEqual(geo.solver.features[0].properties.phases,[1,2,3]);
  assert.equal(geo.solver.features[0].properties.construction,'overhead');assert.equal(feature.properties.construction,undefined);
});
test('story-map conductors meet shared crossarm insulators, sag above terrain, and cables stay grounded',()=>{
  const a={...feature,properties:{...feature.properties,construction:'overhead',phases:[1,2,3]}};
  const b={...a,id:'line:8',properties:{...a.properties,index:8,from_bus:2,to_bus:3},geometry:{type:'LineString',coordinates:[feature.geometry.coordinates[1],[-118.001,34.002,0]]}};
  const c={...b,id:'cable',properties:{...b.properties,from_bus:3,to_bus:4,construction:'underground'},geometry:{type:'LineString',coordinates:[[-118.001,34.002,0],[-118.001,34.003,0]]}};
  const plan=distributionPlan({features:[a,b,c]});const routes=plan.paths(plan.entries[0],true);
  assert.equal(routes.length,3);for(const path of routes){assert.equal(path[0][2],15.1);assert.equal(path.at(-1)[2],15.1);assert.ok(path.some(p=>p[2]<15.1));assert.ok(path.every(p=>p[2]>=14));}
  assert.deepEqual(routes[0].at(-1),plan.paths(plan.entries[1],true)[0][0]);
  assert.ok(plan.paths(plan.entries[2],true)[0].every(p=>p[2]===.15));
  assert.ok(plan.nodes.length>3);assert.equal(nearbyDetails(plan,{lng:-118,lat:34},10000).poles.length,0);
  const nearby=nearbyDetails(plan,{lng:-118,lat:34},1000);assert.ok(nearby.poles.length>0&&nearby.poles.length<=DISTRIBUTION_STYLE.maxPoles);
});

test('source transformer connectors choose mounting and actual open switches retain an explicit break',()=>{
  const line=(id,a,b,construction)=>({...feature,id,properties:{kind:'line',from_bus:a,to_bus:b,construction},geometry:{type:'LineString',coordinates:[[-118,34+a*.0001,0],[-118,34+b*.0001,0]]}});
  const switchFeature={...line('s',1,2),properties:{kind:'switch',from_bus:1,to_bus:2,device_type:'lbs',closed:false}};
  const mount={...line('mount',2,3),properties:{kind:'switch',from_bus:2,to_bus:3,device_type:'ug_transformer',closed:true}};
  const transformer={...line('t',3,4),properties:{kind:'transformer',from_bus:3,to_bus:4}};
  const plan=distributionPlan({features:[line('l',0,1,'overhead'),switchFeature,mount,transformer]});
  assert.equal(plan.switches.length,1);assert.equal(plan.switches[0].closed,false);
  assert.equal(plan.transformers[0].mounted,false); // explicit source UG mounting wins over adjacent schematic OH.
  const paths=plan.paths(plan.entries[1]);assert.equal(paths.length,2);assert.notDeepEqual(paths[0].at(-1),paths[1][0]);
});
test('a stale asynchronous render failure cannot replace a newly selected circuit state',async()=>{
 globalThis.location={origin:'https://simulation.invalid'};const {createSimulationController}=await import('../src/simulation/controller.js');
 let reject;const failed=new Promise((_,no)=>reject=no);let calls=0;
 const controller=createSimulationController({onLayer:()=>++calls===1?failed:undefined});
 controller.select('a');await Promise.resolve();controller.select('b');reject(Error('old circuit failed'));await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(controller.getState().selectedKey,'b');assert.equal(controller.getState().status,'idle');assert.doesNotMatch(controller.getState().message,/old circuit/);controller.dispose();
});
