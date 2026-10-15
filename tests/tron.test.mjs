import test from 'node:test';import assert from 'node:assert/strict';import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {tronStyle,tronGrid} from '../src/spatial/tron-style.js';import {initialMapView} from '../src/spatial/map-mode.js';
test('TRON is a third vector view and persists without depending on a Google key',()=>{
 for(const googleConfigured of [true,false])assert.deepEqual(initialMapView({defaultMap:'tron',googleConfigured,nationalOverview:true}),{mode:'tron',showNationalOverview:false});
 assert.equal(initialMapView({defaultMap:'3d',googleConfigured:true,nationalOverview:true}).mode,'3d');
});
test('TRON style uses real vector buildings, preserves the source and omits place symbols',()=>{
 const base={version:8,sources:{osm:{type:'vector',tiles:['https://tiles.example/{z}/{x}/{y}.pbf']}},layers:[{id:'poi',type:'symbol',source:'osm','source-layer':'poi',layout:{'text-field':'POI'}}]};
 const original=JSON.stringify(base),style=tronStyle(base);
 assert.deepEqual(validateStyleMin(style),[]);assert.equal(JSON.stringify(base),original);
 assert.ok(style.layers.some(l=>l.type==='fill-extrusion'&&l['source-layer']==='building'));assert.ok(style.layers.some(l=>l.id==='tron-roads-glow'));
 assert.ok(!style.layers.some(l=>l['source-layer']==='poi'||l['source-layer']==='place'));
 const grid=tronGrid([-118,33,-117,34]);assert.ok(grid.features.length>10&&grid.features.length<=160);
 for(const f of grid.features)assert.ok(f.geometry.coordinates.flat().every(Number.isFinite));
});
