import {readFile,writeFile,mkdir,rename,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function stageSimulationStorage(directory,uploadDirectory){
  const catalogPath=new URL('catalog.json',directory),catalog=JSON.parse(await readFile(catalogPath));
  const revision=createHash('sha256').update(JSON.stringify(catalog.networks.map(n=>[n.circuit_key,n.model_sha256,n.geometry_sha256]))).digest('hex');
  await rm(uploadDirectory,{recursive:true,force:true});await mkdir(uploadDirectory,{recursive:true});
  const manifest={revision,entries:[]};
  for(const kind of ['models','geometry']){
    const target=new URL(kind+'/',uploadDirectory);await rename(new URL(kind,directory),new URL(kind,uploadDirectory));
    for(const name of (await readdir(target)).sort()){
      const path=kind+'/'+name,bytes=await readFile(new URL(name,target));
      manifest.entries.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
  for(const n of catalog.networks.filter(n=>n.available))for(const kind of ['model','geometry'])n[kind+'_url']=`data/${revision}/${n[kind+'_url']}`;
  catalog.storage_revision=revision;
  await writeFile(catalogPath,JSON.stringify(catalog));await writeFile(new URL('manifest.json',uploadDirectory),JSON.stringify(manifest));
  console.log(`Staged ${manifest.entries.length} immutable model objects for Sites R2; app bundle excludes the data library.`);
}
