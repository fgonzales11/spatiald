import math
from shapely.geometry import shape, mapping, box, GeometryCollection
from shapely.ops import transform, unary_union, nearest_points
from shapely import make_valid
from shapely import STRtree
from pyproj import CRS, Geod, Transformer

GEOD = Geod(ellps="WGS84")
HAZARDS = {"flood", "landslide", "debris_flow", "liquefaction", "fault", "weather"}


def geometry(value, wgs84=True):
    try:
        g = shape(value)
        if g.is_empty or not g.is_valid:
            raise ValueError("Geometry is empty or invalid; correct the source before analysis")
        if wgs84:
            w, s, e, n = g.bounds
            if not all(math.isfinite(v) for v in g.bounds) or w < -180 or e > 180 or s < -90 or n > 90:
                raise ValueError("Coordinates must be valid WGS84 longitude/latitude")
        return g
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("Invalid GeoJSON geometry") from error


def collection(value, allow_unresolved=False):
    if value.get('crs') and value['crs'].get('properties',{}).get('name') not in ('EPSG:4326','urn:ogc:def:crs:OGC:1.3:CRS84','urn:ogc:def:crs:EPSG::4326'):
        raise ValueError('GeoJSON must declare WGS84 coordinates; transform other coordinate systems before importing')
    if value.get("type") == "Feature":
        value = {"type": "FeatureCollection", "features": [value]}
    if value.get("type") != "FeatureCollection" or not isinstance(value.get("features"), list):
        raise ValueError("A GeoJSON FeatureCollection is required")
    seen = set()
    for i, f in enumerate(value["features"]):
        if f.get("type") != "Feature" or not isinstance(f.get("properties", {}), (dict, type(None))):
            raise ValueError("Invalid GeoJSON feature")
        if f.get("geometry") is not None:
            geometry(f["geometry"])
        elif not allow_unresolved:
            raise ValueError("A feature has unresolved geometry")
        key = str(f.get("id", i))
        if key in seen:
            raise ValueError("Duplicate feature identities")
        seen.add(key)
    return value


def metric_transform(g):
    c = g.centroid
    crs = CRS.from_proj4(f"+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84 +units=m")
    return Transformer.from_crs(4326, crs, always_xy=True).transform, Transformer.from_crs(crs, 4326, always_xy=True).transform


def buffer_metres(g, distance):
    if not math.isfinite(distance) or distance < 0:
        raise ValueError("Buffer must be a finite nonnegative distance in metres")
    if distance == 0:
        return g
    forward, inverse = metric_transform(g)
    return transform(inverse, transform(forward, g).buffer(distance))


def metrics(g):
    length, area = 0., 0.
    if g.is_empty:
        return {"lengthM": 0., "areaM2": 0.}
    if g.geom_type in ("LineString", "LinearRing"):
        length = GEOD.geometry_length(g)
    elif g.geom_type == "Polygon":
        exterior = abs(GEOD.geometry_area_perimeter(g.exterior)[0])
        area = max(0., exterior - sum(abs(GEOD.geometry_area_perimeter(r)[0]) for r in g.interiors))
    elif hasattr(g, "geoms"):
        for part in g.geoms:
            result = metrics(part)
            length += result["lengthM"]
            area += result["areaM2"]
    return {"lengthM": length, "areaM2": area}


def feature(g, properties=None, identity=None):
    return {"type": "Feature", "geometry": mapping(g), "properties": properties or {}, **({"id": identity} if identity else {})}


