import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { individualFootprints } from '../src/spatial/pv-buildings.js';

test('PKL layer preserves model/bus identities, colors only OSM footprints red, and accounts for every scoped generator',async()=>{
  const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
  const data=await read('../public/data/solar/teco-pkl-pv-buildings.json');
  const source=await read('../data/solar/teco-models/teco-asymmetric-sgen.json');
  const osm=await read('../public/data/osm/tampa-bay/buildings.geojson');
  const [w,s,e,n]=data.summary.osmBounds;
  const scoped=source.records.filter(r=>r.longitude>=w&&r.longitude<=e&&r.latitude>=s&&r.latitude<=n);
  assert.equal(data.summary.totalSites,463);assert.equal(data.summary.buildingCount,462);
  assert.equal(data.summary.sourceTotalSites,883);assert.equal(data.points,undefined);
  assert.equal(data.sites.length,scoped.length);
  const byIdentity=new Map(scoped.map(r=>[`pkl:${r.source_model}:${r.generator_id}`,r]));
  for(const site of data.sites) {
    const {site_id,...record}=site;assert.deepEqual(record,byIdentity.get(site_id));
  }
  const footprints=new Map(osm.features.flatMap(f=>individualFootprints(f,f.properties.id)).map(f=>[f.id,f]));
  const ids=[];
  for(const f of data.buildings.features) {
    assert.equal(f.properties.color,'#ff0000');assert.equal(f.geometry.type,'Polygon');
    assert.deepEqual(f.geometry,footprints.get(f.id).geometry);
    for(const id of f.properties.site_ids) assert.ok(byIdentity.has(id));
    ids.push(...f.properties.site_ids);
  }
  assert.equal(ids.length,463);assert.equal(new Set(ids).size,463);
  assert.equal(data.siteMatches.length,463);
  assert.ok(data.siteMatches.every(m=>Number.isFinite(m.distance_m)&&m.distance_m>=0));
});
