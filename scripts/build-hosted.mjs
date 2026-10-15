import { rm, mkdir, writeFile } from 'node:fs/promises';
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { compactSimulationAssets } from './compact-simulation-assets.mjs';
import { stageSimulationStorage } from './stage-simulation-storage.mjs';

await rm('dist', {recursive:true,force:true});
await viteBuild();
await compactSimulationAssets(new URL('../dist/client/simulation/',import.meta.url));
if(process.env.SPATIAL_D_OBJECT_STORAGE==='1')await stageSimulationStorage(new URL('../dist/client/simulation/',import.meta.url),new URL('../.simulation-upload/',import.meta.url));
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['worker/index.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:events','node:buffer'],minify:true});
await writeFile('dist/server/wrangler.json',JSON.stringify({name:'geobound',main:'index.js',compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat','allow_custom_ports'],assets:{directory:'../client',binding:'ASSETS',run_worker_first:['/api/*','/data/us-transmission/tiles/*','/simulation/data/*','/simulation/catalog.json']}},null,2));
