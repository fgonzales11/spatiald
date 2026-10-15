import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createCameraMiddleware } from '../server/highway-cameras.js';

const cameras=createCameraMiddleware();
export default async function handler(req,res){
 const supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
 const expected=process.env.CAMERA_RELAY_TOKEN||'';
 const suppliedBytes=Buffer.from(supplied),expectedBytes=Buffer.from(expected);
 if(!expected||suppliedBytes.length!==expectedBytes.length||!timingSafeEqual(suppliedBytes,expectedBytes)){res.writeHead(401,{'Cache-Control':'no-store'}).end('Unauthorized');return;}
 if(req.method!=='GET'){res.writeHead(405).end();return;}
 const query=new URL(req.url,'https://relay.invalid').searchParams;
 const camera=query.get('cameraId'),resource=query.get('resource');
 if(!/^\d+$/.test(camera||'')||!['snapshot','stream'].includes(resource)){res.writeHead(400).end('Invalid camera request');return;}
 const path=query.get('path');
 req.url=`/api/highway-cameras/${camera}/${resource}`+(path?'?path='+encodeURIComponent(path):'');
 await cameras(req,res,()=>res.writeHead(404).end());
}
