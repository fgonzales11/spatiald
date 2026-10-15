import { mapConfig } from '../shared/map-config.js';
import { simulationStorage } from './simulation-storage.js';
import { EventEmitter } from 'node:events';
import { analysisProxy } from './analysis-proxy.js';
import { createCameraMiddleware } from '../server/highway-cameras.js';
import { HIGHWAY_CAMERAS } from '../src/data/highway-cameras.js';
import caltransCatalog from '../data/camera-catalogs/caltrans-camera-feeds.json' with { type:'json' };

function logProviderFailure(error) {
  console.error('Camera provider fetch failed', error?.name || 'Error', String(error?.message || 'Unknown provider failure').replace(/https?:\/\/[^\s"'<>]+/g,'[provider URL]').slice(0,300));
}
async function providerFetch(input,init) {
  try {
    // The edge runtime rejects redirect:"error" before making the request.
    // Manual handling preserves the original no-redirect policy.
    const options=init?.redirect==='error'?{...init,redirect:'manual'}:init;
    const response=await fetch(String(input),options);
    if(init?.redirect==='error'&&response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('Unexpected provider redirect');}
    return response;
  }
  catch(error) { const target=new URL(String(input));console.error('Camera upstream host',target.hostname,'port',target.port||'443');logProviderFailure(error); throw error; }
}
const cameras = createCameraMiddleware({fetchImpl:providerFetch,onError:(phase,error)=>{console.error('FDOT '+phase+' failed');logProviderFailure(error);}});
const caltrans = caltransCatalog.cameras;
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const catalog = [
  ...HIGHWAY_CAMERAS.features.map(f=>({id:`fdot-${f.properties.id}`,provider:'FDOT',name:f.properties.name,longitude:f.geometry.coordinates[0],latitude:f.geometry.coordinates[1],direction:f.properties.direction,inService:true,videoAvailable:f.properties.videoAvailable,stream:`/api/highway-cameras/${f.properties.id}/stream`,snapshot:f.properties.snapshotUrl?`/api/highway-cameras/${f.properties.id}/snapshot`:null,sourceUrl:'https://fl511.com/'})),
  ...caltrans.map(c=>({id:`caltrans-${c.id}`,provider:'Caltrans',name:c.name,longitude:c.longitude,latitude:c.latitude,direction:c.direction,inService:c.inService,sourceUpdatedAt:c.sourceUpdatedAt,videoAvailable:Boolean(c.videoUrl),stream:`/api/analysis/caltrans/${encodeURIComponent(c.id)}/stream`,snapshot:c.snapshotUrl?`/api/analysis/caltrans/${encodeURIComponent(c.id)}/snapshot`:null,sourceUrl:c.quickmapUrl})),
];

function fdot(request) {
  return new Promise((resolve,reject)=>{
    class ResponseBridge extends EventEmitter {
      status=200;headers={};writableEnded=false;destroyed=false;headersSent=false;
      writeHead(status,headers={}){this.status=status;this.headers=headers;this.headersSent=true;return this;}
      setHeader(key,value){this.headers[key]=value;}
      end(body){this.writableEnded=true;resolve(new Response(body,{status:this.status,headers:this.headers}));this.emit('finish');return this;}
      destroy(){this.destroyed=true;this.emit('close');reject(new Error('Camera response interrupted'));}
    }
    const url=new URL(request.url);
    cameras({method:request.method,url:url.pathname+url.search,headers:Object.fromEntries(request.headers)},new ResponseBridge(),()=>resolve(json({error:'Camera route not found'},404))).catch(reject);
  });
}

async function fdotRelay(request,env) {
  if(request.method!=='GET')return json({detail:'Only GET is supported'},405);
  const url=new URL(request.url);
  const match=/^\/api\/highway-cameras\/(\d+)\/(stream|snapshot)$/.exec(url.pathname);
  if(!match||!HIGHWAY_CAMERAS.features.some(f=>String(f.properties.id)===match[1]))return json({detail:'Camera not found'},404);
  const target=new URL(env.CAMERA_RELAY_URL);
  if(target.protocol!=='https:'||target.username||target.password)return json({detail:'Invalid camera relay configuration'},503);
  target.search='';target.hash='';
  target.searchParams.set('cameraId',match[1]);target.searchParams.set('resource',match[2]);
  if(url.searchParams.has('path'))target.searchParams.set('path',url.searchParams.get('path'));
  const response=await providerFetch(target.href,{headers:{Authorization:`Bearer ${env.CAMERA_RELAY_TOKEN}`},signal:AbortSignal.timeout(25000),redirect:'error'});
  const headers=new Headers({'Cache-Control':'no-store'});
  if(response.headers.has('content-type'))headers.set('Content-Type',response.headers.get('content-type'));
  return new Response(response.body,{status:response.status,headers});
}

async function caltransResource(request,url,match) {
  if(request.method!=='GET')return json({detail:'Only GET is supported'},405);
  const camera=caltrans.find(c=>String(c.id)===decodeURIComponent(match[1]));
  if(!camera)return json({detail:'Camera not found'},404);
  const address=match[2]==='snapshot'?camera.snapshotUrl:camera.videoUrl;
  if(!address)return json({detail:'Camera resource is not available'},404);
  const base=new URL(address),directory=new URL('.',base).pathname;
  const target=new URL(url.searchParams.get('path')||base.href,base);
  const allowed=u=>u.protocol==='https:'&&u.origin===base.origin&&u.pathname.startsWith(directory)&&!u.username&&!u.password;
  if(!allowed(target)||(match[2]==='snapshot'&&url.searchParams.has('path')))return json({detail:'Invalid camera resource'},400);
  const response=await providerFetch(target.href,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)return json({detail:'Provider camera unavailable'},502);
  const type=response.headers.get('content-type')||'application/octet-stream';
  if(match[2]==='snapshot'&&!type.startsWith('image/'))return json({detail:'Invalid provider image'},502);
  let body;
  if(/\.m3u8$/i.test(target.pathname)){
    const text=await response.text();if(!text.startsWith('#EXTM3U'))return json({detail:'Invalid provider playlist'},502);
    const rewrite=uri=>{const u=new URL(uri,target);if(!allowed(u))throw new Error('Invalid playlist resource');return `${url.pathname}?path=${encodeURIComponent(u.pathname+u.search)}`;};
    body=text.split(/\r?\n/).map(line=>!line.trim()?line:line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_,uri)=>`URI="${rewrite(uri)}"`):rewrite(line.trim())).join('\n');
  }else{
    body=await response.arrayBuffer();if(body.byteLength>20*1024*1024)return json({detail:'Camera resource exceeds size limit'},502);
  }
  return new Response(body,{headers:{'Content-Type':type,'Cache-Control':'no-store'}});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(url.pathname.startsWith('/simulation/data/')||url.pathname==='/simulation/catalog.json'||url.pathname.startsWith('/api/simulation-assets/')){const response=await simulationStorage(request,env);if(response)return response;}
      if(url.pathname==='/api/map-config')return request.method==='GET'?json(mapConfig(env)):json({detail:'Only GET is supported'},405);
      if(url.pathname.startsWith('/api/highway-cameras/'))return env.CAMERA_RELAY_URL&&env.CAMERA_RELAY_TOKEN?await fdotRelay(request,env):await fdot(request);
      if(url.pathname==='/api/analysis/cameras')return request.method==='GET'?json(catalog):json({detail:'Only GET is supported'},405);
      const camera=/^\/api\/analysis\/caltrans\/([^/]+)\/(stream|snapshot)$/.exec(url.pathname);
      if(camera)return await caltransResource(request,url,camera);
      if(url.pathname.startsWith('/api/analysis/')){
        if(!env.ANALYSIS_URL)return json({detail:'This Site does not run the Python analysis service. Continue studies in your local Geobound app, or connect a separately hosted analysis service.'},503);
        return await analysisProxy(request,env);
      }
      if(url.pathname.startsWith('/api/'))return json({detail:'Endpoint not found'},404);
      if(/^\/data\/us-transmission\/tiles\/\d+\/\d+\/\d+\.pbf$/.test(url.pathname)&&/\bgzip\b/.test(request.headers.get('accept-encoding')||'')){
        const gz=new URL(url);gz.pathname+='.gz';
        const compressed=await env.ASSETS.fetch(new Request(gz,request));
        if(compressed.ok){const headers=new Headers(compressed.headers);headers.set('Content-Type','application/x-protobuf');headers.set('Content-Encoding','gzip');headers.set('Vary','Accept-Encoding');return new Response(compressed.body,{status:200,headers,encodeBody:'manual'});}
      }
      return env.ASSETS.fetch(request);
    }catch{return json({detail:url.pathname.includes('camera')||url.pathname.includes('caltrans')?'Camera provider unavailable. Please retry.':'Hosted service unavailable. Please retry.'},502);}
  }
};
