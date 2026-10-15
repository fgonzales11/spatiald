import {distributionPlan,nearbyDetails} from './distribution-geometry.js';
const EMPTY={type:'FeatureCollection',features:[]};
const COLORS={idle:'#64c9ff',loaded:'#64c9ff',loading:'#64c9ff',running:'#fbbf24',converged:'#3dff96',nonconverged:'#ff4c61',error:'#e7b75e'};
export function resultIndex(result){
  const index=new Map();
  if(result?.solved!==true)return index;
  for(const row of result.tables?.res_line||[]){
    const key=String(row.index),v=index.get(key)||{power:0,current:0,powerValid:true};
    if(Number.isFinite(row.p_from_mw))v.power+=row.p_from_mw;else v.powerValid=false;
    const current=Number.isFinite(row.i_ka)?row.i_ka:row.i_from_ka;if(Number.isFinite(current))v.current=Math.max(v.current,Math.abs(current));
    index.set(key,v);
  }
  return index;
}
export function simulationFeatures(layer){
  if(!layer?.visible || !layer.geometry)return EMPTY;
  const results=resultIndex(layer.result);
  const input=layer.geometry[layer.topology||'solver']?.features||[];
  return {type:'FeatureCollection',features:input.map(feature=>{
    const p=feature.properties||{},flow=p.kind==='line'?results.get(String(p.index)):null;
    const active=p.in_service!==false;
    return {...feature,properties:{...p,color:active?(COLORS[layer.status]||COLORS.idle):'#82919b',
      flow_current:active?flow?.current||0:0,flow_power:active&&flow?.powerValid?flow.power:null,flow_direction:active&&flow?.powerValid?Math.sign(flow.power):0,
      glowing:active&&['converged','nonconverged'].includes(layer.status),circuit_key:layer.circuit_key}};
  })};
}
export function createSimulation2D(map){
  let state=null,disposed=false,styleReady=map.isStyleLoaded();
  const waiting=new Set();
  const id='sce-simulation-network';
  function draw(){
    if(disposed || !styleReady)return;
    if(!map.getSource(id)){
      map.addSource(id,{type:'geojson',data:EMPTY});
      map.addLayer({id:id+'-glow',type:'line',source:id,filter:['==',['get','glowing'],true],paint:{'line-color':['get','color'],'line-width':10,'line-blur':5,'line-opacity':.55}});
      map.addLayer({id,type:'line',source:id,paint:{'line-color':['get','color'],'line-width':2.5}});
    }
    const data=simulationFeatures(state);map.getSource(id).setData(data);
  }
  function ready(){styleReady=true;queueMicrotask(()=>{draw();for(const resolve of waiting)resolve();waiting.clear();});}
  map.on('style.load',ready);map.on('idle',drawOnce);
  function drawOnce(){if(state&&!map.getSource(id))draw();}
  return {async set(next){state=next;if(!styleReady)await new Promise((resolve,reject)=>{const finish=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{waiting.delete(finish);reject(Error('The map style is still loading. Retry Load network.'));},20000);waiting.add(finish);});draw();},dispose(){disposed=true;for(const resolve of waiting)resolve();waiting.clear();map.off('style.load',ready);map.off('idle',drawOnce);}};
}
export function createSimulation3D(map,api){
  let state,elements=[],equipment=[],disposed=false,detailTimer,plan;
  const position=p=>({lng:p[0],lat:p[1],altitude:p[2]??.15});
  function clear(){for(const e of [...elements,...equipment])e.remove();elements=[];equipment=[];}
  function line(route,p,id){
    const line=new api.Polyline3DElement({path:route.map(position),altitudeMode:'RELATIVE_TO_GROUND',
      strokeColor:p.color,strokeWidth:p.glowing?2.2:1.7,outerColor:p.glowing?p.color+'24':p.color,outerWidth:p.glowing?.4:0,drawsOccludedSegments:false});
    line.dataset.simulationConstruction=p.construction||p.kind;line.dataset.simulationCircuit=state.circuit_key;line.dataset.elementId=String(id||p.kind);map.append(line);elements.push(line);
  }
  function draw(){
    if(disposed)return;clear();const data=simulationFeatures(state);
    if(state?.topology==='solver'&&plan){
      const nearby=nearbyDetails(plan,map.center,map.range);
      for(const entry of plan.entries){
        for(const route of plan.displayPaths(entry,nearby.lines.has(entry)))line(route,entry.feature.properties,entry.feature.id);
      }
      const mountedNodes=new Set(nearby.transformers.filter(t=>t.mounted).map(t=>t.node));
      if(api.Model3DElement){
        const model=(name,point,heading,kind)=>{
          const element=new api.Model3DElement({src:new URL(`simulation/equipment/${name}.glb`,new URL(import.meta.env?.BASE_URL||'/',location.origin)).href,
            position:position([...point,0]),altitudeMode:'RELATIVE_TO_GROUND',orientation:{heading,tilt:0,roll:0},scale:1});
          element.dataset.simulationEquipment=kind;element.dataset.simulationCircuit=state.circuit_key;
          element.setAttribute('aria-label',`Illustrative ${kind}; schematic dimensions and placement`);map.append(element);equipment.push(element);
        };
        const heading=node=>Math.atan2(node.direction[0],node.direction[1])*180/Math.PI;
        for(const pole of nearby.poles)if(!mountedNodes.has(pole))model('pole',pole.point,heading(pole),'utility pole');
        for(const transformer of nearby.transformers)model(transformer.mounted?'pole-transformer':'padmount-transformer',transformer.displayPoint||transformer.point,heading(transformer.node),transformer.mounted?'pole-mounted transformer':'pad-mounted transformer');
        for(const device of nearby.switches)model(`switch-${device.overhead?'overhead':'ground'}-${device.closed?'closed':'open'}`,device.point,heading(device.node),`switch ${device.closed?'closed':'open'}`);
      }
    }else{
      for(const feature of data.features){
        const geo=feature.geometry,routes=geo.type==='MultiLineString'?geo.coordinates:geo.type==='LineString'?[geo.coordinates]:[];
        for(const route of routes)line(route,feature.properties,feature.id);
      }
    }
  }
  function scheduleDetails(){clearTimeout(detailTimer);detailTimer=setTimeout(()=>{if(plan)draw();},160);}
  map.addEventListener?.('gmp-centerchange',scheduleDetails);map.addEventListener?.('gmp-rangechange',scheduleDetails);
  return {async set(next){
    if(disposed||state===next)return;state=next;
    plan=next?.topology==='solver'?distributionPlan(simulationFeatures(next)):null;draw();
  },dispose(){disposed=true;clearTimeout(detailTimer);map.removeEventListener?.('gmp-centerchange',scheduleDetails);map.removeEventListener?.('gmp-rangechange',scheduleDetails);clear();}};
}
