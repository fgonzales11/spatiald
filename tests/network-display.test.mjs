import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';
import {geospatialNetwork} from '../src/simulation/geospatial-network.js';
import {flowPaths,flowHeads,flowTrail,flowPoints,dashPath} from '../src/simulation/flow-animation.js';
import {distributionMetadata,distributionPlan} from '../src/simulation/distribution-geometry.js';
const read=(kind,key)=>JSON.parse(gunzipSync(readFileSync(new URL(`../public/simulation/${kind}/${key}.json.gz`,import.meta.url))));
const distance=(a,b)=>Math.hypot((a[0]-b[0])*92000,(a[1]-b[1])*111320);
test('CKT 114 uses the complete GIS reference route and recorded equipment; PKL placement is ignored',()=>{
 const input=read('geometry','CKT_114_16955'),model=read('models','CKT_114_16955'),reference=read('geospatial','CKT_114_16955');
 const before=JSON.stringify(reference),rendered=geospatialNetwork(input,model,reference);
 const lines=rendered.solver.features.filter(f=>f.properties.kind==='line');
 const recorded=reference.reference_routes.features.flatMap(f=>f.geometry.type==='MultiLineString'?f.geometry.coordinates:[f.geometry.coordinates]);
 assert.equal(lines.length,58);assert.deepEqual(lines.map(f=>f.geometry.coordinates.map(p=>p.slice(0,2))),recorded);
 assert.equal(rendered.provenance.physical_lines,130);assert.equal(rendered.provenance.physical_buses,454);
 const devices=rendered.solver.features.filter(f=>f.properties.kind!=='line');assert.equal(devices.length,reference.equipment.features.length);
 assert.deepEqual(devices.map(f=>f.geometry.coordinates[0].slice(0,2)),reference.equipment.features.map(f=>f.geometry.coordinates));
 assert.equal(rendered.provenance.inferred_bus_positions,0);assert.equal(rendered.provenance.schematic_layout_buses,0);
 assert.deepEqual(rendered,geospatialNetwork({...input,solver:{features:[]}},model,reference));assert.equal(JSON.stringify(reference),before);
 const plan=distributionPlan(rendered.solver);assert.equal(plan.entries.length,58);assert.equal(plan.transformers.length,67);
 for(const entry of plan.entries){const path=plan.paths(entry)[0];for(const p of entry.feature.geometry.coordinates)assert.ok(path.some(q=>distance(p,q)<1e-6),'Source route vertices retained in 3D');}
});
test('GIS placement rejects missing routes and mismatched identities instead of falling back to invented positions',()=>{
 assert.throws(()=>geospatialNetwork({circuit_key:'a'},{circuit_key:'a'},{circuit_key:'a'}),/No GIS reference route/);
 assert.throws(()=>geospatialNetwork({circuit_key:'a'},{circuit_key:'b'},{circuit_key:'a'}),/identities differ/);
});
const feature=(id,power,current=1)=>({id,properties:{flow_current:current,flow_power:power},geometry:{type:'LineString',coordinates:[[0,0,15],[.00045,0,14],[.00045,.00045,15]]}});
test('flow direction requires real nonzero solved power and current; density and movement match DI',()=>{
 const paths=flowPaths({features:[feature('forward',1),feature('reverse',-1),feature('zero',0),feature('unknown',null),feature('no-current',1,0)]});
 assert.equal(paths.length,2);assert.deepEqual(paths.map(p=>p.direction),[1,-1]);
 const a=flowHeads(paths,0),b=flowHeads(paths,1);assert.ok(Math.abs(b[0].distance-a[0].distance-10)<1e-9);assert.ok(Math.abs(b[1].distance-a[1].distance+10)<1e-9);
 const many=flowPaths({features:Array.from({length:1000},(_,i)=>feature(i,1))});assert.ok(many.reduce((n,p)=>n+p.count,0)<=240);assert.ok(many.at(-1).id>990);
 const dots=flowPoints(paths,0);assert.equal(dots.length,6);assert.deepEqual(dots.slice(0,3).map(p=>p.alpha),[.85,.5,.22]);
});
test('flow tails retain bends and stop at terminals instead of streaking across wraparound',()=>{
 const [path]=flowPaths({features:[feature('bend',1)]});
 const nearStart=flowTrail(path,.2);assert.ok(nearStart.every(p=>distance(p,path.points[0])<.3));
 assert.equal(flowTrail(path,.2,2),null);
 const beyondBend=flowTrail(path,path.distances[1]+.3);assert.ok(beyondBend.some(p=>p===path.points[1]));
 const reverse={...path,direction:-1};const nearEnd=flowTrail(reverse,path.length-.2);assert.deepEqual(nearEnd.at(-1),path.points.at(-1));
 assert.ok(nearEnd.every(p=>distance(p,path.points.at(-1))<.3));
 const dashes=dashPath(path.points);assert.ok(dashes.length>2&&dashes.every(p=>p.length>=2));
});
test('GIS switch keeps its actual point, uses exact structure state, and includes its support pole',()=>{
 const key='CKT_1040_18076',reference=read('geospatial',key),network=geospatialNetwork(read('geometry',key),read('models',key),reference);
 const feature=network.solver.features.find(f=>f.properties.structure_number==='828853E');assert.equal(feature.properties.closed,true);
 const plan=distributionPlan(network.solver),device=plan.switches.find(s=>s.id===feature.id);assert.equal(device.closed,true);assert.ok(plan.nodes.includes(device.node));
 assert.deepEqual(device.point,reference.equipment.features.find(f=>f.id===feature.id).geometry.coordinates);
});
