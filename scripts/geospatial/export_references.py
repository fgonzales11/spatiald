"""Read-only source GIS exporter; never modify source GDB, DuckDB, or PKLs."""
from pathlib import Path
from collections import defaultdict,Counter
import fiona,duckdb,json,gzip,hashlib,time,math
from pyproj import Transformer
ROOT=Path(__file__).resolve().parents[2];AUDIT=ROOT/'.analysis-data/geospatial-audit';AUDIT.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'public/simulation/geospatial'
GDB='/Users/admin/db/sce.gdb'
OUT.mkdir(parents=True,exist_ok=True)
started=time.time(); report={'source':GDB,'coordinate_system':'EPSG:4326','rounding_decimal_places':7,'sources_read_only':True}
c=duckdb.connect(':memory:');c.execute('SET threads=4');c.execute("ATTACH '/Users/admin/db/db' AS source (READ_ONLY)")
keys=[r[0]for r in c.execute('SELECT network_id FROM source.sce_networks.networks ORDER BY network_id').fetchall()]
by_no=defaultdict(list)
for key in keys:by_no[key.rsplit('_',1)[1]].append(key)
reference=defaultdict(list);construction=defaultdict(list);names=defaultdict(set);equipment=defaultdict(list);fallback=defaultdict(list)
point_expected=defaultdict(dict)
def fc(features):return {'type':'FeatureCollection','features':features}
def convert(geo,tr):
 def coords(v):
  if isinstance(v[0],(int,float)):
   x,y=tr.transform(v[0],v[1]);assert math.isfinite(x)and math.isfinite(y)and -180<=x<=180 and -90<=y<=90
   return [round(x,7),round(y,7)]
  return [coords(child)for child in v]
 return {'type':geo['type'],'coordinates':coords(geo['coordinates'])}
def feature(layer,oid,props,geometry):
 return {'type':'Feature','id':f'{layer}:{oid}','properties':{'id':f'{layer}:{oid}','objectid':int(oid),'source_table':layer,'coordinate_source':'gis_reference',**props},'geometry':geometry}
for layer in ['Distribution_Circuits','cGIS_Distribution_Circuits_GG_Concat']:
 with fiona.open(GDB,layer=layer)as src:
  tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
  for f in src:
   p=f['properties'];no=str(p.get('circuit_no')or p.get('CIRCUIT_NO')or '').zfill(5)
   if no not in by_no or not f['geometry']:continue
   name=p.get('circt_nam')or p.get('CIRCUIT_NAME')
   props={'kind':'gis_circuit','circuit_no':no,'circuit_name':name}
   if layer.startswith('cGIS'):props['construction']={'OH':'overhead','UG':'underground'}.get(p.get('CIRCUIT_OH_UG'),'unknown')
   item=feature(layer,f.id,props,convert(f['geometry'],tr))
   for key in by_no[no]:
    (reference if layer=='Distribution_Circuits' else construction)[key].append(item)
    if name:names[key].add(name.upper().strip())
 print('Read routes',layer,round(time.time()-started,1),flush=True)
for key in keys:
 if not reference[key]and construction[key]:reference[key]=construction[key][:]
name_to_keys=defaultdict(set)
for key,values in names.items():
 for name in values:name_to_keys[name].add(key)
assert all(len(v)==1 for v in name_to_keys.values()),'Ambiguous circuit names require explicit disambiguation.'
source_counts={};matched_source_counts={}
for layer,mounting in [('TCGOGESW_OH_TRANSFORMER_LOCATION','overhead'),('TCGOGESW_UG_TRANSFORMER_LOCATION','underground')]:
 seen=matched=0
 with fiona.open(GDB,layer=layer)as src:
  tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
  for f in src:
   seen+=1;p=f['properties'];name=str(p.get('CIRCUIT_NAME1')or '').upper().strip()
   matched_keys=name_to_keys.get(name)
   if not matched_keys or not f['geometry']:continue
   g=convert(f['geometry'],tr)
   item=feature(layer,f.id,{'structure_number':p.get('STRUCTURE_NUMBER_CONCAT')or p.get('STRUCTURE_NUMBER'),'kind':'transformer','mounting':mounting,'circuit_name':name,'match_basis':'exact_reference_circuit_name'},g)
   for key in matched_keys:equipment[key].append(item);point_expected[key][item['id']]=g['coordinates']
   matched+=1
 source_counts[layer]=seen;matched_source_counts[layer]=matched
 print('Read equipment',layer,seen,matched,round(time.time()-started,1),flush=True)
