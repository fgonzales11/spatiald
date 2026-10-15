import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const origin=process.env.SIMULATION_ORIGIN||'http://127.0.0.1:5187';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
// Real renderer controls with an empty basemap/ground plane avoid network tiles
// and solver timing obscuring the actual pointer-input regression.
await page.route('**/right-drag-test',route=>route.fulfill({contentType:'text/html',body:`<style>body{margin:0}#map{width:800px;height:600px}canvas{display:block}</style><div id="map"></div><script type="module">
import {Map} from '/node_modules/.vite/deps/maplibre-gl.js';
import {Scene,PerspectiveCamera,WebGLRenderer,Mesh,PlaneGeometry,MeshBasicMaterial} from '/node_modules/.vite/deps/three.js';
import {GlobeControls} from '/node_modules/.vite/deps/3d-tiles-renderer_three.js';
import {reverseMapLibreRightDrag,reverseGlobeRightDrag} from '/src/spatial/right-drag.js';
let current,cleanup;
window.setup=async(kind,reversed)=>{
 cleanup?.();document.querySelector('#map').replaceChildren();
 if(kind==='maplibre'){
  const map=new Map({container:'map',style:{version:8,sources:{},layers:[]},center:[0,0],zoom:12,bearing:0,pitch:45,fadeDuration:0,attributionControl:false,reduceMotion:true});
  await new Promise(resolve=>map.on('load',resolve));
  const restore=reversed?reverseMapLibreRightDrag(map):()=>{};
  current=()=>[map.getBearing(),map.getPitch(),map.getCenter().lng,map.getCenter().lat];
  cleanup=()=>{restore();map.remove();};
 }else{
  const scene=new Scene(),renderer=new WebGLRenderer();renderer.setSize(800,600);document.querySelector('#map').append(renderer.domElement);
  const camera=new PerspectiveCamera(60,4/3,1,1e8),ground=new Mesh(new PlaneGeometry(40000,40000),new MeshBasicMaterial());ground.position.set(6378137,0,0);ground.rotation.y=Math.PI/2;scene.add(ground);scene.updateMatrixWorld(true);
  camera.position.set(6379137,-700,800);camera.up.set(1,0,0);camera.lookAt(6378137,0,0);camera.updateMatrixWorld();
  const controls=new GlobeControls(scene,camera,renderer.domElement);controls.adjustHeight=false;controls.enableDamping=false;controls.update();
  const restore=reversed?reverseGlobeRightDrag(controls,renderer.domElement):()=>{};
  renderer.setAnimationLoop(()=>{controls.update();camera.updateMatrixWorld();renderer.render(scene,camera);});
  current=()=>camera.position.toArray();
  cleanup=()=>{restore();controls.dispose();renderer.setAnimationLoop(null);renderer.dispose();ground.geometry.dispose();ground.material.dispose();};
 }
};window.capture=()=>current();window.ready=true;
</script>`}));
try {
 await page.goto(origin+'/right-drag-test');await page.waitForFunction(()=>window.ready);
 const samples=[];
 async function drag(kind,reversed,button,dx,dy,startY=300){
  await page.evaluate(async({kind,reversed})=>window.setup(kind,reversed),{kind,reversed});await page.waitForTimeout(150);
  const before=await page.evaluate(()=>window.capture());
  await page.mouse.move(400,startY);await page.mouse.down({button});await page.mouse.move(400+dx,startY+dy,{steps:10});
  await page.waitForTimeout(100);const during=await page.evaluate(()=>window.capture());await page.mouse.up({button});
  return during.map((v,i)=>v-before[i]);
 }
 for(const kind of ['maplibre','globe'])for(const [dx,dy,startY]of [[35,0,300],[0,35,300],[35,0,140]]){
  const normal=await drag(kind,false,'right',dx,dy,startY),reversed=await drag(kind,true,'right',dx,dy,startY);
  const dot=normal.reduce((n,v,i)=>n+v*reversed[i],0),normalSize=Math.hypot(...normal),reversedSize=Math.hypot(...reversed);
  assert.ok(normalSize>.1&&reversedSize>.1,`${kind}: gesture did not move the camera`);
  assert.ok(dot<0,`${kind}: right-drag did not reverse (${normal} / ${reversed})`);
  samples.push({kind,dx,dy,startY,normal,reversed});
 }
 for(const kind of ['maplibre','globe']){
  const normal=await drag(kind,false,'left',35,20),reversed=await drag(kind,true,'left',35,20);
  assert.ok(normal.reduce((n,v,i)=>n+v*reversed[i],0)>0,`${kind}: left drag changed direction`);
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({checks:['right-drag reverses horizontal and vertical camera movement','off-centre orbital drag reverses','left drag keeps its direction'],samples,errors},null,2));
}finally{await browser.close();}
