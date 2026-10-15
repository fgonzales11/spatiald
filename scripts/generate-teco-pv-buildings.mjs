import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { individualFootprints, matchPvBuilding, pvSizeColor, buildingCapacity } from '../src/spatial/pv-buildings.js';

const source = JSON.parse(await readFile('data/solar/panelcensus/teco/teco-sites.json','utf8'));
assert.equal(source.summary.detailPagesRead,source.summary.sitesFound);
const manifest = JSON.parse(await readFile('public/data/osm/tampa-bay/manifest.json','utf8'));
const layer = manifest.layers.find(layer=>layer.id==='buildings');
assert.ok(layer && layer.file==='buildings.geojson');
const bytes=await readFile(`public/data/osm/tampa-bay/${layer.file}`);
const osm=JSON.parse(bytes);
assert.equal(osm.features.length,layer.count);
const [w,s,e,n]=manifest.bounds;
const sites=source.records.filter(site=>site.longitude>=w && site.longitude<=e && site.latitude>=s && site.latitude<=n);
const footprints=osm.features.flatMap(feature=>individualFootprints(feature,feature.properties.id).map(part=>({
  ...part,properties:{osm_id:feature.properties.id},
})));
const buildings=new Map();
let tiedCount=0, insideCount=0, maximumDistance=0;
const siteMatches=[];
for(const site of sites) {
  // Offline matching against the complete existing Buildings layer. No radius
  // cutoff, circle substitute or external footprint source is used.
  const match=matchPvBuilding(site,footprints);
  assert.ok(match,`No OSM building for ${site.site_id}`);
  const id=match.footprint.id;
  if(!buildings.has(id)) buildings.set(id,{type:'Feature',id,geometry:match.footprint.geometry,properties:{
    key:id,osm_id:match.footprint.properties.osm_id,site_ids:[],match_method:match.method,
    match_distance_m:match.distance,tie_resolved_by_area:match.tieResolvedByArea,
  }});
  const building=buildings.get(id);
  building.properties.site_ids.push(site.site_id);
  if(match.method==='nearest building') building.properties.match_method=match.method;
  building.properties.match_distance_m=Math.max(building.properties.match_distance_m,match.distance);
  building.properties.tie_resolved_by_area ||= match.tieResolvedByArea;
  tiedCount+=match.tieResolvedByArea;
  insideCount+=match.method==='location inside building';
  maximumDistance=Math.max(maximumDistance,match.distance);
  siteMatches.push({site_id:site.site_id,building_key:id,osm_id:building.properties.osm_id,
    distance_m:match.distance,tie_resolved_by_area:match.tieResolvedByArea});
}
const byId=new Map(sites.map(site=>[site.site_id,site]));
for(const building of buildings.values()) {
  const size=buildingCapacity(building.properties.site_ids.map(id=>byId.get(id)));
  Object.assign(building.properties,{size_kw:size,color:pvSizeColor(size)});
}
const features=[...buildings.values()];
const summary={totalSites:sites.length,sourceTotalSites:source.records.length,
  sitesOutsideOsmCoverage:source.records.length-sites.length,
  sitesWithSize:sites.filter(site=>site.system_size_kw!==null).length,
  sitesWithoutSize:sites.filter(site=>site.system_size_kw===null).length,
  matchedSiteCount:sites.length,buildingCount:features.length,
  buildingsWithSize:features.filter(feature=>feature.properties.size_kw!==null).length,
  sourceBuildingCount:layer.count,osmBounds:manifest.bounds,osmSource:`data/osm/tampa-bay/${layer.file}`,
  osmSourceSha256:createHash('sha256').update(bytes).digest('hex'),
  locationsInsideBuilding:insideCount,tiesResolvedByLargerBuilding:tiedCount,maximumMatchDistanceM:maximumDistance,
  buildingMatchRule:'Nearest local OSM building footprint; equal distances within 0.01m use the larger footprint.',
  buildingMatchTieToleranceM:0.01,capacityAggregation:'Largest reported record per building; permit sizes are not added.',
  generatedAt:new Date().toISOString()};
await mkdir('public/data/solar',{recursive:true});
await writeFile('public/data/solar/teco-pv-buildings.json',JSON.stringify({schemaVersion:1,summary,sites,siteMatches,
  buildings:{type:'FeatureCollection',features}})+'\n');
await writeFile('public/data/solar/NOTICE.md','# TECO public solar buildings\n\nSite facts: [PanelCensus TECO public search](https://panelcensus.com/sites?operator=Tampa%20Electric%20Co); individual source URLs are retained. Missing sizes use base yellow.\n\nFootprints come exclusively from the existing local OSM Buildings layer (`data/osm/tampa-bay/buildings.geojson`), and only public solar sites within its manifest coverage are included. See the OSM layer NOTICE and manifest for source provenance. Building geometry © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), [copyright](https://www.openstreetmap.org/copyright).\n\nEach site is assigned to the nearest footprint in that complete local layer. Equal distances within 0.01 metres select the larger footprint. Building associations are spatial matches, not verification of rooftop PV. Multiple records on a building use the largest reported size and retain every source record. No circle symbols are drawn.\n');
console.log(JSON.stringify(summary,null,2));
