from pathlib import Path
import gzip,json,hashlib,math,sys,os
root=Path(__file__).resolve().parents[1];base=Path(os.environ.get('SIMULATION_ASSET_ROOT',root/'public/simulation'));catalog=json.loads((base/'catalog.json').read_text())
seen=set();totals={'models':0,'physical_buses':0,'physical_edges':0,'direct_node_anchors':0,'inferred_bus_positions':0,'distribution_circuit_links':0,'concat_circuit_links':0,'node_only_locations':0};unavailable=[]
for n in catalog['networks']:
 key=n['circuit_key'];assert key not in seen;seen.add(key)
 if not n['available']:unavailable.append(key);continue
 values=[]
 for kind in ['model','geometry']:
  data=gzip.decompress((base/n[kind+'_url']).read_bytes());assert len(data)==n[kind+'_bytes'];assert hashlib.sha256(data).hexdigest()==n[kind+'_sha256'];doc=json.loads(data);assert doc['circuit_key']==key;values.append(doc)
 model,geo=values
 for name,frame in model['tables'].items():
  assert len(frame['index'])==len(frame['data']);assert len(frame['columns'])==len(frame['dtypes']);assert not name.startswith('res_')
  assert all(len(row)==len(frame['columns']) for row in frame['data'])
 assert 'model' not in model['meta'] and 'converged' not in model['meta']
 for f in geo['solver']['features']:
  assert f['geometry']['type']=='LineString';assert len(f['geometry']['coordinates'])>=2
  for p in f['geometry']['coordinates']:assert len(p)==3 and all(math.isfinite(v) for v in p) and -180<=p[0]<=180 and -90<=p[1]<=90
 p=geo['provenance'];assert p['physical_edges']==len(geo['solver']['features']);assert p['physical_buses']==p['direct_ica_node_anchors']+p['inferred_bus_positions']
 assert all(math.isfinite(v) for v in geo['bounds'])
 if n['circuit_link']:
  assert n['circuit_link']['circuit_no']==key.rsplit('_',1)[-1]
  totals['distribution_circuit_links' if n['circuit_link']['source_layer']=='Distribution_Circuits' else 'concat_circuit_links']+=1
 else:totals['node_only_locations']+=1
 totals['models']+=1;totals['physical_buses']+=p['physical_buses'];totals['physical_edges']+=p['physical_edges'];totals['direct_node_anchors']+=p['direct_ica_node_anchors'];totals['inferred_bus_positions']+=p['inferred_bus_positions']
assert len(seen)==4138 and totals['models']==4137 and unavailable==['CKT_1469_18727']
report={'status':'passed','catalog_keys':len(seen),'totals':totals,'unavailable':unavailable,'checks':['all model/geometry hashes and byte sizes','matching circuit identities','all source table row/index/column counts','no cached solver state or results','finite geographic coordinates','source GIS circuit-number relationship','geometry counts and coordinate provenance']}
if len(sys.argv)>1: Path(sys.argv[1]).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
