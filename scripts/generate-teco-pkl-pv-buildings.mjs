import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { individualFootprints, matchPvBuilding } from '../src/spatial/pv-buildings.js';

const sourcePath='data/solar/teco-models/teco-asymmetric-sgen.json';
const source=JSON.parse(await readFile(sourcePath,'utf8'));
assert.equal(source.selection,'all','Use the previously authorized all-generator extraction.');
// The browser receives only display records, never pickle files. Check that
// the verified extraction still represents the original models on disk.
for(const model of source.models) {
  const bytes=await readFile(resolve(source.source_directory,model.source_model));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),model.sha256,
    `Model changed: ${model.source_model}. Refresh scripts/extract-teco-sgen.py before generating this layer.`);
}
const manifest=JSON.parse(await readFile('public/data/osm/tampa-bay/manifest.json','utf8'));
const layer=manifest.layers.find(l=>l.id==='buildings');
const osmBytes=await readFile(`public/data/osm/tampa-bay/${layer.file}`);
const osm=JSON.parse(osmBytes);assert.equal(osm.features.length,layer.count);
const footprints=osm.features.flatMap(f=>individualFootprints(f,f.properties.id).map(part=>({
  ...part,properties:{osm_id:f.properties.id},
})));
const [w,s,e,n]=manifest.bounds;
const sites=source.records.filter(r=>r.longitude>=w&&r.longitude<=e&&r.latitude>=s&&r.latitude<=n)
  .map(r=>({...r,site_id:`pkl:${r.source_model}:${r.generator_id}`}));
assert.equal(new Set(sites.map(site=>site.site_id)).size,sites.length);
const buildings=new Map(),siteMatches=[];
for(const site of sites) {
  const match=matchPvBuilding(site,footprints);assert.ok(match);
  const id=match.footprint.id;
  if(!buildings.has(id)) buildings.set(id,{type:'Feature',id,geometry:match.footprint.geometry,properties:{
    key:id,osm_id:match.footprint.properties.osm_id,site_ids:[],color:'#ff0000',
    match_method:match.method,match_distance_m:match.distance,tie_resolved_by_area:match.tieResolvedByArea,
  }});
  const f=buildings.get(id);
  f.properties.site_ids.push(site.site_id);
  f.properties.match_distance_m=Math.max(f.properties.match_distance_m,match.distance);
  f.properties.tie_resolved_by_area ||= match.tieResolvedByArea;
  if(match.method==='nearest building') f.properties.match_method=match.method;
  siteMatches.push({site_id:site.site_id,building_key:id,osm_id:f.properties.osm_id,
    distance_m:match.distance,tie_resolved_by_area:match.tieResolvedByArea});
}
const summary={totalSites:sites.length,sourceTotalSites:source.records.length,
  sitesOutsideOsmCoverage:source.records.length-sites.length,buildingCount:buildings.size,
  sourceModelCount:source.models.length,sourceBuildingCount:layer.count,
  osmBounds:manifest.bounds,osmSource:`data/osm/tampa-bay/${layer.file}`,
  osmSourceSha256:createHash('sha256').update(osmBytes).digest('hex'),
  selection:'all asymmetric_sgen devices, as authorized',technology:'unclassified in model',
  locationBasis:'Connected bus latitude/longitude',color:'#ff0000',
  buildingMatchRule:'Nearest local OSM footprint; equal distances within 0.01m select the larger building.',
  generatedAt:new Date().toISOString()};
await mkdir('public/data/solar',{recursive:true});
await writeFile('public/data/solar/teco-pkl-pv-buildings.json',JSON.stringify({schemaVersion:1,summary,sites,siteMatches,
  buildings:{type:'FeatureCollection',features:[...buildings.values()]}})+'\n');
await writeFile('public/data/solar/PKL-NOTICE.md','# TECO PKL PV display layer\n\nSource: the verified 63-model TECO extraction in data/solar/teco-models/teco-asymmetric-sgen.json. All asymmetric_sgen devices were included following the user’s clarification because model names contain no PV identifiers. Technology is unclassified in the models. Phase rows represent one device, not separate PV installations. Bus coordinates determine the nearest local OSM building. Model active power is operating generation, not installed PV capacity.\n\nFootprints are from data/osm/tampa-bay/buildings.geojson, © OpenStreetMap contributors, ODbL 1.0. Only records within the local OSM manifest coverage are included. Equal-distance matches use the larger footprint. Geographic association does not independently verify rooftop PV. The layer draws red building fills only. See NOTICE.md and the local OSM NOTICE for attribution and license links.\n');
console.log(JSON.stringify(summary,null,2));
