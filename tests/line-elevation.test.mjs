import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDisplayOptions, lineHeightNote } from '../src/spatial/line-elevation.js';

const path = [[-82.55,28],[-82.549,28.001]];
const asset = (assetType='transmission_line', attributes={}, coordinates=path) => ({
  assetType, attributes, geometry:{type:'LineString',coordinates},
});

test('transmission display is raised relative to terrain without changing source coordinates',()=>{
 const source=asset(),before=JSON.stringify(source);
 const options=lineDisplayOptions(source,path);
 assert.equal(options.altitudeMode,'RELATIVE_TO_GROUND');
 assert.deepEqual(options.path,[{lng:-82.55,lat:28,altitude:24},{lng:-82.549,lat:28.001,altitude:24}]);
 assert.equal(JSON.stringify(source),before);
 assert.match(lineHeightNote(source),/24 m above ground.*display estimate/);
});

test('coordinate elevations take precedence and different multipart paths keep their own altitude reference',()=>{
 const elevated=[[-82.55,28,125],[-82.549,28.001,131]];
 const source=asset('transmission_line',{heightAboveGroundM:40},elevated);
 const options=lineDisplayOptions(source,elevated);
 assert.equal(options.altitudeMode,'ABSOLUTE');
 assert.deepEqual(options.path.map(p=>p.altitude),[125,131]);
 assert.equal(lineHeightNote(source),'Using supplied coordinate elevations.');
 source.geometry={type:'MultiLineString',coordinates:[elevated,path]};
 assert.equal(lineDisplayOptions(source,path).altitudeMode,'RELATIVE_TO_GROUND');
 assert.equal(lineDisplayOptions(source,path).path[0].altitude,40);
 assert.match(lineHeightNote(source),/40 m above ground.*supplied height/);
});

test('explicit source heights override display defaults and incomplete elevations do not mix datums',()=>{
 for(const key of ['heightAboveGroundM','conductorHeightM']) {
  const source=asset('transmission_line',{[key]:35});
  assert.equal(lineDisplayOptions(source,path).path[0].altitude,35);
  assert.match(lineHeightNote(source),/supplied height/);
 }
 for(const invalid of [-10,NaN,Infinity,'120 ft'])
  assert.equal(lineDisplayOptions(asset('transmission_line',{heightAboveGroundM:invalid}),path).path[0].altitude,24);
 const mixed=[[-82.55,28,125],[-82.549,28.001]];
 assert.deepEqual(lineDisplayOptions(asset(),mixed).path.map(p=>p.altitude),[24,24]);
 assert.equal(lineDisplayOptions(asset('overhead_line'),path).path[0].altitude,14);
});

test('gas, context, and known underground construction are not raised as overhead transmission',()=>{
 for(const type of ['gas_main','water_main',undefined]) {
  const source=type?asset(type):undefined;
  assert.equal(lineDisplayOptions(source,path).altitudeMode,'CLAMP_TO_GROUND');
 }
 for(const construction of ['UNDERGROUND','Underground AC','Submarine','Buried','U/G']) {
  const source=asset('transmission_line',{construction});
  assert.equal(lineDisplayOptions(source,path).altitudeMode,'CLAMP_TO_GROUND');
  assert.match(lineHeightNote(source),/Underground route/);
 }
 assert.equal(lineDisplayOptions(asset('transmission_line',{sourceAttributes:{TYPE:'UNDERGROUND'}}),path).altitudeMode,'CLAMP_TO_GROUND');
});
