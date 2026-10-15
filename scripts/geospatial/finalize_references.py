"""Annotate exact GIS construction parts, add secondary-circuit assets, and audit."""
from pathlib import Path
from collections import defaultdict,Counter
import json,gzip,hashlib,fiona,duckdb
from pyproj import Transformer
ROOT=Path(__file__).resolve().parents[2];AUDIT=ROOT/'.analysis-data/geospatial-audit';AUDIT.mkdir(parents=True,exist_ok=True);OUT=ROOT/'public/simulation/geospatial'
index=json.loads((OUT/'index.json').read_text());names=defaultdict(set)
for e in index['entries']:
 key=e['key'];doc=json.loads(gzip.decompress((OUT/f'{key}.json.gz').read_bytes()))
 for f in doc['reference_routes']['features']+doc['construction_routes']['features']:
  n=str(f['properties'].get('circuit_name')or '').upper().strip()
  if n:names[n].add(key)
assert all(len(v)==1 for v in names.values())
c=duckdb.connect('/Users/admin/db/db',read_only=True)
secondary=defaultdict(list)
rows=c.execute('''SELECT OBJECTID,upper(trim(CIRCUIT_NAME2)),STRUCTURE_NUMBER,STRUCTURE_NUMBER_CONCAT FROM TCGOGESW_UG_TRANSFORMER_LOCATION WHERE CIRCUIT_NAME2 IS NOT NULL AND upper(trim(CIRCUIT_NAME2))!=upper(trim(CIRCUIT_NAME1))''').fetchall()
with fiona.open('/Users/admin/db/sce.gdb',layer='TCGOGESW_UG_TRANSFORMER_LOCATION')as src:
 tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
 for oid,name,number,concat in rows:
  if name not in names:continue
  f=src[oid];assert f and int(f.id)==oid
  p=f['properties'];assert str(p['CIRCUIT_NAME2']).upper().strip()==name
  x,y=tr.transform(*f['geometry']['coordinates'][:2]);identifier=f'TCGOGESW_UG_TRANSFORMER_LOCATION:{oid}'
  item={'type':'Feature','id':identifier,'properties':{'id':identifier,'objectid':oid,'source_table':'TCGOGESW_UG_TRANSFORMER_LOCATION','coordinate_source':'gis_reference','structure_number':concat or number,'kind':'transformer','mounting':'underground','circuit_name':name,'circuit_name_field':'CIRCUIT_NAME2','match_basis':'exact_reference_circuit_name'},'geometry':{'type':'Point','coordinates':[round(x,7),round(y,7)]}}
  for key in names[name]:secondary[key].append(item)
def parts(f):return f['geometry']['coordinates']if f['geometry']['type']=='MultiLineString'else[f['geometry']['coordinates']]
def signature(coords):
 a=tuple(tuple(p)for p in coords);b=tuple(reversed(a));return min(a,b)
coverage=Counter();entries=[];exact_networks=0
for e in index['entries']:
 key=e.pop('key');e['circuit_key']=key;path=OUT/f'{key}.json.gz';doc=json.loads(gzip.decompress(path.read_bytes()))
 original_reference=doc['reference_routes']['features'];original_points={f['id']:f['geometry']['coordinates']for f in doc['equipment']['features']}
 # Exact vertex-for-vertex comparison only; no tolerance, nearest line,
 # snapping, or geometric interpolation is used to claim construction.
 types=defaultdict(set)
 for f in doc['construction_routes']['features']:
  for part in parts(f):types[signature(part)].add(f['properties']['construction'])
 for f in doc['reference_routes']['features']:
  values=[next(iter(types[signature(p)]))if len(types[signature(p)])==1 else'unknown'for p in parts(f)]
  coverage.update(values);f['properties']['part_construction']=values
  if len(set(values))==1:f['properties']['construction']=values[0]
  if any(v!='unknown'for v in values):f['properties']['construction_basis']='Exact WGS84 route vertices, either orientation, matched to cGIS_Distribution_Circuits_GG_Concat.CIRCUIT_OH_UG'
 if any(v!='unknown'for f in doc['reference_routes']['features']for v in f['properties']['part_construction']):exact_networks+=1
 for item in secondary[key]:
  assert item['id']not in original_points
  doc['equipment']['features'].append(item);original_points[item['id']]=item['geometry']['coordinates']
 doc['provenance']['construction_reference']='cGIS_Distribution_Circuits_GG_Concat.CIRCUIT_OH_UG; exact part geometry only'
 doc['provenance']['equipment_tables']=sorted({f['properties']['source_table']for f in doc['equipment']['features']})
 # Construction routes duplicate the authoritative reference geometry; retain
 # exact matches on each reference part and the source audit, avoiding shipping
 # a second whole-network copy solely for an attribute lookup.
 doc.pop('construction_routes')
 doc['provenance']['construction_geometry_embedded']=False
 raw=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode();packed=gzip.compress(raw,compresslevel=9,mtime=0);path.write_bytes(packed)
 saved=json.loads(gzip.decompress(path.read_bytes()))
 assert [f['geometry']for f in saved['reference_routes']['features']]==[f['geometry']for f in original_reference]
 assert {f['id']:f['geometry']['coordinates']for f in saved['equipment']['features']}==original_points
 counts=e['counts'];counts['equipment']=len(doc['equipment']['features']);counts['transformers']=sum(f['properties']['kind']=='transformer'for f in doc['equipment']['features']);counts['secondary_circuit_transformers']=len(secondary[key]);counts['construction_parts']=dict(Counter(v for f in doc['reference_routes']['features']for v in f['properties']['part_construction']))
 e.update(sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw),gzip_sha256=hashlib.sha256(packed).hexdigest(),gzip_bytes=len(packed));entries.append(e)
index.pop('entries');index['networks']=entries;(OUT/'index.json').write_text(json.dumps(index,separators=(',',':')))
report=json.loads((AUDIT/'export-report.json').read_text());report.update({'exported_equipment_records':sum(e['counts']['equipment']for e in entries),'secondary_circuit_transformers':sum(map(len,secondary.values())),'construction_part_counts':dict(coverage),'networks_with_exact_construction_parts':exact_networks,'construction_geometry_removed_after_annotation':True,'total_gzip_bytes':sum(e['gzip_bytes']for e in entries),'total_json_bytes':sum(e['bytes']for e in entries),'ckt114':next(e for e in entries if e['circuit_key']=='CKT_114_16955'),'manifest_sha256':hashlib.sha256((OUT/'index.json').read_bytes()).hexdigest()})
(AUDIT/'export-report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items()if k!='old_geometry_differences'},indent=2))
