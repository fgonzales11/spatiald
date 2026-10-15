const cookieName='__Host-geobound-analysis';
const json=(detail,status)=>new Response(JSON.stringify({detail}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function signature(value,key){
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64(await crypto.subtle.sign('HMAC',material,new TextEncoder().encode(value)));
}
function equal(actual,expected){if(actual.length!==expected.length)return false;let different=0;for(let i=0;i<expected.length;i++)different|=actual.charCodeAt(i)^expected.charCodeAt(i);return different===0;}
async function workspace(request,key){
  const value=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
  const match=/^([a-f0-9-]{36})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if(match&&Number(match[2])>Date.now()&&equal(match[3],await signature(match[1]+'.'+match[2],key)))return {id:match[1]};
  const id=crypto.randomUUID(),expires=String(Date.now()+365*24*60*60*1000),payload=id+'.'+expires;
  return {id,cookie:cookieName+'='+payload+'.'+await signature(payload,key)+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000'};
}
export async function analysisProxy(request,env,fetchImpl=fetch){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/analysis/internal/'))return json('Internal worker routes are unavailable through the browser',403);
  if(!env.ANALYSIS_BEARER_TOKEN||!env.ANALYSIS_WORKSPACE_SIGNING_KEY)return json('Analysis service configuration is incomplete',503);
  const base=new URL(env.ANALYSIS_URL);
  if(base.protocol!=='https:'||base.username||base.password)return json('Analysis connection requires a valid HTTPS service URL',503);
  const identity=await workspace(request,env.ANALYSIS_WORKSPACE_SIGNING_KEY);
  const headers=new Headers({'Authorization':'Bearer '+env.ANALYSIS_BEARER_TOKEN,'X-Geobound-Workspace':identity.id});
  for(const name of ['accept','content-type'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
  const response=await fetchImpl(new URL(url.pathname+url.search,base),{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(300000)});
  if(response.status>=300&&response.status<400){await response.body?.cancel();return json('Unexpected analysis service redirect',502);}
  const output=new Headers({'Cache-Control':'no-store'});
  for(const name of ['content-type','content-disposition'])if(response.headers.has(name))output.set(name,response.headers.get(name));
  if(identity.cookie)output.set('Set-Cookie',identity.cookie);
  return new Response(response.body,{status:response.status,headers:output});
}