# These points have no circuit field. Use exact source switch asset identity,
# rather than numeric bus IDs or a geographic nearest-neighbour assignment.
with fiona.open(GDB,layer='Poles__Devices_')as src:
 poles=list(src);tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
 ids={str(f['properties'].get('SCE_STRUCTURE_NO')or '').strip()for f in poles};ids.discard('')
 matched_asset_networks=defaultdict(set)
 for key,asset in c.execute('''SELECT DISTINCT network_id,split_part(name,':',1)asset FROM source.sce_networks.switch WHERE split_part(name,':',1)IN(SELECT unnest(?))''',[list(ids)]).fetchall():matched_asset_networks[asset].add(key)
 for f in poles:
  p=f['properties'];asset=str(p.get('SCE_STRUCTURE_NO')or '').strip();matches=matched_asset_networks.get(asset)
  if not matches or not f['geometry']:continue
  g=convert(f['geometry'],tr);is_switch=p.get('SAP_OBJECT_TYPE')=='ED_SWITCH'
  item=feature('Poles_Devices',f.id,{'structure_number':asset,'kind':'switch'if is_switch else'pole','mounting':'overhead','match_basis':'exact_model_switch_structure_id'},g)
  for key in matches:equipment[key].append(item);point_expected[key][item['id']]=g['coordinates']
 source_counts['Poles_Devices']=len(poles);matched_source_counts['Poles_Devices']=sum(bool(matched_asset_networks.get(str(f['properties'].get('SCE_STRUCTURE_NO')or '').strip()))for f in poles)
missing=[key for key in keys if not reference[key]]
node_to_keys=defaultdict(set);model_bus_counts={}
for key,bus_id,name in c.execute('SELECT DISTINCT network_id,index,name FROM source.sce_networks.bus WHERE network_id IN(SELECT unnest(?))',[missing]).fetchall():
 node_to_keys[name].add(key);model_bus_counts[key]=model_bus_counts.get(key,0)+1
for layer in ['ICA___Circuit_Segments','ICA___Circuit_Segments__Non_3_Phase']:
 with fiona.open(GDB,layer=layer)as src:
  tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
  for f in src:
   p=f['properties'];node=str(p.get('node_id')or '');matched_keys=node_to_keys.get(node)
   if not matched_keys or not f['geometry']:continue
   item=feature(layer,f.id,{'kind':'gis_circuit','node_id':node,'section_id':p.get('section_id'),'circuit_name':p.get('circuit_name'),'phase':p.get('phase'),'construction':'unknown','match_basis':'exact_source_node_id'},convert(f['geometry'],tr))
   for key in matched_keys:fallback[key].append(item)
 print('Read fallback',layer,round(time.time()-started,1),flush=True)
