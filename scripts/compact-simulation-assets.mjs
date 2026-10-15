import {readFile,writeFile} from 'node:fs/promises';
import {gzip,gunzipSync} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

// Geometry repeats input-table names and feature IDs on millions of edges.
// Keep names in the complete solver input and IDs on the GeoJSON feature;
// remove only redundant display properties. Rendering does not consume them.
export async function compactSimulationAssets(directory){
  const compress=promisify(gzip),catalogPath=new URL('catalog.json',directory);
  const catalog=JSON.parse(await readFile(catalogPath));
  const entries=catalog.networks.filter(n=>n.available);let cursor=0,before=0,after=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<entries.length){
      const network=entries[cursor++],path=new URL(network.geometry_url,directory);
      const original=await readFile(path),geometry=JSON.parse(gunzipSync(original));
      for(const feature of geometry.solver.features){
        delete feature.properties.id;delete feature.properties.name;
        // The obsolete boolean treated a missing source line.type as underground.
        // Runtime construction now comes from the verified model's standard type.
        delete feature.properties.overhead;
      }
      const bytes=Buffer.from(JSON.stringify(geometry)),packed=await compress(bytes,{level:9});
      if(!gunzipSync(packed).equals(bytes))throw Error('Geometry compression verification failed');
      network.geometry_bytes=bytes.length;
      network.geometry_sha256=createHash('sha256').update(bytes).digest('hex');
      await writeFile(path,packed);before+=original.length;after+=packed.length;
    }
  }));
  await writeFile(catalogPath,JSON.stringify(catalog));
  console.log(`Simulation geometry: ${entries.length} circuits verified; ${(before/1048576).toFixed(1)} → ${(after/1048576).toFixed(1)} MiB. Complete solver inputs retained.`);
}
