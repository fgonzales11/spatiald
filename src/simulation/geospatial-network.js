// Map placement comes exclusively from the GIS reference tables. The numerical
// model supplies electrical counts, never coordinates or invented route geometry.
const collection=features=>({type:'FeatureCollection',features});
const valid=p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
const bus=p=>`gis:${p[0]},${p[1]}`;
export function geospatialNetwork(geometry,model,reference){
  if(reference.circuit_key!==model.circuit_key||geometry.circuit_key!==model.circuit_key)throw Error('The GIS reference and electrical circuit identities differ.');
  const recorded=reference.reference_routes?.features?.length?reference.reference_routes:reference.fallback_routes;
  const routes=[];
  for(const [i,feature]of (recorded?.features||[]).entries()){
    const paths=feature.geometry?.type==='MultiLineString'?feature.geometry.coordinates:feature.geometry?.type==='LineString'?[feature.geometry.coordinates]:[];
    for(const [j,path]of paths.entries()){
      if(path.length<2||!path.every(valid))throw Error('Invalid GIS reference route.');
      const installation=feature.properties?.part_construction?.[j]||feature.properties?.construction;
      const coordinates=path.map(p=>[p[0],p[1],installation==='underground'?.15:15.1]);
      const source=feature.properties?.source_table||feature.properties?.source_layer||geometry.provenance?.circuit_link?.source_layer;
      routes.push({type:'Feature',id:`gis-route:${i}:${j}`,properties:{...feature.properties,
        kind:'line',from_bus:bus(coordinates[0]),to_bus:bus(coordinates.at(-1)),
        coordinate_source:'gis_reference',source_table:source,
        construction:installation||'overhead',construction_basis:feature.properties?.construction_basis||'Illustrative overhead display where GIS installation is unspecified.',
        phases:[2],electrical_mapping:'circuit_only'},geometry:{type:'LineString',coordinates}});
    }
  }
  if(!routes.length)throw Error('No GIS reference route is available for this circuit. Electrical-model coordinates are not used for map placement.');
  // Electrical device state can be joined by the exact recorded structure ID;
  // this never supplies or changes its location.
  const switchStates=new Map(),switchTable=model.tables?.switch;
  if(switchTable){
    const name=switchTable.columns.indexOf('name'),closed=switchTable.columns.indexOf('closed');
    for(const row of switchTable.data){
      const structure=typeof row[name]==='string'?row[name].split(':')[0]:'';
      if(!structure||typeof row[closed]!=='boolean')continue;
      switchStates.set(structure,(switchStates.get(structure)??true)&&row[closed]);
    }
  }
  const devices=[];
  for(const [i,feature]of (reference.equipment?.features||[]).entries()){
    const p=feature.properties||{},point=feature.geometry?.coordinates;
    if(feature.geometry?.type!=='Point'||!valid(point))throw Error('Invalid GIS equipment location.');
    const id=feature.id||`${p.source_table}:${p.objectid??i}`,node=`gis-device:${id}`;
    devices.push({type:'Feature',id,properties:{...p,kind:p.kind||'transformer',from_bus:node,to_bus:node,
      ...(p.kind==='switch'&&switchStates.has(p.structure_number)?{closed:switchStates.get(p.structure_number),state_source:'exact_model_switch_structure_id'}:{}),
      coordinate_source:'gis_reference',mounted:p.mounting==='overhead',construction:p.mounting==='underground'?'underground':'overhead',
      electrical_mapping:'circuit_only',phases:[2]},geometry:{type:'LineString',coordinates:[[point[0],point[1],0],[point[0],point[1],0]]}});
  }
  const points=[...routes,...devices].flatMap(f=>f.geometry.coordinates);
  const bounds=points.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);
  const physicalLines=new Set((model.tables?.line?.index||[]).map(id=>Array.isArray(id)?id[0]:id)).size;
  const sourceBusCount=new Set((model.tables?.bus?.index||[]).map(id=>Array.isArray(id)?id[0]:id)).size;
  const partial=!reference.reference_routes?.features?.length;
  return {format:2,circuit_key:model.circuit_key,bounds,display_bounds:bounds,
    solver:collection([...routes,...devices]),gis:collection(routes.map(f=>({...f,geometry:{...f.geometry,coordinates:f.geometry.coordinates.map(p=>[p[0],p[1],.15])}}))),
    provenance:{...reference.provenance,physical_buses:sourceBusCount,physical_edges:geometry.provenance?.physical_edges??0,physical_lines:physicalLines,
      circuit_link:geometry.provenance?.circuit_link,coordinate_source:'gis_reference',gis_route_parts:routes.length,gis_equipment:devices.length,
      inferred_bus_positions:0,schematic_layout_buses:0,partial_reference:partial,
      coordinate_note:partial?'No full circuit route is present in the reference tables. Showing only recorded ICA sections with exact model node-ID matches; GIS coverage is partial.':'Full recorded GIS circuit route and equipment locations. Electrical model coordinates are not used.',
      height_note:'Conductor height (15.1 m), sag, and intermediate support poles are illustrative along the recorded route. Equipment uses GIS locations and OH/UG mounting; padmount symbols shift slightly when needed to clear poles. Dense groups of illustrative poles are hidden.',
      result_note:'The steady glow indicates circuit solve status. GIS sections are not assumed to match individual electrical line IDs.'}};
}
