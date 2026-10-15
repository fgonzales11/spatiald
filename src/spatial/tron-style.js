// MapLibre adaptation of tangrams/tron-style (MIT, Mapzen 2013–2016).
// References: tron-style.yaml, layers/roads.yaml and layers/buildings.yaml.
// Use the existing OpenMapTiles source; no Nextzen key or retired tile service.
export const TRON_REFERENCE='https://github.com/tangrams/tron-style';
export function tronStyle(base){
  const source=Object.keys(base.sources).find(key=>base.sources[key].type==='vector');
  if(!source)throw Error('TRON needs the vector street basemap.');
  const roads={source,'source-layer':'transportation'};
  const transit=['match',['get','class'],['rail','transit','ferry'],true,false];
  const width=['interpolate',['exponential',1.45],['zoom'],5,.4,10,.8,14,1.5,18,4];
  const major=['match',['get','class'],['motorway','trunk','primary'],true,false];
  const height=['max',0,['to-number',['coalesce',['get','render_height'],['get','height']],8]];
  const layers=[
    {id:'tron-background',type:'background',paint:{'background-color':'#263a56'}},
    {id:'tron-land',type:'fill',source,'source-layer':'landuse',paint:{'fill-color':'#30455f','fill-opacity':.45}},
    {id:'tron-park',type:'fill',source,'source-layer':'park',paint:{'fill-color':'#25495b','fill-opacity':.55}},
    {id:'tron-water',type:'fill',source,'source-layer':'water',paint:{'fill-color':'#142541'}},
    {id:'tron-grid-lines',type:'line',source:'tron-grid',paint:{'line-color':'#51becb','line-width':.5,'line-opacity':.16}},
    {id:'tron-shore-glow',type:'line',source,'source-layer':'water',paint:{'line-color':'#43ddd9','line-width':4,'line-blur':3,'line-opacity':.3}},
    {id:'tron-roads-glow',type:'line',...roads,filter:major,paint:{'line-color':'#00b5d0','line-width':['interpolate',['linear'],['zoom'],5,3,14,9,18,16],'line-blur':5,'line-opacity':.38}},
    {id:'tron-roads',type:'line',...roads,filter:['!',transit],paint:{'line-color':['case',major,'#8af7f2','#5794ba'],'line-width':width,'line-opacity':.9}},
    {id:'tron-road-center',type:'line',...roads,minzoom:14,filter:major,paint:{'line-color':'#c5fffc','line-width':.8,'line-opacity':.9}},
    {id:'tron-transit-glow',type:'line',...roads,filter:transit,paint:{'line-color':'#ec75ff','line-width':7,'line-blur':4,'line-opacity':.4}},
    {id:'tron-transit',type:'line',...roads,filter:transit,paint:{'line-color':'#e9b1ff','line-width':1.5,'line-dasharray':[3,2],'line-opacity':.9}},
    {id:'tron-buildings',type:'fill-extrusion',source,'source-layer':'building',minzoom:14,paint:{'fill-extrusion-color':['interpolate',['linear'],height,0,'#284361',30,'#345080',100,'#546598'],'fill-extrusion-height':height,'fill-extrusion-base':['max',0,['to-number',['get','render_min_height'],0]],'fill-extrusion-opacity':.85,'fill-extrusion-vertical-gradient':true}},
    {id:'tron-building-footprints',type:'line',source,'source-layer':'building',minzoom:14,paint:{'line-color':'#75b6d8','line-width':.65,'line-opacity':.6}},
    {id:'tron-boundaries',type:'line',source,'source-layer':'boundary',paint:{'line-color':'#8298d6','line-width':.7,'line-dasharray':[4,3],'line-opacity':.4}},
  ];
  // Street and water labels are useful context; place/POI symbols stay off.
  for(const layer of base.layers.filter(l=>l.type==='symbol'&&['transportation_name','water_name'].includes(l['source-layer'])&&l.layout?.['text-field']))layers.push({...layer,id:'tron-'+layer.id,paint:{...layer.paint,'text-color':'#a3c7e1','text-halo-color':'#233550','text-halo-width':1.2}});
  return {version:8,name:'TRON · Mapzen adaptation',metadata:{'spatial-d:style-reference':TRON_REFERENCE},...(base.glyphs?{glyphs:base.glyphs}:{}),...(base.sprite?{sprite:base.sprite}:{}),
    sources:{...base.sources,'tron-grid':{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers,
    light:{anchor:'viewport',color:'#b5e9ff',intensity:.5,position:[1.5,180,50]}};
}
export function tronGrid(bounds){
  const [west,south,east,north]=bounds;
  const target=Math.max(east-west,north-south)/30;
  const steps=[.0002,.0005,.001,.002,.005,.01,.02,.05,.1,.2,.5,1,2,5,10,20,30,60];
  const step=steps.find(v=>v>=target)||60,features=[];
  const add=coordinates=>features.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates}});
  for(let lng=Math.ceil(west/step)*step;lng<=east&&features.length<100;lng+=step)add([[lng,Math.max(-85,south)],[lng,Math.min(85,north)]]);
  for(let lat=Math.ceil(south/step)*step;lat<=north&&features.length<160;lat+=step)add([[west,lat],[east,lat]]);
  return {type:'FeatureCollection',features};
}
