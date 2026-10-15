import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pvSizeColor, PV_UNKNOWN_COLOR, PV_SIZE_BINS, pointInFootprint, individualFootprints, matchPvBuilding, buildingCapacity } from '../src/spatial/pv-buildings.js';

const polygon = (x=0, y=0) => ({type:'Polygon',coordinates:[[[x,y],[x+.0001,y],[x+.0001,y+.0001],[x,y+.0001],[x,y]]]});
const footprint = (id,x=0,y=0) => ({type:'Feature',id,geometry:polygon(x,y),properties:{}});
const site = (longitude,latitude) => ({longitude,latitude,location_description:'Residential'});

test('missing capacities use base yellow and never become zero-sized systems', () => {
  assert.equal(pvSizeColor(null),PV_UNKNOWN_COLOR);
  assert.equal(pvSizeColor(undefined),PV_UNKNOWN_COLOR);
  assert.equal(pvSizeColor(NaN),PV_UNKNOWN_COLOR);
  for(const [size,bin] of [[0,0],[5,0],[5.1,1],[10,1],[10.1,2],[25,2],[25.1,3],[100,3],[101,4]]) assert.equal(pvSizeColor(size),PV_SIZE_BINS[bin].color);
  assert.equal(buildingCapacity([{system_size_kw:null}]),null);
  assert.equal(buildingCapacity([{system_size_kw:12},{system_size_kw:12},{system_size_kw:5}]),12);
});
test('courtyard holes and disjoint tiled roofs are handled individually', () => {
  const geometry=polygon();geometry.coordinates.push([[.00002,.00002],[.00008,.00002],[.00008,.00008],[.00002,.00008],[.00002,.00002]]);
  assert.equal(pointInFootprint([.00001,.00001],geometry),true);
  assert.equal(pointInFootprint([.00005,.00005],geometry),false);
  const components=individualFootprints({geometry:{type:'MultiPolygon',coordinates:[polygon().coordinates,polygon(.01,.01).coordinates]}},'group');
  assert.equal(components.length,2);
  const match=matchPvBuilding(site(.00005,.00005),components);
  assert.equal(match.footprint.id,'group:0');
  assert.equal(match.footprint.geometry.type,'Polygon');
});
test('nearest matching resolves equal distances using the larger building, without a radius cutoff', () => {
  const a=footprint('a'),b=footprint('b',.0002);
  assert.equal(matchPvBuilding(site(.00005,.00005),[a,b]).method,'location inside building');
  assert.equal(matchPvBuilding(site(.00012,.00005),[a,b]).footprint.id,'a');
  const larger=footprint('larger',.0002);larger.geometry.coordinates[0]=[[.0002,0],[.0004,0],[.0004,.0002],[.0002,.0002],[.0002,0]];
  const tie=matchPvBuilding(site(.00015,.00005),[a,larger]);
  assert.equal(tie.footprint.id,'larger');assert.equal(tie.tieResolvedByArea,true);
  assert.equal(matchPvBuilding(site(.001,.001),[a,b]).footprint.id,'b');
});
test('shipped solar layer accounts for every public record and retains unknown-size yellow', async () => {
  const data=JSON.parse(await readFile(new URL('../public/data/solar/teco-pv-buildings.json',import.meta.url),'utf8'));
  assert.equal(data.sites.length,114);
  assert.equal(data.summary.sitesWithSize,36);
  assert.equal(data.summary.sourceTotalSites,1112);
  assert.equal(data.points,undefined);
  const sites=new Map(data.sites.map(s=>[s.site_id,s]));
  assert.equal(sites.size,114);
  const osm=JSON.parse(await readFile(new URL('../public/data/osm/tampa-bay/buildings.geojson',import.meta.url),'utf8'));
  const footprints=new Map(osm.features.flatMap(f=>individualFootprints(f,f.properties.id)).map(f=>[f.id,f]));
  const ids=[];
  for(const f of data.buildings.features) {
    const records=f.properties.site_ids.map(id=>sites.get(id));assert.ok(records.every(Boolean));
    assert.equal(f.properties.size_kw,buildingCapacity(records));
    assert.equal(f.properties.color,pvSizeColor(f.properties.size_kw));
    assert.equal(f.geometry.type,'Polygon');
    assert.deepEqual(f.geometry,footprints.get(f.id).geometry);
    ids.push(...f.properties.site_ids);
  }
  assert.equal(ids.length,114);assert.equal(new Set(ids).size,114);
  const [w,s,e,n]=data.summary.osmBounds;
  for(const site of sites.values()) assert.ok(site.longitude>=w && site.longitude<=e && site.latitude>=s && site.latitude<=n);
});