index=[];audit=[]
for key in keys:
 selected=reference[key]or fallback[key]
 provenance={'coordinate_source':'gis_reference','coordinate_system':'EPSG:4326','geometry_complete':bool(reference[key]),'circuit_match':'exact_circuit_number'if reference[key]else'exact_node_id_partial','reference_tables':sorted({f['properties']['source_table']for f in selected}),'equipment_tables':sorted({f['properties']['source_table']for f in equipment[key]}),'equipment_match':'exact_reference_circuit_name_or_model_switch_structure_id','inferred_coordinates':False,'schematic_layout':False,'surveyed_heights':False}
 if not reference[key]:provenance['coverage_note']='Circuit number is absent from the circuit reference tables. Only GIS sections with node IDs present in this electrical model are shown; coverage is partial.';provenance['source_buses']=model_bus_counts.get(key,0)
 doc={'format':1,'circuit_key':key,'reference_routes':fc(reference[key]),'construction_routes':fc(construction[key]),'equipment':fc(equipment[key]),'fallback_routes':fc(fallback[key]),'provenance':provenance}
 raw=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode();packed=gzip.compress(raw,compresslevel=9,mtime=0);(OUT/f'{key}.json.gz').write_bytes(packed)
 counts={'equipment':len(equipment[key]),'transformers':sum(f['properties']['kind']=='transformer'for f in equipment[key]),'switches':sum(f['properties']['kind']=='switch'for f in equipment[key]),'poles':sum(f['properties']['kind']=='pole'for f in equipment[key]),'reference_features':len(reference[key]),'construction_features':len(construction[key]),'fallback_features':len(fallback[key]),'reference_parts':sum(len(f['geometry']['coordinates'])if f['geometry']['type']=='MultiLineString'else 1 for f in reference[key]),'fallback_parts':sum(len(f['geometry']['coordinates'])if f['geometry']['type']=='MultiLineString'else 1 for f in fallback[key])}
 index.append({'key':key,'url':f'geospatial/{key}.json.gz','sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'gzip_bytes':len(packed),'gzip_sha256':hashlib.sha256(packed).hexdigest(),'counts':counts,'coverage':'complete_circuit_reference'if reference[key]else'partial_exact_node_reference'})
 # Independently decode the saved bytes and verify every source equipment point
 # and every feature of the transformed circuit table survives serialization.
 saved=json.loads(gzip.decompress((OUT/f'{key}.json.gz').read_bytes()))
 assert{f['id']:f['geometry']['coordinates']for f in saved['equipment']['features']}==point_expected[key],key
 assert saved['reference_routes']['features']==reference[key]and saved['construction_routes']['features']==construction[key]and saved['fallback_routes']['features']==fallback[key],key
 # Audit the old cached geometry against all circuit features, after matching
 # its documented 7-decimal WGS84 conversion. Some fallback exports kept only
 # the first OH/UG cGIS row; the new reference includes both source rows.
 old=json.loads(gzip.decompress((ROOT/'public/simulation/geometry'/f'{key}.json.gz').read_bytes()))
 oldgeo=[f['geometry']for f in old['gis']['features']]
 target=[f['geometry']for f in reference[key]]
 if oldgeo!=target:audit.append({'key':key,'old_features':len(oldgeo),'reference_features':len(target),'reason':'all_reference_rows_preserved'})
manifest={'format':1,'source':'SCE geospatial reference tables','coordinate_system':'EPSG:4326','entries':index}
(OUT/'index.json').write_text(json.dumps(manifest,separators=(',',':')))
report.update({'networks':len(keys),'complete_circuit_references':sum(bool(reference[k])for k in keys),'partial_exact_node_references':len(missing),'source_equipment_records':source_counts,'matched_source_equipment_records':matched_source_counts,'exported_equipment_records':sum(len(equipment[k])for k in keys),'networks_with_equipment':sum(bool(equipment[k])for k in keys),'all_saved_points_and_routes_verified':True,'old_geometry_differences':audit,'missing_networks':[{'key':k,'source_buses':model_bus_counts[k],'fallback_sections':len(fallback[k]),'node_ids':len({f['properties']['node_id']for f in fallback[k]}),'equipment':len(equipment[k])}for k in missing],'total_gzip_bytes':sum(e['gzip_bytes']for e in index),'total_json_bytes':sum(e['bytes']for e in index),'elapsed_seconds':round(time.time()-started,2),'ckt114':next(e for e in index if e['key']=='CKT_114_16955')})
(AUDIT/'export-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items()if k!='old_geometry_differences'},indent=2),flush=True)
print('Old geometry differing networks',len(audit),audit[:20],flush=True)
