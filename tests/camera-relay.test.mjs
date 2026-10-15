import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../camera-relay-source/camera.js';

test('Node relay requires its own credential and rejects unknown cameras and external paths',async()=>{
 const previous=process.env.CAMERA_RELAY_TOKEN;process.env.CAMERA_RELAY_TOKEN='fixture-relay-credential';
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(root+'/api/camera?cameraId=2262&resource=stream')).status,401);
  const headers={Authorization:'Bearer fixture-relay-credential'};
  assert.equal((await fetch(root+'/api/camera?cameraId=0&resource=stream',{headers})).status,404);
  assert.equal((await fetch(root+'/api/camera?cameraId=2262&resource=stream&path=https%3A%2F%2Funlisted.test%2Fmedia.ts',{headers})).status,400);
 }finally{await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.CAMERA_RELAY_TOKEN;else process.env.CAMERA_RELAY_TOKEN=previous;}
});
