import {dashPath} from './flow-animation.js';
import {placeDistributionEquipment} from './equipment-placement.js';
// Adapted from di-app-athon/rea/rea/story/vendor/network-browser/network_3d.js.
// Same 15.1 m conductors, 14.8 m poles, 1.25 m phase spacing and 1.1 m sag.
// These are schematic display dimensions, never surveyed clearances or solver inputs.
export const DISTRIBUTION_STYLE=Object.freeze({height:15.1,poleHeight:14.8,phaseSpacing:1.25,maxSag:1.1,span:55,mergeRadius:6,detailRange:2400,maxDetailedLines:240,maxPoles:250,maxTransformers:40,maxSwitches:60});
const M=111320;
const distance=(a,b)=>Math.hypot((b[0]-a[0])*M*Math.cos((a[1]+b[1])*Math.PI/360),(b[1]-a[1])*M);
const offset=(p,e,n,z)=>[p[0]+e/(M*Math.cos(p[1]*Math.PI/180)),p[1]+n/M,z];
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const text=value=>typeof value==='string'?value:'';
export function construction(type,stdType){
  if(/^(cs|ug|cable|underground)$/i.test(text(type)))return {construction:'underground',construction_basis:'Source line type'};
  if(/^(ol|ohl|oh|overhead)$/i.test(text(type)))return {construction:'overhead',construction_basis:'Source line type'};
  if(/(?:^|[_ -])(UG|UD|URD|CABLE|JCN|ALJCN|CLP|EPR|PILC|CIC)(?:[_ -]|$)/i.test(text(stdType)))return {construction:'underground',construction_basis:'Cable standard-type label'};
  if(/(?:^|[_ -])(OH|OVERHEAD|ACSR|AAAC|AAC|ATW|CTW)(?:[_ -]|$)/i.test(text(stdType)))return {construction:'overhead',construction_basis:'Overhead conductor standard-type label'};
  return {construction:'overhead',construction_basis:'Schematic overhead display; installation type unspecified'};
}
// Enrich the display copy from the integrity-checked input document; no re-export
// of 4,137 models is needed, and the original solver bytes remain untouched.
export function distributionMetadata(geometry,model){
  const table=model.tables?.line,lines=new Map(),switches=new Map();
  if(table){
    const columns=Object.fromEntries(table.columns.map((name,i)=>[name,i]));
    table.data.forEach((row,i)=>{
      const key=String(Array.isArray(table.index[i])?table.index[i][0]:table.index[i]);
      let line=lines.get(key);
      if(!line){line={std_type:text(row[columns.std_type]),...construction(row[columns.type],row[columns.std_type]),phases:[]};lines.set(key,line);}
      const phase=row[columns.from_phase];if([1,2,3].includes(phase)&&!line.phases.includes(phase))line.phases.push(phase);
    });
  }
  const switchTable=model.tables?.switch;
  if(switchTable){
    const type=switchTable.columns.indexOf('type'),closed=switchTable.columns.indexOf('closed');
    switchTable.data.forEach((row,i)=>{
      const key=String(Array.isArray(switchTable.index[i])?switchTable.index[i][0]:switchTable.index[i]);
      const previous=switches.get(key);
      switches.set(key,{device_type:text(row[type]),closed:row[closed]===true&&previous?.closed!==false});
    });
  }
  const features=(geometry.solver?.features||[]).map(feature=>{
    const p=feature.properties,metadata=p.kind==='line'?lines.get(String(p.index)):p.kind==='switch'?switches.get(String(p.index)):null;
    return {...feature,properties:{...p,...metadata,phases:metadata?.phases?.length?metadata.phases:[2]}};
  });
  const incident=new Set(features.flatMap(f=>[f.properties.from_bus,f.properties.to_bus]));
  const isolated=new Set((model.tables?.bus?.index||[]).map(id=>Array.isArray(id)?id[0]:id).filter(id=>!incident.has(id))).size;
  return {...geometry,solver:{type:'FeatureCollection',features},provenance:{...geometry.provenance,isolated_buses_without_geometry:isolated,height_note:'Schematic conductors 15.1 m above terrain; pole locations, sag and transformer mounting are illustrative. Underground cables use dashed ground traces.'}};
}
export function distributionPlan(collection){
  const style=DISTRIBUTION_STYLE,features=collection.features||[],nodes=[],grid=new Map(),buses=new Map(),exactNodes=new Map();
  const reference=features.some(f=>f.properties?.coordinate_source==='gis_reference');
  const origin=features[0]?.geometry.coordinates[0]||[0,0],cos=Math.cos(origin[1]*Math.PI/180);
  function nodeAt(p){
    const exactKey=`${p[0]},${p[1]}`;
    if(reference&&exactNodes.has(exactKey))return exactNodes.get(exactKey);
    const x=(p[0]-origin[0])*M*cos,y=(p[1]-origin[1])*M,gx=Math.floor(x/style.mergeRadius),gy=Math.floor(y/style.mergeRadius);
    let best=null,d=style.mergeRadius;
    if(!reference)for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const node of grid.get(`${gx+dx},${gy+dy}`)||[]){const next=Math.hypot(node.x-x,node.y-y);if(next<d){best=node;d=next;}}
    if(best)return best;
    const node={id:nodes.length,point:p.slice(0,2),x,y,direction:[1,0],longest:0,supported:false,transformer:false};nodes.push(node);
    const key=`${gx},${gy}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(node);if(reference)exactNodes.set(exactKey,node);return node;
  }
  const overheadBuses=new Set(),undergroundBuses=new Set(),connectors=[],mountingByBus=new Map();
  for(const f of features){
    const p=f.properties,route=f.geometry.coordinates;if(f.geometry.type!=='LineString')continue;
    for(const [bus,point]of [[p.from_bus,route[0]],[p.to_bus,route.at(-1)]])if(!buses.has(bus))buses.set(bus,nodeAt(point));
    if(p.kind==='line')for(const bus of [p.from_bus,p.to_bus])(p.construction==='underground'?undergroundBuses:overheadBuses).add(bus);
    if(p.kind==='switch'){
      connectors.push([p.from_bus,p.to_bus]);
      if(/^(oh|ug)_transformer$/i.test(p.device_type||''))for(const bus of [p.from_bus,p.to_bus]){
        const mounted=/^oh_/i.test(p.device_type);mountingByBus.set(bus,mounted);
        (mounted?overheadBuses:undergroundBuses).add(bus);
      }
    }
  }
  // Propagate through electrical switches, never across transformers or cables.
  const adjacent=new Map();for(const [a,b]of connectors){if(!adjacent.has(a))adjacent.set(a,[]);if(!adjacent.has(b))adjacent.set(b,[]);adjacent.get(a).push(b);adjacent.get(b).push(a);}
  for(const set of [overheadBuses,undergroundBuses]){const queue=[...set];for(let i=0;i<queue.length;i++)for(const b of adjacent.get(queue[i])||[])if(!set.has(b)){set.add(b);queue.push(b);}}
  const entries=[],transformers=[],switches=[];
  for(const feature of features){
    const p=feature.properties,route=feature.geometry.coordinates;if(feature.geometry.type!=='LineString')continue;
    const from=buses.get(p.from_bus),to=buses.get(p.to_bus);
    const overhead=p.kind==='line'?p.construction!=='underground':p.coordinate_source==='gis_reference'?p.mounted===true:overheadBuses.has(p.from_bus)&&overheadBuses.has(p.to_bus);
    if(p.kind==='transformer'){
      const mounted=p.mounted??mountingByBus.get(p.from_bus)??overheadBuses.has(p.from_bus),known=p.coordinate_source==='gis_reference'||mountingByBus.has(p.from_bus)||mounted||undergroundBuses.has(p.from_bus);
      if(known&&from&&(reference||!transformers.some(t=>distance(t.point,from.point)<8))){
        transformers.push({id:feature.id,point:from.point,mounted,node:from});if(mounted){from.transformer=true;if(p.coordinate_source==='gis_reference')from.recordedSupport=true;}
      }
    }
    // oh_transformer/ug_transformer are source connection records for the
    // transformer, not additional load-break switches.
    if(p.kind==='switch'&&!/transformer/i.test(p.device_type||''))switches.push({id:feature.id,point:from.point,node:from,overhead,closed:p.closed??p.in_service});
    if(p.coordinate_source==='gis_reference'&&p.kind!=='line'){
      if(p.kind==='pole'||(p.kind==='switch'&&overhead)){from.supported=true;from.recordedSupport=true;}
      continue; // A recorded point device never creates an invented connector line.
    }
    const points=route.map(p=>[p[0],p[1],overhead?style.height:.15]);
    const spans=[];
    if(overhead){
      // Split long spans at illustrative supports, keeping shared bus frames at bends.
      for(let i=1;i<points.length;i++){
        const a=i===1?from:nodeAt(points[i-1]),b=i===points.length-1?to:nodeAt(points[i]);
        const count=Math.max(1,Math.ceil(distance(a.point,b.point)/style.span));
        let previous=a;
        for(let j=1;j<=count;j++){
          const next=j===count?b:nodeAt(lerp(a.point,b.point,j/count));
          spans.push([previous,next]);previous=next;
        }
      }
      for(const [a,b]of spans)for(const [node,other]of [[a,b],[b,a]]){
        node.supported=true;const dx=(other.point[0]-node.point[0])*M*cos,dy=(other.point[1]-node.point[1])*M,len=Math.hypot(dx,dy);
        if(len>node.longest){const sign=dx<0||(dx===0&&dy<0)?-1:1;node.direction=[dx/len*sign,dy/len*sign];node.longest=len;}
      }
    }
    entries.push({feature,overhead,points,spans,phases:p.phases?.length?p.phases:[2]});
  }
  function paths(entry,detailed=false){
    const routes=!entry.overhead?[entry.points]:(detailed?entry.phases:[2]).map(phase=>{
      const result=[];
      for(const [a,b]of entry.spans){
        const across=(phase-2)*style.phaseSpacing;
        const start=offset(a.point,-a.direction[1]*across,a.direction[0]*across,style.height),end=offset(b.point,-b.direction[1]*across,b.direction[0]*across,style.height);
        const length=distance(start,end),steps=length>3?8:1,sag=Math.min(style.maxSag,length*.018);
        for(let i=result.length?1:0;i<=steps;i++){const t=i/steps,p=lerp(start,end,t);p[2]-=4*sag*t*(1-t);result.push(p);}
      }
      return result.length>=2?result:entry.points;
    });
    if(entry.feature.properties.kind==='switch'&&entry.feature.properties.closed===false)return routes.flatMap(route=>[[route[0],lerp(route[0],route.at(-1),.35)],[lerp(route[0],route.at(-1),.65),route.at(-1)]]);
    return routes;
  }
  function displayPaths(entry,detailed=false){const routes=paths(entry,detailed);return entry.feature.properties.kind==='line'&&!entry.overhead?routes.flatMap(route=>dashPath(route)):routes;}
  const placed=placeDistributionEquipment(nodes,transformers,{metersPerLongitude:M*cos});
  return {entries,displayPaths,...placed,switches,paths};
}
export function nearbyDetails(plan,center,range){
  const style=DISTRIBUTION_STYLE,point=[center?.lng??0,center?.lat??0];
  if(!(range<=style.detailRange))return {lines:new Set(),poles:[],transformers:[],switches:[]};
  const radius=Math.max(160,Math.min(1500,range*.85));
  const nearest=items=>items.map(item=>({item,d:distance(point,item.point)})).filter(v=>v.d<=radius).sort((a,b)=>a.d-b.d).map(v=>v.item);
  const lines=plan.entries.filter(e=>e.overhead).map(e=>({entry:e,point:e.points[Math.floor(e.points.length/2)]}));
  return {lines:new Set(nearest(lines).slice(0,style.maxDetailedLines).map(v=>v.entry)),poles:nearest(plan.nodes).slice(0,style.maxPoles),transformers:nearest(plan.transformers.filter(t=>!t.displaySuppressed)).slice(0,style.maxTransformers),switches:nearest(plan.switches).slice(0,style.maxSwitches)};
}
