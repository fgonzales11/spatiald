import { createServer } from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import worker from '../worker/index.js';
const root=resolve('dist/client');
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.glb':'model/gltf-binary','.pbf':'application/x-protobuf','.png':'image/png','.wasm':'application/wasm'};
const env={ASSETS:{async fetch(request){
 const url=new URL(request.url);let file=resolve(root,'.'+decodeURIComponent(url.pathname));
 if(!file.startsWith(root+sep)&&file!==root)return new Response('Forbidden',{status:403});
 try{if((await stat(file)).isDirectory())file=resolve(file,'index.html');return new Response(request.method==='HEAD'?null:await readFile(file),{headers:{'Content-Type':types[extname(file)]||'application/octet-stream'}});}
 catch{return new Response('Not found',{status:404});}
}}};
createServer(async(req,res)=>{
 try{const response=await worker.fetch(new Request('http://127.0.0.1:5188'+req.url,{method:req.method,headers:req.headers}),env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
 catch{res.writeHead(500).end('Preview request failed');}
}).listen(5188,'127.0.0.1',()=>console.log('Geobound hosted preview: http://127.0.0.1:5188'));
