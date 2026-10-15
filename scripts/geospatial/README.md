# SCE geospatial reference assets

These scripts build the display geometry from the user's GIS reference tables. They do not rewrite DuckDB, the geodatabase, PKLs, or electrical solver inputs.

Local prerequisites: Python with `duckdb`, `fiona`, and `pyproj`; `/Users/admin/db/db` and `/Users/admin/db/sce.gdb`; original local `public/simulation/geometry/*.json.gz` files for the old-versus-current completeness audit. DuckDB's spatial extension is needed only by the source-table verifier. Run from any directory, in this sequence:

```sh
python scripts/geospatial/verify_source_tables.py
python scripts/geospatial/export_references.py
python scripts/geospatial/finalize_references.py
python scripts/geospatial/add_partial_equipment.py
python scripts/geospatial/verify_assets.py
```

Intermediate audit reports go to `.analysis-data/geospatial-audit/`; final assets and the integrity manifest go to `public/simulation/geospatial/`. Do not publish between stages: `index.json` is finalized after all stages complete.

The source-table verifier compares every circuit and equipment OBJECTID, WKB geometry, and matching identity field between the selected DuckDB tables and original GDB layers. Circuit geometry uses the complete `Distribution_Circuits` record, with all cGIS OH/UG records only where no Distribution_Circuits record exists. Source geometry is transformed to WGS84 and rounded to seven decimal places; no inferred positions, snapping, graph layout, or PKL coordinates are used.

Transformer points join on exact circuit names, including a second circuit where recorded. The small Poles_Devices layer joins through exact source switch structure IDs. Four models have no circuit-number match in either route table: only ICA sections with exact matching model node IDs are included, explicitly marked as partial coverage. Their equipment joins only through unique exact model load structure IDs. These partial references must never be presented as complete circuits.

Construction is annotated only when a whole route part has exactly the same WGS84 vertices (in either orientation) as an OH/UG cGIS reference part. Other parts retain unknown construction. The source does not provide surveyed conductor or equipment heights; rendering heights remain illustrative.
