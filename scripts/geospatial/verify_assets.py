"""Verify every published GIS reference asset against its sealed manifest."""
from pathlib import Path
from collections import Counter
import gzip,hashlib,json,time
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'public/simulation/geospatial';AUDIT=ROOT/'.analysis-data/geospatial-audit';AUDIT.mkdir(parents=True,exist_ok=True)
idx=json.loads((OUT/'index.json').read_text());stats=Counter();started=time.time()
for entry in idx['networks']:
 path=OUT/(entry['circuit_key']+'.json.gz');packed=path.read_bytes();raw=gzip.decompress(packed)
 assert len(raw)==entry['bytes']and hashlib.sha256(raw).hexdigest()==entry['sha256']
 assert len(packed)==entry['gzip_bytes']and hashlib.sha256(packed).hexdigest()==entry['gzip_sha256']
 doc=json.loads(raw);assert doc['circuit_key']==entry['circuit_key'];assert doc['provenance']['inferred_coordinates']is False;assert doc['provenance']['schematic_layout']is False
 for field in ['equipment','reference_routes','fallback_routes']:
  features=doc[field]['features'];assert len({f['id']for f in features})==len(features)
  for f in features:assert f['properties']['coordinate_source']=='gis_reference'
  stats[field]+=len(features)
 assert bool(doc['reference_routes']['features'])!=bool(doc['fallback_routes']['features'])
 stats['verified_networks']+=1;stats['gzip_bytes']+=len(packed)
stats['elapsed_seconds']=round(time.time()-started,2)
(AUDIT/'final-verification.json').write_text(json.dumps(dict(stats),indent=2));print(dict(stats))
