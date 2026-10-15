import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';
import {placeDistributionEquipment,EQUIPMENT_PLACEMENT} from '../src/simulation/equipment-placement.js';
import {geospatialNetwork} from '../src/simulation/geospatial-network.js';
import {distributionPlan,nearbyDetails} from '../src/simulation/distribution-geometry.js';
const M=111320,cos=Math.cos(34*Math.PI/180),distance=(a,b)=>Math.hypot((a[0]-b[0])*M*Math.cos((a[1]+b[1])*Math.PI/360),(a[1]-b[1])*M);
const node=(id,x,y,extra={})=>({id,x,y,point:[-118+x/(M*cos),34+y/M],direction:[1,0],supported:true,...extra});
test('dense generated support groups are removed in full, while ordinary spacing and recorded supports survive',()=>{
 const dense=Array.from({length:40},(_,i)=>node(i,5*Math.cos(i/40*2*Math.PI),5*Math.sin(i/40*2*Math.PI)));
 const ordinary=[node(40,60,0),node(41,115,0)],recorded=node(42,0,0,{recordedSupport:true});
 const input=[...dense,...ordinary,recorded],before=JSON.stringify(input);
 const plan=placeDistributionEquipment(input,[],{metersPerLongitude:M*cos});
 assert.deepEqual(plan.nodes,[...ordinary,recorded]);assert.equal(plan.placement.densePoleClusters,1);assert.equal(plan.placement.suppressedGeneratedPoles,40);
 assert.equal(JSON.stringify(input),before);
 const chain=Array.from({length:10},(_,i)=>node(i,i*5,0));
 assert.equal(placeDistributionEquipment(chain,[],{metersPerLongitude:M*cos}).nodes.length,0,'Entire connected cluster is hidden, including both ends');
});
test('padmount clearance includes standalone poles and pole-mounted transformers, preserves source points and is stable',()=>{
 const pole=node(0,0,0),mount=node(1,30,0,{supported:false}),padNode=node(2,0,0,{supported:false}),otherPad=node(3,30,0,{supported:false}),free=node(4,70,0,{supported:false});
 const transformers=[{id:'mount',node:mount,point:mount.point,mounted:true},{id:'pad1',node:padNode,point:padNode.point,mounted:false},{id:'pad2',node:otherPad,point:otherPad.point,mounted:false},{id:'free',node:free,point:free.point,mounted:false}],before=JSON.stringify(transformers);
 const plan=placeDistributionEquipment([pole,mount,padNode,otherPad,free],transformers,{metersPerLongitude:M*cos});
 for(const t of plan.transformers.filter(t=>!t.mounted))for(const p of [pole,mount])assert.ok(distance(t.displayPoint||t.point,p.point)>=EQUIPMENT_PLACEMENT.padClearance);
 assert.equal(plan.placement.offsetPadmounts,2);assert.equal(plan.placement.hiddenPadmounts,0);assert.equal(plan.transformers.at(-1).displayPoint,undefined);
 assert.equal(JSON.stringify(transformers),before);assert.deepEqual(plan,placeDistributionEquipment([pole,mount,padNode,otherPad,free],transformers,{metersPerLongitude:M*cos}));
});
test('actual CKT114 curve loses all 38 pole symbols and colliding GIS padmounts are separated without moving routes',()=>{
 const key='CKT_114_16955',read=kind=>JSON.parse(gunzipSync(readFileSync(new URL(`../public/simulation/${kind}/${key}.json.gz`,import.meta.url))));
 const geometry=geospatialNetwork(read('geometry'),read('models'),read('geospatial')),before=JSON.stringify(geometry),plan=distributionPlan(geometry.solver),center=[-118.13547035,34.09835455];
 assert.equal(plan.nodes.filter(n=>distance(n.point,center)<6).length,0,'No representative pole remains in the ring');
 assert.equal(plan.placement.densePoleClusters,15);assert.ok(plan.placement.suppressedGeneratedPoles>=506);assert.equal(plan.placement.hiddenPadmounts,0);
 const allPoles=[...plan.nodes,...plan.transformers.filter(t=>t.mounted).map(t=>t.node)];
 for(const t of plan.transformers.filter(t=>!t.mounted))for(const pole of allPoles)assert.ok(distance(t.displayPoint||t.point,pole.point)>=4,`${t.id} overlaps pole${pole.id}`);
 for(const id of [80254,148379,173390])assert.ok(plan.transformers.find(t=>t.id.endsWith(':'+id)).displayPoint);
 assert.equal(JSON.stringify(geometry),before);assert.equal(plan.entries.length,58);assert.equal(plan.transformers.length,67);
 for(const entry of plan.entries)for(const p of entry.feature.geometry.coordinates)assert.ok(plan.paths(entry)[0].some(q=>distance(p,q)<1e-6));
 for(const range of [400,800,1800])assert.ok(nearbyDetails(plan,{lng:center[0],lat:center[1]},range).poles.every(p=>distance(p.point,center)>=6));
});
