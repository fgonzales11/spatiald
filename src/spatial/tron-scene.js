import {GeoJsonLayer,PathLayer} from '@deck.gl/layers';
import {ScenegraphLayer} from '@deck.gl/mesh-layers';
import {distributionPlan,nearbyDetails} from '../simulation/distribution-geometry.js';
import {simulationFeatures} from '../simulation/map-layer.js';
import {applyTronSettings,tronPreferences} from './tron-settings.js';
import {tronGrid,TRON_REFERENCE} from './tron-style.js';

const rgba=color=>[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16),255];
export function createTronScene(map,{setLayers,onError,settings:initialSettings}){
  let state,plan,buildings=[],baseLayers=[],timer,disposed=false,styleReady=map.isStyleLoaded();
  let settings=tronPreferences(initialSettings);
  const waiting=new Set();
  const host=map.getContainer();host.dataset.mapView='tron';
  const credit=document.createElement('a');credit.className='tron-credit';credit.href=TRON_REFERENCE;credit.target='_blank';credit.rel='noopener noreferrer';credit.textContent='TRON design · Mapzen';host.append(credit);
  function equipmentLayers(nearby){
    const groups=new Map(),mounted=new Set(nearby.transformers.filter(t=>t.mounted).map(t=>t.node));
    const heading=node=>Math.atan2(node.direction[0],node.direction[1])*180/Math.PI;
    const add=(model,point,node)=>{if(!groups.has(model))groups.set(model,[]);groups.get(model).push({position:[...point,0],heading:heading(node)});};
    for(const pole of nearby.poles)if(!mounted.has(pole))add('pole',pole.point,pole);
    for(const t of nearby.transformers)add(t.mounted?'pole-transformer':'padmount-transformer',t.displayPoint||t.point,t.node);
    for(const s of nearby.switches)add(`switch-${s.overhead?'overhead':'ground'}-${s.closed?'closed':'open'}`,s.point,s.node);
    host.dataset.tronEquipment=String([...groups.values()].reduce((n,items)=>n+items.length,0));
    return [...groups].map(([name,data])=>new ScenegraphLayer({id:'tron-equipment-'+name,data,
      scenegraph:new URL(`simulation/equipment/${name}.glb`,new URL(import.meta.env.BASE_URL,location.origin)).href,
      getPosition:d=>d.position,getOrientation:d=>[0,-d.heading,0],getColor:[255,255,255,255],sizeScale:1,_lighting:'pbr',
      pickable:false,onError:error=>onError?.(`TRON equipment could not load: ${error.message}`)}));
  }
  function update(){
    if(disposed||!styleReady||!map.getStyle())return;
    settings=applyTronSettings(map,settings);
    const bounds=map.getBounds(),center=map.getCenter();
    map.getSource('tron-grid')?.setData(tronGrid([bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()]));
    const source=Object.keys(map.getStyle().sources).find(key=>map.getStyle().sources[key].type==='vector');
    const seen=new Set();buildings=[];
    if(settings.buildings&&source&&map.getZoom()>=14)for(const f of map.querySourceFeatures(source,{sourceLayer:'building'})){
      const key=String(f.id??f.properties.osm_id??JSON.stringify(f.geometry.coordinates[0]?.[0]));
      if(seen.has(key))continue;seen.add(key);buildings.push(f.toJSON());if(buildings.length>=2500)break;
    }
    host.dataset.tronBuildings=String(buildings.length);
    baseLayers=[new GeoJsonLayer({id:'tron-building-wireframe',data:{type:'FeatureCollection',features:buildings},extruded:true,filled:false,stroked:true,wireframe:true,
      getElevation:f=>Math.max(0,Number(f.properties.render_height??f.properties.height)||8)+.05,getLineColor:[128,190,224,170],getLineWidth:1,lineWidthUnits:'pixels',pickable:false})];
    const data=simulationFeatures(state),routes=[];
    if(plan){
      const range=156543.03*Math.cos(center.lat*Math.PI/180)/2**map.getZoom()*host.clientHeight*.65;
      const nearby=nearbyDetails(plan,center,range);
      for(const entry of plan.entries){
        for(const path of plan.displayPaths(entry,nearby.lines.has(entry)))routes.push({path,color:rgba(entry.feature.properties.color),glowing:entry.feature.properties.glowing});
      }
      baseLayers.push(...equipmentLayers(nearby));
    }else{
      host.dataset.tronEquipment='0';
      for(const f of data.features){const paths=f.geometry.type==='MultiLineString'?f.geometry.coordinates:[f.geometry.coordinates];for(const path of paths)routes.push({path:path.map(p=>[p[0],p[1],.15]),color:rgba(f.properties.color),glowing:f.properties.glowing});}
    }
    if(routes.length){
      baseLayers.push(new PathLayer({id:'tron-network-glow',data:routes.filter(r=>r.glowing),getPath:r=>r.path,getColor:r=>[...r.color.slice(0,3),30],getWidth:6,widthUnits:'pixels',parameters:{depthCompare:'less-equal',depthWriteEnabled:false}}),
        new PathLayer({id:'tron-network',data:routes,getPath:r=>r.path,getColor:r=>r.color,getWidth:1.8,widthUnits:'pixels',parameters:{depthCompare:'less-equal',depthWriteEnabled:false}}));
    }
    host.dataset.tronConnections=String(routes.length);
    host.dataset.tronNetworkState=state?.status||'';
    host.dataset.tronFlowCount='0';host.dataset.tronFlowPhase='';
    host.dataset.tronGlowCount=String(routes.filter(r=>r.glowing).length);
    host.dataset.simulationAnimation='none';setLayers(baseLayers);
  }
  function schedule(event){if(event?.sourceId==='tron-grid')return;clearTimeout(timer);timer=setTimeout(update,140);}
  function ready(){styleReady=true;queueMicrotask(()=>{update();for(const resolve of waiting)resolve();waiting.clear();});}
  map.on('style.load',ready);map.on('moveend',schedule);map.on('sourcedata',schedule);
  return {async set(next){
    state=next;plan=next?.topology==='solver'?distributionPlan(simulationFeatures(next)):null;
    host.dataset.suppressedGeneratedPoles=String(plan?.placement.suppressedGeneratedPoles||0);host.dataset.offsetPadmounts=String(plan?.placement.offsetPadmounts||0);
    if(!styleReady)await new Promise((resolve,reject)=>{const finish=()=>{clearTimeout(timeout);resolve();};const timeout=setTimeout(()=>{waiting.delete(finish);reject(Error('TRON is still loading. Retry Load network.'));},20000);waiting.add(finish);});
    update();
  },configure(value){settings=tronPreferences(value);applyTronSettings(map,settings);update();},styleChanging(){styleReady=false;},
    dispose(){disposed=true;clearTimeout(timer);for(const resolve of waiting)resolve();waiting.clear();map.off('style.load',ready);map.off('moveend',schedule);map.off('sourcedata',schedule);setLayers([]);credit.remove();delete host.dataset.mapView;}};
}
