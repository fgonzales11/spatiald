import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {geospatialNetwork} from '../src/simulation/geospatial-network.js';
const base=new URL('../public/simulation/',import.meta.url),manifest=JSON.parse(await readFile(new URL('geospatial/index.json',base)));
const read=async path=>JSON.parse(gunzipSync(await readFile(new URL(path,base))));
const catalog=JSON.parse(await readFile(new URL('catalog.json',base)));
assert.deepEqual(new Set(manifest.networks.map(n=>n.circuit_key)),new Set(catalog.networks.filter(n=>n.available).map(n=>n.circuit_key)));
const report={circuits:0,fullReferences:0,partialReferences:[],routeParts:0,sourceVertices:0,equipment:0,checks:['all available circuits covered','every reference digest verified','every GIS route vertex preserved','every equipment coordinate preserved','all rendered features have GIS provenance','no original solver coordinates used','electrical source bytes unchanged']};
for(const entry of manifest.networks){
 const bytes=gunzipSync(await readFile(new URL(entry.url,base)));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.equal(bytes.length,entry.bytes);
 const reference=JSON.parse(bytes),key=entry.circuit_key,model=await read(`models/${key}.json.gz`),before=JSON.stringify(model),old=await read(`geometry/${key}.json.gz`);
 const geometry=geospatialNetwork(old,model,reference),routes=geometry.solver.features.filter(f=>f.properties.kind==='line'),devices=geometry.solver.features.filter(f=>f.properties.kind!=='line');
 const source=reference.reference_routes.features.length?reference.reference_routes:reference.fallback_routes;
 const sourcePaths=source.features.flatMap(f=>f.geometry.type==='MultiLineString'?f.geometry.coordinates:[f.geometry.coordinates]);
 assert.deepEqual(routes.map(f=>f.geometry.coordinates.map(p=>p.slice(0,2))),sourcePaths,key);
 assert.deepEqual(devices.map(f=>f.geometry.coordinates[0].slice(0,2)),reference.equipment.features.map(f=>f.geometry.coordinates),key);
 assert.ok(geometry.solver.features.every(f=>f.properties.coordinate_source==='gis_reference'&&f.properties.electrical_mapping==='circuit_only'),key);
 assert.equal(geometry.provenance.inferred_bus_positions,0);assert.equal(geometry.provenance.schematic_layout_buses,0);
 assert.deepEqual(geometry,geospatialNetwork({...old,solver:{features:[{geometry:{coordinates:[[0,0],[1,1]]}}]}},model,reference),key);
 assert.equal(JSON.stringify(model),before,key);
 report.circuits++;report.routeParts+=routes.length;report.sourceVertices+=sourcePaths.reduce((n,p)=>n+p.length,0);report.equipment+=devices.length;
 if(geometry.provenance.partial_reference)report.partialReferences.push({key,parts:routes.length});else report.fullReferences++;
 if(report.circuits%500===0)console.log('Verified',report.circuits);
}
await writeFile(new URL('../../geospatial-render-audit.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
