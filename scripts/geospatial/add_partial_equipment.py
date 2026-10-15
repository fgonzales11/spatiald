"""Add exact unique asset-ID GIS points for circuits absent from circuit tables."""
from pathlib import Path
from collections import defaultdict,Counter
import json,gzip,hashlib,duckdb,fiona
from pyproj import Transformer
ROOT=Path(__file__).resolve().parents[2];AUDIT=ROOT/'.analysis-data/geospatial-audit';AUDIT.mkdir(parents=True,exist_ok=True);OUT=ROOT/'public/simulation/geospatial'
idx=json.loads((OUT/'index.json').read_text());targets=[e['circuit_key']for e in idx['networks']if e['coverage']=='partial_exact_node_reference'];c=duckdb.connect('/Users/admin/db/db',read_only=True)
rows=c.execute('''WITH assets AS(SELECT DISTINCT network_id,name FROM sce_networks.asymmetric_load WHERE network_id IN(SELECT unnest(?))), eq AS(SELECT 'TCGOGESW_OH_TRANSFORMER_LOCATION'source_table,OBJECTID,STRUCTURE_NUMBER asset,CIRCUIT_NAME1 circuit,'overhead'mounting,STRUCTURE_NUMBER_CONCAT FROM TCGOGESW_OH_TRANSFORMER_LOCATION UNION ALL SELECT 'TCGOGESW_UG_TRANSFORMER_LOCATION',OBJECTID,STRUCTURE_NUMBER,CIRCUIT_NAME1,'underground',STRUCTURE_NUMBER_CONCAT FROM TCGOGESW_UG_TRANSFORMER_LOCATION)SELECT a.network_id,a.name,eq.source_table,eq.OBJECTID,eq.circuit,eq.mounting,eq.STRUCTURE_NUMBER_CONCAT FROM assets a JOIN eq ON eq.asset=a.name''',[targets]).fetchall()
counts=Counter((r[0],r[1])for r in rows);assert max(counts.values())==1,'Ambiguous asset IDs cannot establish GIS positions.'
by_table=defaultdict(list);by_key=defaultdict(list)
for row in rows:by_table[row[2]].append(row)
for table,items in by_table.items():
 with fiona.open('/Users/admin/db/sce.gdb',layer=table)as src:
  tr=Transformer.from_crs(src.crs_wkt,'EPSG:4326',always_xy=True)
  for key,asset,_,oid,name,mounting,concat in items:
   f=src[oid];assert f and int(f.id)==oid and f['properties']['STRUCTURE_NUMBER']==asset
   x,y=tr.transform(*f['geometry']['coordinates'][:2]);identifier=f'{table}:{oid}'
   by_key[key].append({'type':'Feature','id':identifier,'properties':{'id':identifier,'objectid':oid,'source_table':table,'coordinate_source':'gis_reference','structure_number':concat or asset,'kind':'transformer','mounting':mounting,'circuit_name':name,'match_basis':'exact_model_load_structure_id'},'geometry':{'type':'Point','coordinates':[round(x,7),round(y,7)]}})
for entry in idx['networks']:
 key=entry['circuit_key']
 if key not in by_key:continue
 p=OUT/f'{key}.json.gz';doc=json.loads(gzip.decompress(p.read_bytes()));assert doc['provenance']['geometry_complete']is False
 original={f['id']for f in doc['equipment']['features']};assert not(original&{f['id']for f in by_key[key]})
 doc['equipment']['features']+=by_key[key];doc['provenance']['equipment_tables']=sorted({f['properties']['source_table']for f in doc['equipment']['features']});doc['provenance']['equipment_match']='exact_model_load_structure_id; unique source GIS structure record per matched load name'
 raw=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode();packed=gzip.compress(raw,compresslevel=9,mtime=0);p.write_bytes(packed)
 entry.update(sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw),gzip_sha256=hashlib.sha256(packed).hexdigest(),gzip_bytes=len(packed));entry['counts']['equipment']=len(doc['equipment']['features']);entry['counts']['transformers']=sum(f['properties']['kind']=='transformer'for f in doc['equipment']['features']);entry['counts']['exact_asset_transformers']=len(by_key[key])
 saved=json.loads(gzip.decompress(p.read_bytes()));assert saved==doc
(OUT/'index.json').write_text(json.dumps(idx,separators=(',',':')))
report=json.loads((AUDIT/'export-report.json').read_text());report.update({'exported_equipment_records':sum(e['counts']['equipment']for e in idx['networks']),'networks_with_equipment':sum(e['counts']['equipment']>0 for e in idx['networks']),'partial_circuit_exact_asset_transformers':{k:len(v)for k,v in by_key.items()},'total_gzip_bytes':sum(e['gzip_bytes']for e in idx['networks']),'total_json_bytes':sum(e['bytes']for e in idx['networks']),'manifest_sha256':hashlib.sha256((OUT/'index.json').read_bytes()).hexdigest()})
for row in report['missing_networks']:row['equipment']=len(by_key[row['key']])
(AUDIT/'export-report.json').write_text(json.dumps(report,indent=2));print(json.dumps({'added':sum(map(len,by_key.values())),'per_circuit':report['partial_circuit_exact_asset_transformers'],'total_equipment':report['exported_equipment_records'],'manifest_sha256':report['manifest_sha256']}))
