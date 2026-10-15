"""Verify source GDB against the user's authoritative DuckDB import, read-only."""
from pathlib import Path
import duckdb,json,time
ROOT=Path(__file__).resolve().parents[2];AUDIT=ROOT/'.analysis-data/geospatial-audit';AUDIT.mkdir(parents=True,exist_ok=True)
c=duckdb.connect(':memory:');c.execute('LOAD spatial');c.execute("ATTACH '/Users/admin/db/db' AS reference (READ_ONLY)")
report={'duckdb':'/Users/admin/db/db','gdb':'/Users/admin/db/sce.gdb','read_only':True,'comparisons':[]}
sources=[('Distribution_Circuits','Distribution_Circuits',['circuit_no','circt_nam','circuit_id']),('TCGOGESW_OH_TRANSFORMER_LOCATION','TCGOGESW_OH_TRANSFORMER_LOCATION',['STRUCTURE_NUMBER','STRUCTURE_NUMBER_CONCAT','CIRCUIT_NAME1','SOURCE_PHASE']),('TCGOGESW_UG_TRANSFORMER_LOCATION','TCGOGESW_UG_TRANSFORMER_LOCATION',['STRUCTURE_NUMBER','STRUCTURE_NUMBER_CONCAT','CIRCUIT_NAME1','CIRCUIT_NAME2','EQUIP_TYPE']),('Poles_Devices','Poles__Devices_',['SCE_STRUCTURE_NO','SAP_OBJECT_TYPE','SCE_FLOC'])]
for table,layer,cols in sources:
 started=time.time();c.execute('CREATE OR REPLACE TEMP TABLE original AS SELECT * FROM ST_Read(?,layer=?)',['/Users/admin/db/sce.gdb',layer])
 row=c.execute(f'''SELECT count(*)joined_rows,count(*)FILTER(WHERE d.OBJECTID IS NULL)missing_in_duckdb,count(*)FILTER(WHERE s.OBJECTID IS NULL)missing_in_gdb,count(*)FILTER(WHERE ST_AsWKB(d.shape) IS DISTINCT FROM ST_AsWKB(s.shape))geometry_differences,count(*)FILTER(WHERE hash({','.join('d.'+col for col in cols)})IS DISTINCT FROM hash({','.join('s.'+col for col in cols)}))identity_differences FROM reference.main.{table} d FULL OUTER JOIN original s USING(OBJECTID)''').fetchone()
 item=dict(zip(['joined_rows','missing_in_duckdb','missing_in_gdb','geometry_differences','identity_differences'],row));item.update(table=table,layer=layer,identity_fields=cols,seconds=round(time.time()-started,2));report['comparisons'].append(item);print(item,flush=True)
 assert row[1:]==(0,0,0,0),item
report['verified_equal']=True
(AUDIT/'source-table-verification.json').write_text(json.dumps(report,indent=2))
