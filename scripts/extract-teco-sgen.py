"""Read TECO models and stage device-level sgen records for CSV export.

This reads models without changing or solving them. Each model/element is one
device; its circuit rows are summed, and coordinates come from its actual bus.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import pickle

import pandas as pd


def scalar(value):
    if value is None or pd.isna(value):
        return None
    return value.item() if hasattr(value, "item") else value


def unique(series, label, allow_empty=False):
    values = [scalar(v) for v in series]
    distinct = list(dict.fromkeys(values))
    if allow_empty and distinct == [None]:
        return None
    if len(distinct) != 1:
        raise ValueError(f"Conflicting {label}: {distinct}")
    return distinct[0]


def number_sum(series, multiplier=1):
    values = [scalar(v) for v in series]
    if any(v is None for v in values):
        return None
    if not all(math.isfinite(float(v)) for v in values):
        raise ValueError("Non-finite model power")
    return math.fsum(float(v) * multiplier for v in values)


def extract(root, selection):
    records, models = [], []
    files = sorted(root.rglob("*.pkl"))
    if not files:
        raise ValueError("No PKL files found")
    for path in files:
        with path.open("rb") as handle:
            net = pickle.load(handle)
        table = net["asymmetric_sgen"]
        assert table.index.is_unique
        assert isinstance(table.index, pd.MultiIndex) and table.index.nlevels == 2
        names = table["name"].fillna("").astype(str)
        mask = names.str.contains("PV", case=False, regex=False)
        selected = table if selection == "all" else table[mask]
        before = len(records)
        for element, circuits in selected.groupby(level=0, sort=True):
            bus_id = unique(circuits["bus"], "connected bus")
            name = unique(circuits["name"], "generator name", allow_empty=True)
            bus = net["bus"].xs(bus_id, level=0)
            geo = net["bus_geodata"].xs(bus_id, level=0)
            # x/y are projected coordinates. Use the explicitly named geographic
            # fields, and validate both aliases plus the bus GeoJSON when present.
            lat = float(unique(geo["latitude"], "bus latitude"))
            lon = float(unique(geo["longitude"], "bus longitude"))
            assert math.isfinite(lat) and math.isfinite(lon)
            assert -90 <= lat <= 90 and -180 <= lon <= 180
            assert all(math.isclose(float(v), lat, abs_tol=1e-10) for v in geo["Latitude"])
            assert all(math.isclose(float(v), lon, abs_tol=1e-10) for v in geo["Longitude"])
            validated_geojson = 0
            if "geo" in bus:
                for value in bus["geo"]:
                    if scalar(value) is None:
                        continue
                    point = json.loads(value) if isinstance(value, str) else value
                    assert point["type"] == "Point"
                    x, y = point["coordinates"][:2]
                    assert math.isclose(x, lon, abs_tol=1e-10) and math.isclose(y, lat, abs_tol=1e-10)
                    validated_geojson += 1
            source_table = unique(circuits["source_table"], "source table", True) if "source_table" in circuits else None
            source_row = unique(circuits["source_row"], "source row", True) if "source_row" in circuits else None
            records.append({
                "latitude": lat, "longitude": lon,
                "generator_name": str(name) if name is not None else None,
                "generator_id": scalar(element), "bus_id": bus_id,
                "bus_name": unique(bus["name"], "bus name"),
                "modeled_p_kw": number_sum(circuits["p_mw"], 1000),
                "modeled_q_kvar": number_sum(circuits["q_mvar"], 1000),
                "effective_p_kw": math.fsum(float(row.p_mw) * float(row.scaling) * 1000 if bool(row.in_service) else 0 for _, row in circuits.iterrows()),
                "rated_sn_kva": number_sum(circuits["sn_mva"], 1000),
                "circuit_row_count": len(circuits),
                "phase_connections": "; ".join(f"{int(row.from_phase)}-{int(row.to_phase)}" for _, row in circuits.iterrows()),
                "circuit_ids": "; ".join(str(i) for i in circuits.index.get_level_values(1)),
                "in_service": bool(unique(circuits["in_service"], "in-service status")),
                "name_contains_pv": bool(name is not None and "pv" in str(name).lower()),
                "technology": "unclassified in model",
                "source_table": source_table, "source_row": source_row,
                "coordinate_source": "bus_geodata.latitude/longitude joined on asymmetric_sgen.bus",
                "coordinate_provenance": unique(geo["coordinate_source"], "coordinate provenance", True),
                "bus_geojson_validated": validated_geojson > 0,
                "substation": path.parent.name,
                "feeder": path.stem.removeprefix("TECO_"),
                "source_model": str(path.relative_to(root)),
            })
        models.append({"source_model": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                       "sgen_rows": len(table), "sgen_devices": table.index.get_level_values(0).nunique(),
                       "pv_name_rows": int(mask.sum()), "exported_devices": len(records) - before})
    identities = [(r["source_model"], r["generator_id"]) for r in records]
    assert len(identities) == len(set(identities))
    return {
        "source_directory": str(root), "selection": selection,
        "extracted_utc": datetime.now(timezone.utc).isoformat(),
        "summary": {"models_read": len(files), "device_rows": len(records),
                    "sgen_circuit_rows": sum(m["sgen_rows"] for m in models),
                    "pv_name_rows": sum(m["pv_name_rows"] for m in models),
                    "with_coordinates": len(records),
                    "bus_geojson_validated": sum(r["bus_geojson_validated"] for r in records),
                    "unique_nonempty_generator_names": len({r["generator_name"] for r in records if r["generator_name"] is not None}),
                    "source_tables": dict(Counter(r["source_table"] or "not recorded" for r in records))},
        "models": models, "records": records,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/Users/admin/git/itron_pf_platform/pkls/core_product_client/teco"))
    parser.add_argument("--selection", choices=["pv", "all"], default="pv")
    parser.add_argument("--output", type=Path, required=True, help="JSON intermediate for CSV authoring")
    args = parser.parse_args()
    result = extract(args.source.resolve(), args.selection)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps(result["summary"], indent=2))
