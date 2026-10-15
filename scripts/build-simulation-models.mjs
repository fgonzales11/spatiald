// Small first-party technical symbols for Google Model3DElement. Dimensions in
// meters, authored Z-up (east, north, up) for the Maps model coordinate system.
// No textures, external resources, glTF extensions or runtime Three.js scene.
import {BoxGeometry,CylinderGeometry,Color} from 'three';
import {mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../public/simulation/equipment/',import.meta.url);
await mkdir(root,{recursive:true});
// 0 wood, 1 hardware, 2 insulator, 3 symbol, 4 white, 5 hunter green, 6 dark green, 7 concrete, 8 can grey, 9 lid grey
const colors=['#a77947','#64747c','#d7e2e4','#238cac','#ffffff','#355e3b','#2a4b2f','#b8bcb4','#8f9ca3','#c9d0d3'];
function model(name,parts){
  const chunks=[],views=[],accessors=[],primitives=[];let byteLength=0;
  function attribute(array,type,componentType,limits=false){
    const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength),view=views.length;
    views.push({buffer:0,byteOffset:byteLength,byteLength:bytes.length});chunks.push(bytes);byteLength+=bytes.length;
    if(byteLength%4){const pad=Buffer.alloc(4-byteLength%4);chunks.push(pad);byteLength+=pad.length}
    const count=array.length/(type==='VEC3'?3:1),accessor={bufferView:view,componentType,count,type};
    if(limits){accessor.min=[0,1,2].map(k=>Math.min(...Array.from({length:count},(_,i)=>array[i*3+k])));accessor.max=[0,1,2].map(k=>Math.max(...Array.from({length:count},(_,i)=>array[i*3+k])))}
    accessors.push(accessor);return accessors.length-1;
  }
  for(const {geometry,material} of parts){
    // Three primitives are Y-up; rotate into Maps Z-up before serialization.
    geometry.rotateX(Math.PI/2);
    primitives.push({attributes:{POSITION:attribute(geometry.attributes.position.array,'VEC3',5126,true),NORMAL:attribute(geometry.attributes.normal.array,'VEC3',5126)},indices:attribute(geometry.index.array,'SCALAR',5123),material});
  }
  const document={asset:{version:'2.0',generator:'SPATIAL D schematic distribution equipment; story map chapter 2 dimensions'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{name,primitives}],materials:colors.map(hex=>{const c=new Color(hex);return {pbrMetallicRoughness:{baseColorFactor:[c.r,c.g,c.b,1],metallicFactor:.05,roughnessFactor:.85},doubleSided:false}}),buffers:[{byteLength}],bufferViews:views,accessors};
  const raw=Buffer.from(JSON.stringify(document)),json=Buffer.alloc(Math.ceil(raw.length/4)*4,0x20);raw.copy(json);
  const binary=Buffer.concat(chunks),header=Buffer.alloc(12),jsonHeader=Buffer.alloc(8),binHeader=Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
  jsonHeader.writeUInt32LE(json.length);jsonHeader.writeUInt32LE(0x4e4f534a,4);binHeader.writeUInt32LE(binary.length);binHeader.writeUInt32LE(0x004e4942,4);
  return writeFile(new URL(name+'.glb',root),Buffer.concat([header,jsonHeader,json,binHeader,binary]));
}
const box=(x,y,z,w,h,d,material)=>({geometry:new BoxGeometry(w,h,d).translate(x,y,z),material});
const cylinder=(x,y,z,top,bottom,height,material)=>({geometry:new CylinderGeometry(top,bottom,height,8).translate(x,y,z),material});
const poleParts=()=>{
  const parts=[cylinder(0,7.4,0,.18,.25,14.8,0),box(0,14.475,0,3.3,.25,.22,0)];
  for(const x of [-1.25,0,1.25])parts.push(cylinder(x,14.85,0,.14,.14,.5,2));
  return parts;
};
await model('pole',poleParts());
await model('pole-transformer',[...poleParts(),box(0,12.55,-.38,.2,.18,.6,1),cylinder(0,13.125,-.95,.48,.48,1.65,8),cylinder(0,14,-.95,.52,.52,.1,9),cylinder(0,14.16,-.95,.12,.12,.22,2)]);
await model('padmount-transformer',[box(0,.15,0,4.4,.3,3.4,7),box(0,1.6,0,4,2.6,3,5),box(0,2.95,0,4.1,.1,3.1,6),box(0,1.5,1.52,.5,.7,.04,4)]);
console.log('Built story-map-style distribution equipment. Heights are schematic.');
// Load-break switch: three contacts with porcelain supports. Open blades visibly
// lift away from the second contact. Ground variants sit on a short cabinet.
for(const overhead of [true,false])for(const closed of [true,false]){
  const base=overhead?14.35:.8,parts=[];
  if(!overhead)parts.push(box(0,.4,0,3.6,.8,1.5,1));
  for(const x of [-1.25,0,1.25]){
    for(const z of [-.5,.5])parts.push(cylinder(x,base+.375,z,.14,.14,.75,2));
    const blade=new BoxGeometry(.13,.13,1.1);
    if(!closed)blade.rotateX(-Math.PI/3);
    blade.translate(x,base+.8+(closed?0:.45),closed?0:-.24);
    parts.push({geometry:blade,material:9});
  }
  await model(`switch-${overhead?'overhead':'ground'}-${closed?'closed':'open'}`,parts);
}
