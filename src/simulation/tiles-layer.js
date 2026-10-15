import {BufferGeometry,Color,Float32BufferAttribute,Group,InstancedMesh,Matrix4,Mesh,MeshBasicMaterial,OrthographicCamera,ShaderMaterial,Vector3,WebGLRenderTarget} from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {distributionPlan,nearbyDetails} from './distribution-geometry.js';
import {simulationFeatures} from './map-layer.js';
import {lineGlowMaterial} from '../spatial/line-glow.js';
const rad=v=>v*Math.PI/180;
const COLORS={converged:[.06,1,.3],nonconverged:[1,.05,.12]};
// A local east/north/up frame avoids GPU precision loss at ECEF magnitudes.
export function createSimulationTiles({renderer,scene,camera,tiles,glow,host,onError,getView}){
  const group=new Group();scene.add(group);const meshes=new Group();group.add(meshes);
  const models=new Map(),loader=new GLTFLoader(),pixelScale={value:1};
  let state,plan,grid,frameToWorld=new Matrix4(),worldToFrame=new Matrix4(),disposed=false,dirty=false,lastMeasure=-Infinity,lastDetail=-Infinity,lastPosition=new Vector3(),lastRotation='',ready=false;
  const waiters=new Set();host.dataset.mapView='3d-tiles';host.dataset.simulationGlow='depth-aware-hdr';
  function local(point){return tiles.ellipsoid.getCartographicToPosition(rad(point[1]),rad(point[0]),0,new Vector3()).applyMatrix4(worldToFrame);}
  function clearMeshes(){for(const child of [...meshes.children]){child.traverse(o=>{if(o.isInstancedMesh)o.dispose();if(o.userData.owned){o.geometry?.dispose();o.material?.dispose();}});meshes.remove(child);}}
  function clearGrid(){grid?.target.dispose();grid?.material.dispose();grid=null;}
  function createGrid(bounds){
    clearGrid();const corners=[[bounds[0],bounds[1]],[bounds[2],bounds[3]]].map(local),margin=60;
    const x0=Math.min(...corners.map(p=>p.x))-margin,y0=Math.min(...corners.map(p=>p.y))-margin,x1=Math.max(...corners.map(p=>p.x))+margin,y1=Math.max(...corners.map(p=>p.y))+margin;
    const width=Math.min(1024,Math.max(32,Math.ceil((x1-x0)/2))),height=Math.min(1024,Math.max(32,Math.ceil((y1-y0)/2)));
    const cam=new OrthographicCamera(x0,x1,y1,y0,1,12000);cam.position.set(0,0,10000).applyMatrix4(frameToWorld);cam.up.set(0,1,0).transformDirection(frameToWorld);cam.lookAt(new Vector3().applyMatrix4(frameToWorld));cam.updateMatrixWorld();cam.layers.set(0);
    const material=new ShaderMaterial({toneMapped:false,vertexShader:'varying float d;void main(){vec4 p=modelViewMatrix*vec4(position,1.);d=-p.z;gl_Position=projectionMatrix*p;}',fragmentShader:'varying float d;void main(){float cm=clamp(floor((11000.-d)*100.+.5),0.,16777215.);float r=floor(cm/65536.);float g=floor((cm-r*65536.)/256.);gl_FragColor=vec4(r,g,cm-r*65536.-g*256.,255.)/255.;}'});
    grid={x0,y0,cellX:(x1-x0)/width,cellY:(y1-y0)/height,width,height,camera:cam,material,target:new WebGLRenderTarget(width,height),bytes:new Uint8Array(width*height*4),heights:new Float32Array(width*height).fill(NaN),median:null};
  }
  function ground(point){
    if(!grid)return null;const p=local(point),u=Math.floor((p.x-grid.x0)/grid.cellX),v=Math.floor((p.y-grid.y0)/grid.cellY),r=Math.max(1,Math.ceil(7/Math.max(grid.cellX,grid.cellY))),values=[];
    for(let y=Math.max(0,v-r);y<=Math.min(grid.height-1,v+r);y++)for(let x=Math.max(0,u-r);x<=Math.min(grid.width-1,u+r);x++){const z=grid.heights[y*grid.width+x];if(Number.isFinite(z))values.push(z);}
    if(values.length<3)return grid.median;values.sort((a,b)=>a-b);return values[Math.floor((values.length-1)*.15)];
  }
  function measure(){
    if(!grid||!state?.visible)return;
    const target=renderer.getRenderTarget(),override=scene.overrideMaterial,clear=renderer.getClearColor(new Color()),alpha=renderer.getClearAlpha(),auto=renderer.autoClear;
    group.visible=false;
    try{scene.overrideMaterial=grid.material;renderer.autoClear=true;renderer.setRenderTarget(grid.target);renderer.setClearColor(0,0);renderer.clear(true,true,false);renderer.render(scene,grid.camera);renderer.readRenderTargetPixels(grid.target,0,0,grid.width,grid.height,grid.bytes);}
    finally{scene.overrideMaterial=override;renderer.setRenderTarget(target);renderer.setClearColor(clear,alpha);renderer.autoClear=auto;group.visible=true;}
    const values=[];for(let i=0;i<grid.heights.length;i++){const j=i*4,z=grid.bytes[j+3]?(grid.bytes[j]*65536+grid.bytes[j+1]*256+grid.bytes[j+2])/100-1000:NaN;grid.heights[i]=z;if(Number.isFinite(z))values.push(z);}
    if(!values.length)return;values.sort((a,b)=>a-b);grid.median=values[Math.floor(values.length*.15)];ready=true;rebuild();for(const resolve of waiters)resolve();waiters.clear();host.dataset.simulationGroundSamples=String(values.length);
  }
  function routePoints(route){
    const out=route.map(p=>{const z=ground(p);if(z===null)return null;const v=local(p);v.z=z+(p[2]??.15);return v;});return out.some(p=>p===null)?null:out;
  }
  function tubeGeometry(routes){
    const positions=[],radials=[],indices=[],up=new Vector3(0,0,1);
    for(const points of routes){let previous;
      for(let i=0;i<points.length;i++){
        const p=points[i],tangent=points[Math.min(i+1,points.length-1)].clone().sub(points[Math.max(0,i-1)]).normalize(),a=tangent.clone().cross(up);if(a.lengthSq()<1e-8)a.set(1,0,0);a.normalize();const b=tangent.clone().cross(a).normalize(),base=positions.length/3;
        for(let k=0;k<6;k++){const r=a.clone().multiplyScalar(Math.cos(k*Math.PI/3)).addScaledVector(b,Math.sin(k*Math.PI/3));positions.push(...p);radials.push(...r);if(previous!==undefined){const j=(k+1)%6;indices.push(previous+k,previous+j,base+k,base+k,previous+j,base+j);}}
        previous=base;
      }
    }
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(positions,3));g.setAttribute('tubeRadial',new Float32BufferAttribute(radials,3));g.setIndex(indices);return g;
  }
  function widenedMaterial(color,radius,minPixels){
    const material=new MeshBasicMaterial({color,depthTest:true});
    material.onBeforeCompile=shader=>{shader.uniforms.pixelScale=pixelScale;shader.uniforms.radius={value:radius};shader.uniforms.minPixels={value:minPixels};shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec3 tubeRadial;uniform float pixelScale;uniform float radius;uniform float minPixels;').replace('#include <begin_vertex>','vec4 c=modelViewMatrix*vec4(position,1.);float amount=max(radius,-c.z*pixelScale*minPixels*.5);vec3 transformed=position+tubeRadial*amount;');};
    return material;
  }
  function addConductor(routes,color,glowing){
    if(!routes.length)return;const geometry=tubeGeometry(routes),mesh=new Mesh(geometry,widenedMaterial(color,.03,1.5));mesh.frustumCulled=false;mesh.userData.owned=true;meshes.add(mesh);
    if(glowing){const material=lineGlowMaterial(glow.shared,{color:COLORS[state.status]||COLORS.converged,attribute:'tubeRadial',radius:.08,minPixels:3.4,pixelScale});const halo=new Mesh(geometry.clone(),material);halo.layers.set(2);halo.frustumCulled=false;halo.userData.owned=true;meshes.add(halo);}
  }
  async function modelParts(name){
    if(!models.has(name))models.set(name,loader.loadAsync(new URL(`simulation/equipment/${name}.glb`,new URL(import.meta.env.BASE_URL,location.origin)).href).then(gltf=>{gltf.scene.updateMatrixWorld(true);const parts=[];gltf.scene.traverse(o=>{if(o.isMesh)parts.push({geometry:o.geometry.clone().applyMatrix4(o.matrixWorld),material:o.material.clone()});});return parts;}).catch(e=>{onError?.(`Network equipment could not load: ${e.message}`);return [];}));
    return models.get(name);
  }
  function addModels(nearby){
    const groups=new Map(),mounted=new Set(nearby.transformers.filter(t=>t.mounted).map(t=>t.node)),add=(name,point,node)=>{const z=ground(point);if(z===null)return;const p=local(point);p.z=z;const angle=-Math.atan2(node.direction[0],node.direction[1]);if(!groups.has(name))groups.set(name,[]);groups.get(name).push({p,angle});};
    for(const p of nearby.poles)if(!mounted.has(p))add('pole',p.point,p);for(const t of nearby.transformers)add(t.mounted?'pole-transformer':'padmount-transformer',t.displayPoint||t.point,t.node);for(const s of nearby.switches)add(`switch-${s.overhead?'overhead':'ground'}-${s.closed?'closed':'open'}`,s.point,s.node);
    const atRevision=revision;let count=0;
    for(const [name,items]of groups){count+=items.length;void modelParts(name).then(parts=>{if(disposed||!ready||atRevision!==revision)return;for(const part of parts){const mesh=new InstancedMesh(part.geometry,part.material,items.length),m=new Matrix4();items.forEach(({p,angle},i)=>{m.makeRotationZ(angle);m.setPosition(p);mesh.setMatrixAt(i,m);});mesh.instanceMatrix.needsUpdate=true;mesh.frustumCulled=false;meshes.add(mesh);}});}
    host.dataset.simulationEquipment=String(count);
  }
  let revision=0;
  function rebuild(){
    if(disposed||!plan||!ready)return;revision++;clearMeshes();host.dataset.simulationEquipmentRevision=String(revision);
    const view=getView?.(),center=tiles.ellipsoid.getPositionToCartographic(camera.position,{});
    const nearby=nearbyDetails(plan,view?.center||{lng:center.lon*180/Math.PI,lat:center.lat*180/Math.PI},view?.range??Infinity);
    const overhead=[],groundRoutes=[],other=[],lineIds=new Set();
    for(const entry of plan.entries){
      const paths=plan.displayPaths(entry,nearby.lines.has(entry));
      for(const route of paths){const points=routePoints(route);if(points)(entry.overhead?overhead:entry.feature.properties.kind==='line'?groundRoutes:other).push(points);}
      if(entry.feature.properties.kind==='line')lineIds.add(entry.feature.id);
    }
    if(state.topology==='gis')for(const f of simulationFeatures(state).features){lineIds.add(f.id);const routes=f.geometry.type==='MultiLineString'?f.geometry.coordinates:[f.geometry.coordinates];for(const route of routes){const points=routePoints(route.map(p=>[p[0],p[1],.15]));if(points)groundRoutes.push(points);}}
    const failed=state.status==='nonconverged',converged=state.status==='converged';
    addConductor(overhead,failed?'#d94353':'#d8dde2',failed||converged);addConductor(groundRoutes,failed?'#ff4c61':converged?'#52d99c':'#c994ff',failed||converged);addConductor(other,'#9aacb8',false);addModels(nearby);
    host.dataset.simulationPhysicalLines=String(state.geometry.provenance.physical_lines??lineIds.size);host.dataset.simulationRouteParts=String(lineIds.size);host.dataset.simulationCoordinateSource=state.geometry.provenance.coordinate_source||'unknown';host.dataset.simulationReferenceEquipment=String(state.geometry.provenance.gis_equipment||0);host.dataset.simulationConnections=String(state.geometry.provenance.physical_edges??plan.entries.length);host.dataset.simulationState=state.status;host.dataset.simulationConductorMin='14';host.dataset.simulationConductorMax='15.1';host.dataset.simulationGlowActive=String(failed||converged);
  }
  const invalidate=()=>{dirty=true;};tiles.addEventListener('tile-visibility-change',invalidate);tiles.addEventListener('load-model',invalidate);
  return {async set(next){
    const previous=state;state=next;revision++;clearMeshes();group.visible=Boolean(next?.visible);host.dataset.simulationGlowActive='false';
    if(!next?.visible){host.dataset.simulationPhysicalLines='0';host.dataset.simulationRouteParts='0';host.dataset.simulationEquipment='0';host.dataset.simulationConnections='0';for(const resolve of waiters)resolve();waiters.clear();return;}
    const data=simulationFeatures(next);plan=distributionPlan(next.topology==='gis'?{features:[]}:data);
    host.dataset.suppressedGeneratedPoles=String(plan.placement.suppressedGeneratedPoles);host.dataset.offsetPadmounts=String(plan.placement.offsetPadmounts);
    if(previous?.geometry===next.geometry&&previous?.topology===next.topology&&grid){if(ready)rebuild();return;}
    ready=false;
    // Both modes use the recorded GIS routes; the optional ground view omits raised equipment.
    const coordinates=data.features.flatMap(f=>f.geometry.type==='MultiLineString'?f.geometry.coordinates.flat():f.geometry.coordinates);if(!coordinates.length){plan=null;return;}
    const bounds=next.geometry.display_bounds||next.geometry.bounds,center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2],origin=tiles.ellipsoid.getCartographicToPosition(rad(center[1]),rad(center[0]),0,new Vector3()),east=new Vector3(),north=new Vector3(),up=new Vector3();tiles.ellipsoid.getEastNorthUpAxes(rad(center[1]),rad(center[0]),east,north,up);frameToWorld.makeBasis(east,north,up).setPosition(origin);worldToFrame.copy(frameToWorld).invert();group.matrixAutoUpdate=false;group.matrix.copy(frameToWorld);group.updateMatrixWorld(true);createGrid(bounds);dirty=true;lastMeasure=-Infinity;
  },tick(now){
    if(!plan||!state?.visible)return;pixelScale.value=2*Math.tan(rad(camera.fov/2))/Math.max(1,host.clientHeight);
    if(dirty&&now-lastMeasure>1500){dirty=false;lastMeasure=now;measure();}
    const rotation=camera.quaternion.toArray().map(v=>v.toFixed(2)).join(',');if(ready&&now-lastDetail>600&&(lastPosition.distanceTo(camera.position)>25||rotation!==lastRotation)){lastDetail=now;lastPosition.copy(camera.position);lastRotation=rotation;rebuild();}
    // Energization is the depth-occluded glow, as in DI; no white traveling streaks.
    glow.uniforms.get('glowIntensity').value=1.4;host.dataset.simulationAnimation='none';host.dataset.simulationGlowIntensity='1.4';
  },groundCenter:()=>grid?.median??0,waitReady(){if(ready)return Promise.resolve();return new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{waiters.delete(done);reject(Error('Network terrain is still loading. Retry Load network.'));},45000);waiters.add(done);});},
  dispose(){disposed=true;revision++;for(const resolve of waiters)resolve();waiters.clear();tiles.removeEventListener('tile-visibility-change',invalidate);tiles.removeEventListener('load-model',invalidate);clearMeshes();clearGrid();scene.remove(group);for(const p of models.values())void p.then(parts=>{for(const part of parts){part.geometry.dispose();for(const value of Object.values(part.material))if(value?.isTexture)value.dispose();part.material.dispose();}});delete host.dataset.mapView;}};
}