def exposure(snapshot, layers, aoi, fault_buffer=0., check=lambda *_: None, as_of=None):
    region = geometry(aoi)
    hazard_parts, coverage_parts, evidence = [], [], []
    unresolved = []
    for layer in layers:
        if layer.get("hazardType") not in HAZARDS:
            raise ValueError("Select hazard layers for exposure analysis")
        parts = []
        for i, f in enumerate(layer["data"]["features"]):
            if f.get("geometry") is None:
                unresolved.append({"layerId": layer["id"], "featureId": f.get("id", i)})
                continue
            if layer["hazardType"] == "weather" and (f.get("properties") or {}).get("expires"):
                # Alert timing is evaluated against the captured analysis time, not a replayed current feed.
                from datetime import datetime
                try:
                    expires = datetime.fromisoformat(f["properties"]["expires"].replace("Z", "+00:00"))
                    capture = datetime.fromisoformat((as_of or snapshot["capturedAt"]).replace("Z", "+00:00"))
                    effective = f["properties"].get("effective")
                    if expires <= capture or effective and datetime.fromisoformat(effective.replace("Z", "+00:00")) > capture:
                        continue
                except (ValueError, KeyError, TypeError):
                    unresolved.append({"layerId": layer["id"], "featureId": f.get("id", i), "reason": "Alert timing is unresolved"})
                    continue
            g = geometry(f["geometry"])
            if layer["hazardType"] == "fault":
                g = buffer_metres(g, float(fault_buffer))
            g = g.intersection(region)
            if not g.is_empty:
                parts.append(g)
                evidence.append((layer, f, g))
        hazard_parts.extend(parts)
        coverage_parts.append(geometry(layer["coverageGeometry"]).intersection(region)
                              if layer.get("complete") and layer.get("coverageGeometry") else GeometryCollection())
    combined = unary_union(hazard_parts)
    tree = STRtree([g for _, _, g in evidence]) if evidence else None
    snapshot_coverage = geometry(snapshot['coverageGeometry']) if snapshot.get('coverageGeometry') else None
    rows, drawn = [], []
    all_covered = bool(layers) and not unresolved
    for i, asset in enumerate(snapshot["bundle"]["assets"]):
        check(i / max(1, len(snapshot["bundle"]["assets"])))
        raw = geometry(asset["geometry"])
        local = raw.intersection(region)
        if local.is_empty:
            continue
        asset_covered = bool(snapshot.get("complete") and snapshot_coverage is not None and snapshot_coverage.covers(local))
        assessed = all_covered and asset_covered and all(g.covers(local) for g in coverage_parts)
        clipped = local.intersection(combined)
        exposed = not clipped.is_empty
        details = []
        for index in tree.query(local, predicate='intersects') if tree is not None else []:
            layer, f, g = evidence[int(index)]
            overlap = local.intersection(g)
            if not overlap.is_empty:
                details.append({"layerId": layer["id"], "hazardType": layer["hazardType"],
                                "featureId": f.get("id"), "properties": {k:v for k,v in (f.get("properties") or {}).items() if k != 'sourceGeometry'},
                                "contact": "touch" if local.touches(g) else "crossing" if local.crosses(g) else "overlap",
                                **metrics(overlap), "geometry": mapping(overlap)})
        attr = asset.get("attributes", {})
        criticality = attr.get("criticality", "Unknown") if attr.get("criticalityVerified") is True else "Unknown"
        row = {"assetId": asset["id"], "name": asset["name"], "assetType": asset["assetType"],
               "status": "exposed" if exposed else "not_exposed" if assessed else "insufficient_data" if unresolved else "not_assessed",
               "assessmentComplete": assessed, "criticality": criticality,
               **metrics(clipped), "hazards": details,
               "checklist": {"hazardEvidence": bool(details), "criticalityVerified": criticality != "Unknown",
                             "coverageComplete": assessed, "geometryValid": True, "communityImpact": "Not inferred",
                             "sources": [{"layerId": l["id"], "fetchedAt": l.get("fetchedAt"),
                                          "sourceUpdatedAt": l.get("sourceUpdatedAt"), "sourceUrl": l.get("sourceUrl")} for l in layers]}}
        rows.append(row)
        if exposed:
            drawn.append(feature(clipped, {k:v for k,v in row.items() if k not in ('hazards','checklist')}, asset["id"]))
    counts = {state: sum(r["status"] == state for r in rows) for state in ("exposed", "not_exposed", "not_assessed", "insufficient_data")}
    return {"rows": rows, "summary": {**counts, "exposedLengthM": sum(r["lengthM"] for r in rows),
             "exposedAreaM2": sum(r["areaM2"] for r in rows), "byType": {t: sum(r["status"] == "exposed" and r["assetType"] == t for r in rows) for t in sorted({r["assetType"] for r in rows})}},
            "data": {"type": "FeatureCollection", "features": drawn}, "unresolvedHazards": unresolved,
            "assumptions": {"faultBufferM": fault_buffer, "analysisAt": as_of or snapshot.get('capturedAt'), "interpretation": "Spatial exposure; no outage or failure inference"}}


