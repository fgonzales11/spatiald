import {geospatialNetwork} from './geospatial-network.js';
const base = new URL(`${import.meta.env?.BASE_URL || '/'}simulation/`,location.origin);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function fetchDocument(path, expectedHash, signal) {
  const url = new URL(path,base);
  if(url.origin!==location.origin || !url.pathname.startsWith(base.pathname))throw Error('Invalid network resource.');
  const response=await fetch(url,{signal});
  if(!response.ok){const detail=await response.json().catch(()=>null);throw Error(typeof detail?.error==='string'?detail.error:`Network data unavailable (${response.status}). Please retry.`);}
  const zipped=await response.arrayBuffer();
  // Static hosts may already decode Content-Encoding:gzip. Inspect the payload.
  const signature=new Uint8Array(zipped,0,Math.min(2,zipped.byteLength));
  const bytes=signature[0]===0x1f&&signature[1]===0x8b?await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():zipped;
  if(expectedHash && await digest(bytes)!==expectedHash)throw Error('Network integrity check failed. Reload and retry.');
  return {bytes,value:JSON.parse(new TextDecoder().decode(bytes))};
}
export function createSimulationController({onChange,onLayer,onFocus}) {
  let state={catalog:null,catalogStatus:'idle',selectedKey:'',loadedKey:'',status:'idle',message:'Choose a circuit to load its network.',topology:'solver',visible:true,geometry:null,result:null};
  let catalogPromise,abort,worker,epoch=0,model;
  const set=patch=>{state={...state,...patch};onChange?.(state);};
  const layer=()=>state.geometry?{id:'sce-simulation-network',circuit_key:state.loadedKey,geometry:state.geometry,topology:state.topology,visible:state.visible,status:state.status,result:state.result}:null;
  const paint=(strict=false)=>{
    const atEpoch=epoch,snapshot=layer();
    const pending=Promise.resolve().then(()=>atEpoch===epoch?onLayer?.(snapshot):undefined);
    return strict?pending:pending.catch(error=>{if(atEpoch===epoch&&state.geometry===snapshot?.geometry&&state.topology===snapshot?.topology)set({status:'error',message:`Network rendering failed: ${error.message}`});});
  };
  function cancelWork(){abort?.abort();abort=null;worker?.terminate();worker=null;epoch++;}
  async function catalog(){
    if(state.catalog)return state.catalog;
    return catalogPromise??=(async()=>{
      set({catalogStatus:'loading'});
      try{const [{value},{value:references}]=await Promise.all([fetchDocument('catalog.json'),fetchDocument('geospatial/index.json')]);if(!Array.isArray(value.networks)||!Array.isArray(references.networks))throw Error('Invalid network or GIS reference catalog.');
        const byKey=new Map(references.networks.map(n=>[n.circuit_key,n]));
        value.networks=value.networks.map(n=>({...n,geospatial_reference:byKey.get(n.circuit_key)}));
        set({catalog:value,catalogStatus:'ready'});return value;}
      catch(error){set({catalogStatus:'error',message:error.message});throw error;}
      finally{catalogPromise=null;}
    })();
  }
  function select(key){
    if(key===state.selectedKey)return;
    cancelWork();model=null;
    set({selectedKey:key,loadedKey:'',geometry:null,result:null,topology:'solver',status:'idle',message:key?'Ready to load the selected network.':'Choose a circuit to load its network.'});paint();
  }
  async function load(){
    if(!state.selectedKey || ['loading','running'].includes(state.status))return;
    cancelWork();const id=epoch;abort=new AbortController();
    set({status:'loading',result:null,message:'Loading network model and GIS circuit…'});
    try{
      const value=await catalog();const network=value.networks.find(n=>n.circuit_key===state.selectedKey);
      if(!network?.available)throw Error(network?.error || 'This model is unavailable.');
      const ref=network.geospatial_reference;if(!ref)throw Error('The GIS reference for this network is unavailable.');
      const [input,geometry,reference]=await Promise.all([fetchDocument(network.model_url,network.model_sha256,abort.signal),fetchDocument(network.geometry_url,network.geometry_sha256,abort.signal),fetchDocument(ref.url,ref.sha256,abort.signal)]);
      if(id!==epoch)return;
      if(input.value.circuit_key!==network.circuit_key || geometry.value.circuit_key!==network.circuit_key)throw Error('The model and map circuit identities differ.');
      model=input.bytes;
      set({loadedKey:network.circuit_key,geometry:geospatialNetwork(geometry.value,input.value,reference.value),visible:true,
        topology:'solver',
        message:'Adding network and flying to its location…'});
      await paint(true);await onFocus?.(state.geometry.display_bounds||state.geometry.bounds);
      if(id!==epoch)return;
      set({status:'loaded',message:`${network.circuit_key} loaded. Ready for power flow.`});paint();
    }catch(error){if(id===epoch && error.name!=='AbortError'){set({status:'error',loadedKey:'',geometry:null,message:error.message});paint();}}
  }
  function run(parameters={}){
    if(!model || !state.loadedKey || ['loading','running'].includes(state.status))return;
    const id=++epoch;set({status:'running',result:null,message:'Starting the WebAssembly solver…'});paint();
    try{
      worker??=new Worker(new URL('worker.mjs',base),{type:'module'});
      const active=worker;
      worker.onmessage=({data})=>{
        if(worker!==active || data.id!==epoch)return;
        if(data.type==='status'){set({message:data.message});return;}
        if(data.type==='error'){set({status:'error',message:data.message,result:null});paint();return;}
        if(data.type==='result' && data.circuit_key===state.loadedKey && data.result?.circuit_key===state.loadedKey){
          const result=data.result;set({status:result.solved===true?'converged':'nonconverged',result,message:result.message});paint();
        }else if(data.type==='result'){
          set({status:'error',message:'The solver returned results for a different circuit. Load the network again.',result:null});paint();
        }
      };
      worker.onerror=event=>{if(active!==worker)return;worker.terminate();worker=null;set({status:'error',message:event.message || 'The WebAssembly worker failed. Retry the run.'});paint();};
      const network=state.catalog.networks.find(n=>n.circuit_key===state.loadedKey);
      const bytes=model.slice(0);worker.postMessage({id,network,catalog:{solver_sha256:state.catalog.solver_sha256,runtime_sha256:state.catalog.runtime_sha256},model:bytes,parameters},[bytes]);
    }catch(error){set({status:'error',message:error.message});paint();}
  }
  return {getState:()=>state,getLayer:layer,catalog,select,load,run,
    topology(value){if(!['solver','gis'].includes(value))return;set({topology:value});paint();},
    visible(value){set({visible:Boolean(value)});paint();},
    cancel(){
      const loading=state.status==='loading';cancelWork();
      if(loading){model=null;set({status:'idle',loadedKey:'',geometry:null,result:null,message:'Network loading cancelled.'});}
      else set({status:state.geometry?'loaded':'idle',result:null,message:'Run cancelled.'});
      paint();
    },
    dispose(){cancelWork();}};
}
