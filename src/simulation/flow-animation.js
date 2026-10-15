import {sampleFlowPath} from './powerflow-display.js';
// DI platform reference: legacy/powerflow-display.js and legacy/scene.js.
// Direction is solved net active power; travel speed is illustrative, not electron velocity.
export const FLOW_STYLE=Object.freeze({speed:10,spacing:120,minLine:20,maxPerLine:4,maxParticles:240,tailSpacing:1.5,alpha:[.85,.5,.22]});
export function flowPaths(collection){
  const paths=[];let budget=FLOW_STYLE.maxParticles;
  for(const f of collection.features){
    const p=f.properties;
    if(f.geometry.type!=='LineString'||!(p.flow_current>1e-9)||!Number.isFinite(p.flow_power)||Math.abs(p.flow_power)<1e-9)continue;
    const points=f.geometry.coordinates,distances=[0];
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];
      distances.push(distances.at(-1)+Math.hypot((b[0]-a[0])*111320*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*111320,(b[2]??0)-(a[2]??0)));
    }
    const length=distances.at(-1);
    if(length<FLOW_STYLE.minLine)continue;
    paths.push({id:f.id,points,distances,length,direction:Math.sign(p.flow_power),current:p.flow_current,count:Math.min(FLOW_STYLE.maxPerLine,Math.max(1,Math.round(length/FLOW_STYLE.spacing)))});
  }
  // Spread the display budget across the entire network, rather than truncating one end.
  if(paths.length>budget){const all=[...paths];paths.length=0;for(let i=0;i<budget;i++)paths.push(all[Math.floor(i*all.length/budget)]);}
  for(let i=0;i<paths.length;i++){const path=paths[i];path.count=Math.min(path.count,Math.max(1,Math.floor(budget/(paths.length-i))));budget-=path.count;}
  return paths;
}
const wrap=(distance,length)=>((distance%length)+length)%length;
export function flowHeads(paths,seconds){
  return paths.flatMap(path=>Array.from({length:path.count},(_,i)=>({path,distance:wrap(path.length*(i+.5)/path.count+seconds*FLOW_STYLE.speed*path.direction,path.length)})));
}
export function flowPoints(paths,seconds){
  return flowHeads(paths,seconds).flatMap(({path,distance})=>FLOW_STYLE.alpha.flatMap((alpha,tail)=>{
    const d=distance-tail*Math.min(FLOW_STYLE.tailSpacing,path.length/12)*path.direction;
    if(d<0||d>path.length)return [];
    const position=[0,0,0];sampleFlowPath(path,d,position);
    return [{position,alpha,tail,id:path.id,direction:path.direction,current:path.current}];
  }));
}
// Clip tails at terminals and retain every bend/sag sample. Never join end to start.
export function flowTrail(path,distance,tail=0){
  const spacing=Math.min(FLOW_STYLE.tailSpacing,path.length/12);
  const a=distance-(tail+1)*spacing*path.direction,b=distance-tail*spacing*path.direction;
  if(Math.max(a,b)<0||Math.min(a,b)>path.length)return null;
  const start=Math.max(0,Math.min(a,b)),end=Math.min(path.length,Math.max(a,b));
  if(end-start<.001)return null;
  const first=[0,0,0],last=[0,0,0];sampleFlowPath(path,start,first);
  // sampleFlowPath wraps; an exact terminal is represented by the original last vertex.
  if(end===path.length)last.splice(0,3,...path.points.at(-1));else sampleFlowPath(path,end,last);
  return [first,...path.points.filter((_,i)=>path.distances[i]>start&&path.distances[i]<end),last];
}
export function dashPath(points,dash=5,gap=4){
  // Dash even short cable segments; this helper is independent of flow eligibility.
  const distances=[0];for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i];distances.push(distances.at(-1)+Math.hypot((b[0]-a[0])*111320*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*111320,(b[2]??0)-(a[2]??0)));}
  const path={points,distances,length:distances.at(-1)},routes=[];
  if(path.length<.001)return [points];
  const scale=Math.max(1,Math.ceil(path.length/((dash+gap)*16)));dash*=scale;gap*=scale;
  for(let start=0;start<path.length;start+=dash+gap){const end=Math.min(path.length,start+dash),a=[0,0,0],b=[0,0,0];sampleFlowPath(path,start,a);if(end===path.length)b.splice(0,3,...points.at(-1));else sampleFlowPath(path,end,b);routes.push([a,...points.filter((_,i)=>distances[i]>start&&distances[i]<end),b]);}
  return routes;
}
