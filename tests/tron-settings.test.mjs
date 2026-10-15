import test from 'node:test';
import assert from 'node:assert/strict';
import {tronPreferences,applyTronSettings} from '../src/spatial/tron-settings.js';
import {tronStyle} from '../src/spatial/tron-style.js';
test('TRON settings recover defaults while preserving explicit false values',()=>{
  for(const value of [null,undefined,[],{animated:'false'}])assert.deepEqual(tronPreferences(value),{transit:true,buildings:true,animated:false,interactive:true});
  assert.equal(tronPreferences({animated:true}).animated,false);
  assert.deepEqual(tronPreferences({transit:false,buildings:false,animated:false,interactive:false,other:true}),{transit:false,buildings:false,animated:false,interactive:false});
});
test('TRON settings independently control transit, buildings and gestures without replacing map data',()=>{
  const style=tronStyle({sources:{osm:{type:'vector'}},layers:[]}), layers=new Map(style.layers.map(l=>[l.id,l])),host={dataset:{}},calls=[];
  const map={getLayer:id=>layers.get(id),setLayoutProperty:(id,key,value)=>calls.push([id,key,value]),getContainer:()=>host,getCanvas:()=>({setAttribute(){}})};
  const handlers=['dragPan','dragRotate','scrollZoom','boxZoom','keyboard','doubleClickZoom','touchZoomRotate','touchPitch'];
  for(const key of handlers)map[key]={enable:()=>calls.push([key,true]),disable:()=>calls.push([key,false])};
  applyTronSettings(map,{transit:false,buildings:false,interactive:false});
  for(const id of ['tron-transit','tron-transit-glow','tron-buildings'])assert.ok(calls.some(c=>c[0]===id&&c[2]==='none'));
  for(const key of handlers)assert.ok(calls.some(c=>c[0]===key&&c[1]===false));
  assert.deepEqual(layers.get('tron-roads').filter,['!',layers.get('tron-transit').filter]);
  assert.equal(host.dataset.tronBuildingsEnabled,'false');
  calls.length=0;applyTronSettings(map,{});
  for(const id of ['tron-transit','tron-transit-glow','tron-buildings'])assert.ok(calls.some(c=>c[0]===id&&c[2]==='visible'));
  for(const key of handlers)assert.ok(calls.some(c=>c[0]===key&&c[1]===true));
});
