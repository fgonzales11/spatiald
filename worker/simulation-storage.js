const revisionPattern=/^[a-f0-9]{64}$/;
const filePattern=/^(models|geometry)\/CKT_\d+_\d+\.json\.gz$/;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export async function simulationStorage(request,env){
  const url=new URL(request.url),bucket=env.BUCKET;
  if(url.pathname==='/simulation/catalog.json'){
    const response=await env.ASSETS.fetch(request);if(!response.ok)return response;
    const catalog=await response.clone().json();
    if(catalog.storage_revision&&(!bucket||!await bucket.head(`sce/${catalog.storage_revision}/ready.json`)))return json({error:'The circuit library is being prepared. Reopen Simulation shortly to retry.'},503);
    return response;
  }
  const file=/^\/simulation\/data\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
  if(file){
    if(!['GET','HEAD'].includes(request.method))return json({error:'Only GET and HEAD are supported.'},405);
    if(!filePattern.test(file[2]))return json({error:'Network resource not found.'},404);
    if(!bucket)return json({error:'Circuit storage is unavailable.'},503);
    const object=await bucket.get(`sce/${file[1]}/${file[2]}`);
    if(!object)return json({error:'Circuit resource unavailable. Please retry.'},404);
    const headers=new Headers({'Content-Type':'application/gzip','Cache-Control':'public,max-age=31536000,immutable','ETag':object.httpEtag,'Content-Length':String(object.size)});
    if(request.headers.get('if-none-match')===object.httpEtag)return new Response(null,{status:304,headers});
    return new Response(request.method==='HEAD'?null:object.body,{headers});
  }
  if(!url.pathname.startsWith('/api/simulation-assets/'))return null;
  // This maintenance endpoint is disabled unless an owner-provided secret is
  // configured. Tokens never enter client code, manifests, files or responses.
  if(!bucket||!env.SIMULATION_IMPORT_TOKEN||request.headers.get('authorization')!==`Bearer ${env.SIMULATION_IMPORT_TOKEN}`)return json({error:'Not found'},404);
  if(request.method!=='POST')return json({error:'Only POST is supported'},405);
  const revision=url.searchParams.get('revision');if(!revisionPattern.test(revision||''))return json({error:'Invalid data revision'},400);
  const prefix=`sce/${revision}/`;
  if(await bucket.head(prefix+'ready.json'))return json({error:'This immutable data revision is already sealed'},409);
  if(url.pathname==='/api/simulation-assets/complete'){
    const expected=await request.json();if(!Number.isInteger(expected.count)||expected.count<1||expected.count>20000)return json({error:'Invalid object count'},400);
    let count=0,cursor;do{const page=await bucket.list({prefix,limit:1000,...(cursor?{cursor}:{})});count+=page.objects.length;cursor=page.truncated?page.cursor:null;}while(cursor);
    if(count!==expected.count)return json({error:'Upload is incomplete',expected:expected.count,received:count},409);
    await bucket.put(prefix+'ready.json',JSON.stringify({count,completed_at:new Date().toISOString()}),{httpMetadata:{contentType:'application/json'}});
    return json({sealed:true,count,revision});
  }
  if(url.pathname!=='/api/simulation-assets/import')return json({error:'Not found'},404);
  if(Number(request.headers.get('content-length'))>12*1024*1024)return json({error:'Batch too large'},413);
  const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length<4||bytes.length>12*1024*1024)return json({error:'Invalid batch size'},400);
  const headerLength=new DataView(bytes.buffer).getUint32(0,true);if(headerLength>100000||headerLength+4>bytes.length)return json({error:'Invalid batch header'},400);
  const entries=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+headerLength)));
  if(!Array.isArray(entries)||entries.length<1||entries.length>100)return json({error:'Invalid batch entries'},400);
  let offset=4+headerLength;const files=[];
  for(const entry of entries){
    if(!filePattern.test(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||offset+entry.bytes>bytes.length||!/^[a-f0-9]{64}$/.test(entry.sha256))return json({error:'Invalid object entry'},400);
    const body=bytes.slice(offset,offset+entry.bytes);offset+=entry.bytes;
    if(await hash(body)!==entry.sha256)return json({error:'Object integrity check failed'},400);
    files.push({path:entry.path,body,sha256:entry.sha256});
  }
  if(offset!==bytes.length)return json({error:'Unexpected trailing batch data'},400);
  // Four concurrent R2 writes stay below the Worker connection limit.
  let cursor=0;await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(cursor<files.length){const file=files[cursor++];await bucket.put(prefix+file.path,file.body,{httpMetadata:{contentType:'application/gzip',cacheControl:'public,max-age=31536000,immutable'},customMetadata:{sha256:file.sha256}});}}));
  return json({stored:files.length,revision});
}