def identity(asset, bundle):
    dataset = next((d for d in bundle.get("datasets", []) if d["id"] == asset["datasetId"]), {})
    return (dataset.get("sourceId", asset["datasetId"]), asset.get("externalId", asset["id"]))


def compare_snapshots(before, after):
    a = {identity(x, before["bundle"]): x for x in before["bundle"]["assets"]}
    b = {identity(x, after["bundle"]): x for x in after["bundle"]["assets"]}
    comparable = bool(before.get("complete") and after.get("complete") and before.get("coverageGeometry") and after.get("coverageGeometry")
                      and geometry(before["coverageGeometry"]).equals(geometry(after["coverageGeometry"])))
    rows = []
    for key in sorted(a.keys() | b.keys()):
        x, y = a.get(key), b.get(key)
        state = "added" if not x else ("removed" if comparable else "not_assessed") if not y else None
        if x and y:
            moved = not geometry(x["geometry"]).equals_exact(geometry(y["geometry"]), 0)
            changed = any(x.get(k) != y.get(k) for k in ("attributes", "status", "name", "assetType"))
            if moved or changed:
                state = "moved_and_changed" if moved and changed else "moved" if moved else "attributes_changed"
        if state:
            rows.append({"sourceId": key[0], "externalId": key[1], "assetId": (y or x)["id"],
                         "change": state, "before": x, "after": y})
    return {"rows": rows, "removalsAssessed": comparable, "beforeId": before["id"], "afterId": after["id"]}


def spatial_operation(operation, left, right=None, distance=0):
    a = [f for f in collection(left)["features"] if f.get("geometry")]
    b = [f for f in collection(right or {"type": "FeatureCollection", "features": []})["features"] if f.get("geometry")]
    target = unary_union([geometry(f["geometry"]) for f in b])
    output, rows = [], []
    if operation == "dissolve":
        g = unary_union([geometry(f["geometry"]) for f in a])
        if not g.is_empty:
            output.append(feature(g, metrics(g)))
            rows.append(metrics(g))
    else:
        for i, f in enumerate(a):
            g = geometry(f["geometry"])
            props = {**(f.get("properties") or {}), "sourceFeatureId": f.get("id", i)}
            if operation == "buffer":
                g = buffer_metres(g, float(distance))
            elif operation in ("intersection", "clip"):
                if not b:
                    raise ValueError("A second layer is required")
                g = g.intersection(target)
            elif operation in ("nearest", "spatial_join"):
                if right is None:
                    raise ValueError('A second layer is required')
                candidates = []
                for j, other in enumerate(b):
                    h = geometry(other["geometry"])
                    p, q = nearest_points(g, h)
                    metres = GEOD.inv(p.x, p.y, q.x, q.y)[2]
                    if operation == "nearest" or g.intersects(h):
                        candidates.append((metres, j, other))
                if operation == "nearest":
                    candidates = sorted(candidates, key=lambda v: (v[0], v[1]))[:1]
                props["matches"] = [{"featureId": other.get("id", j), "distanceM": metres, "properties": other.get("properties")} for metres, j, other in candidates]
            elif operation != "metrics":
                raise ValueError("Unsupported spatial operation")
            if not g.is_empty:
                props.update(metrics(g))
                output.append(feature(g, props, str(f.get("id", i))))
                rows.append(props)
    return {"data": {"type": "FeatureCollection", "features": output}, "rows": rows,
            "operation": operation, "units": {"lengthM": "m", "areaM2": "m²", "distanceM": "m"}}
