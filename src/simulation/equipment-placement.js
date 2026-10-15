// Render-only placement. Route vertices and recorded GIS equipment positions
// remain untouched; dense line geometry is not evidence of a row of poles.
export const EQUIPMENT_PLACEMENT=Object.freeze({clusterDistance:6,clusterSize:4,padClearance:4,padOffsetStep:4.25,padMaxOffset:25.5});
function indexPoints(points,size){
  const bins=new Map(),cell=p=>[Math.floor(p.x/size),Math.floor(p.y/size)];
  for(const point of points){const [x,y]=cell(point),key=`${x},${y}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(point);}
  return (point,radius)=>{
    const [x,y]=cell(point),reach=Math.ceil(radius/size),found=[];
    for(let dx=-reach;dx<=reach;dx++)for(let dy=-reach;dy<=reach;dy++)for(const other of bins.get(`${x+dx},${y+dy}`)||[])
      if(Math.hypot(other.x-point.x,other.y-point.y)<=radius)found.push(other);
    return found;
  };
}
export function placeDistributionEquipment(nodes,transformers,{metersPerLongitude}){
  const style=EQUIPMENT_PLACEMENT,supported=nodes.filter(n=>n.supported);
  const generated=supported.filter(n=>!n.recordedSupport&&!n.transformer),nearGenerated=indexPoints(generated,style.clusterDistance);
  const visited=new Set(),suppressed=new Set();let clusters=0;
  // Inspect the complete circuit before viewport/LOD culling. Once a dense
  // connected group is found, hide every generated pole in it (no thinning).
  for(const seed of generated){
    if(visited.has(seed))continue;
    const component=[seed];visited.add(seed);
    for(let i=0;i<component.length;i++)for(const other of nearGenerated(component[i],style.clusterDistance))if(!visited.has(other)){visited.add(other);component.push(other);}
    if(component.length>=style.clusterSize){clusters++;for(const node of component)suppressed.add(node);}
  }
  const recorded=[...new Set([...nodes.filter(n=>n.recordedSupport),...transformers.filter(t=>t.mounted).map(t=>t.node)])];
  const nearRecorded=indexPoints(recorded,style.clusterDistance);
  // A recorded pole or pole-mounted transformer already supplies its support.
  for(const node of generated)if(nearRecorded(node,style.clusterDistance).length)suppressed.add(node);
  const poles=supported.filter(n=>!suppressed.has(n));
  const poleLocations=[...new Set([...poles,...transformers.filter(t=>t.mounted).map(t=>t.node)])];
  const nearPole=indexPoints(poleLocations,style.padClearance);
  let moved=0,hidden=0;
  const placed=transformers.map(transformer=>{
    if(transformer.mounted)return transformer;
    const source=transformer.node,collisions=nearPole(source,style.padClearance);
    if(!collisions.length)return transformer;
    collisions.sort((a,b)=>Math.hypot(a.x-source.x,a.y-source.y)-Math.hypot(b.x-source.x,b.y-source.y)||a.id-b.id);
    const closest=collisions[0],dx=source.x-closest.x,dy=source.y-closest.y;
    const angle=Math.hypot(dx,dy)>.01?Math.atan2(dy,dx):Math.atan2(closest.direction[0],-closest.direction[1]);
    for(let ring=1;ring<=style.padMaxOffset/style.padOffsetStep;ring++){
      for(const step of [0,1,-1,2,-2,3,-3,4,5,-5,6,-6,7,-7,8]){
        const theta=angle+step*Math.PI/8,east=Math.cos(theta)*ring*style.padOffsetStep,north=Math.sin(theta)*ring*style.padOffsetStep;
        if(nearPole({x:source.x+east,y:source.y+north},style.padClearance).length)continue;
        moved++;
        return {...transformer,displayPoint:[transformer.point[0]+east/metersPerLongitude,transformer.point[1]+north/111320],displayOffsetMeters:Math.hypot(east,north)};
      }
    }
    // An implausibly crowded recorded site has no safe bounded symbol position.
    // Keep its source record, but never draw a cabinet through a pole shaft.
    hidden++;return {...transformer,displaySuppressed:true};
  });
  return {nodes:poles,transformers:placed,placement:{suppressedGeneratedPoles:suppressed.size,densePoleClusters:clusters,offsetPadmounts:moved,hiddenPadmounts:hidden}};
}
