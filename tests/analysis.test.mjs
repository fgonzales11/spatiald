import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsPolygon } from '../src/analysis/api.js';
import { chartSpecification } from '../src/analysis/charts.js';
import { compile } from 'vega-lite';

test('analytical boundaries validate bounds and preserve polygon coordinates',()=>{
  assert.deepEqual(boundsPolygon([-82,27,-81,28]).coordinates[0][0],[-82,27]);
  assert.throws(()=>boundsPolygon([-82,28,-81,27]));
});

test('plots preserve gaps, reject summing indices, and compute denominator-weighted rates',()=>{
  assert.throws(()=>chartSpecification([{place:'a',saidi:10}],{y:'saidi',aggregate:'sum'}),/cannot be summed/);
  const spec=chartSpecification([{place:'a',n:1,d:2},{place:'a',n:9,d:10}],{x:'place',aggregate:'ratio',numerator:'n',denominator:'d'});
  assert.equal(spec.data.values[0].rate,10/12);
  const gaps=chartSpecification([{time:'2026-10-01T00:00:00Z',value:10},{time:'2026-10-02T00:00:00Z',value:null}],{type:'time-series',x:'time',y:'value'});
  assert.equal(gaps.data.values[1].value,null);
  for(const type of ['bar','time-series','histogram','scatter','forecast-band','scenario-difference']) {
    const chart=chartSpecification([{assetId:'a',assetType:'line',year:2026,lengthM:10,lower:8,upper:12,baseline:2,alternative:1}],{type,x:'year',y:'lengthM'});
    assert.ok(compile(chart).spec);
  }
});
