#!/usr/bin/env python3
"""Convert local OSM XML exports into deduplicated, selectable context layers.

Only complete source geometry is emitted. No proximity-based utility connectivity,
engineering state, inferred height, or contributor account information is exported.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET


GROUPS = {
    "roads": ("Roads & paths", "#91b5c6", True),
    "buildings": ("Buildings", "#c5a879", False),
    "water": ("Water & waterways", "#53b7e2", True),
    "landcover": ("Land cover & parks", "#6aab87", False),
    "places": ("Places & amenities", "#be9ced", False),
    "utilities": ("OSM utility features", "#ffb66e", True),
}


def category(tags):
    if tags.get("power") or tags.get("pipeline") or tags.get("man_made") == "pipeline":
        return "utilities"
    if tags.get("building") not in (None, "no") or tags.get("building:part") not in (None, "no"):
        return "buildings"
    if tags.get("waterway") or tags.get("natural") in ("water", "wetland", "coastline") or tags.get("landuse") in ("reservoir", "basin"):
        return "water"
    if tags.get("highway"):
        return "roads" if tags["highway"] not in ("bus_stop", "traffic_signals", "crossing", "stop", "give_way", "turning_circle") else "places"
    if tags.get("landuse") or tags.get("natural") in ("wood", "scrub", "grassland", "sand", "beach") or tags.get("leisure") in ("park", "garden", "golf_course", "nature_reserve", "recreation_ground", "pitch"):
        return "landcover"
    if any(tags.get(key) for key in ("amenity", "shop", "tourism", "historic", "office", "place", "leisure")):
        return "places"
    return None


def stitch(parts):
    """Join member ways by node identity, retaining reversed members and all rings."""
    remaining = [list(part) for part in parts]
    rings = []
    while remaining:
        ring = remaining.pop(0)
        while ring[0] != ring[-1]:
            for index, part in enumerate(remaining):
                if ring[-1] == part[0]:
                    ring.extend(part[1:])
                elif ring[-1] == part[-1]:
                    ring.extend(reversed(part[:-1]))
                elif ring[0] == part[-1]:
                    ring = part[:-1] + ring
                elif ring[0] == part[0]:
                    ring = list(reversed(part[1:])) + ring
                else:
                    continue
                remaining.pop(index)
                break
            else:
                raise ValueError("unclosed relation ring")
        if len(ring) < 4:
            raise ValueError("short relation ring")
        rings.append(ring)
    return rings


def inside(point, ring):
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def orient(ring, outer):
    return ring if (signed_area(ring) > 0) == outer else list(reversed(ring))


def convert(paths, output):
    records = {"node": {}, "way": {}, "relation": {}}
    duplicates = 0
    inputs = []
    for path in paths:
        bounds = None
        counts = Counter()
        # Streaming avoids constructing a full XML tree for these large exports.
        context = ET.iterparse(path, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            if event != "end":
                continue
            if element.tag == "bounds":
                bounds = [float(element.get(key)) for key in ("minlon", "minlat", "maxlon", "maxlat")]
            kind = element.tag
            if kind not in records:
                continue
            counts[kind] += 1
            item = {
                "id": element.get("id"),
                "version": int(element.get("version", "1")),
                "timestamp": element.get("timestamp"),
                "tags": {tag.get("k"): tag.get("v") for tag in element.findall("tag")},
                "files": [path.name],
                "visible": element.get("visible", "true") != "false",
            }
            if kind == "node":
                item["coordinates"] = [float(element.get("lon", "nan")), float(element.get("lat", "nan"))]
            elif kind == "way":
                item["refs"] = [node.get("ref") for node in element.findall("nd")]
            else:
                item["members"] = [dict(member.attrib) for member in element.findall("member")]
            previous = records[kind].get(item["id"])
            if previous:
                duplicates += 1
                files = sorted(set(previous["files"] + item["files"]))
                if (previous["version"], previous["timestamp"] or "") > (item["version"], item["timestamp"] or ""):
                    item = previous
                item["files"] = files
            records[kind][item["id"]] = item
            root.clear()
        inputs.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bounds": bounds, "records": dict(counts)})

    layers = {group: [] for group in GROUPS}
    omissions = Counter()
    omission_examples = []
    consumed = set()

    def omit(kind, item, reason):
        omissions[reason] += 1
        if len(omission_examples) < 12:
            omission_examples.append({"id": f"{kind}/{item['id']}", "reason": reason})

    def coordinates(refs):
        result = []
        for ref in refs:
            node = records["node"].get(ref)
            if not node or not node["visible"]:
                raise ValueError("missing node reference")
            point = node["coordinates"]
            if not all(math.isfinite(n) for n in point) or abs(point[0]) > 180 or abs(point[1]) > 90:
                raise ValueError("invalid coordinates")
            result.append(point)
        return result

    def feature(kind, item, group, geometry):
        tags = item["tags"]
        label = next((tags.get(key) for key in ("name", "ref", "addr:street", "power", "building", "waterway", "highway", "landuse", "natural", "amenity", "shop") if tags.get(key)), GROUPS[group][0])
        properties = {"id": f"osm:{kind}:{item['id']}", "osmType": kind, "osmId": item["id"], "name": label, "group": group, "tags": tags, "version": item["version"], "timestamp": item["timestamp"], "sourceFiles": item["files"]}
        height = tags.get("height", "")
        if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:m)?", height):
            properties["heightMeters"] = float(height.rstrip("m "))
        layers[group].append({"type": "Feature", "id": properties["id"], "geometry": geometry, "properties": properties})

    for item in sorted(records["relation"].values(), key=lambda item: int(item["id"])):
        group = category(item["tags"])
        if not item["visible"] or not group or item["tags"].get("type") != "multipolygon":
            continue
        try:
            members = {"outer": [], "inner": []}
            member_ids = []
            for member in item["members"]:
                if member.get("role", "") not in ("", "outer", "inner"):
                    continue
                way = records["way"].get(member["ref"]) if member["type"] == "way" else None
                if not way or not way["visible"]:
                    raise ValueError("missing relation member")
                members[member.get("role") or "outer"].append(way["refs"])
                member_ids.append(way["id"])
            outers = [orient(coordinates(ring), True) for ring in stitch(members["outer"])]
            if not outers:
                raise ValueError("missing outer ring")
            polygons = [[outer] for outer in outers]
            for refs in stitch(members["inner"]):
                hole = orient(coordinates(refs), False)
                candidates = [(abs(signed_area(poly[0])), poly) for poly in polygons if inside(hole[0], poly[0])]
                if not candidates:
                    raise ValueError("unresolved inner ring")
                min(candidates, key=lambda pair: pair[0])[1].append(hole)
            geometry = {"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1 else {"type": "MultiPolygon", "coordinates": polygons}
            feature("relation", item, group, geometry)
            # Suppress constituent area ways only after successful reconstruction.
            consumed.update((way_id, group) for way_id in member_ids)
        except ValueError as error:
            omit("relation", item, str(error))

    for kind in ("node", "way"):
        for item in sorted(records[kind].values(), key=lambda item: int(item["id"])):
            group = category(item["tags"])
            if not item["visible"] or not group or (kind == "way" and (item["id"], group) in consumed):
                continue
            try:
                if kind == "node":
                    point = coordinates([item["id"]])[0]
                    geometry = {"type": "Point", "coordinates": point}
                else:
                    refs = item["refs"]
                    if len(refs) < 2:
                        raise ValueError("short way")
                    points = coordinates(refs)
                    closed = len(refs) >= 4 and refs[0] == refs[-1]
                    area = item["tags"].get("area") == "yes" or group in ("buildings", "landcover") or item["tags"].get("natural") in ("water", "wetland") or item["tags"].get("landuse") in ("reservoir", "basin") or item["tags"].get("power") == "substation"
                    if area and not closed:
                        raise ValueError("unclosed area way")
                    polygon = area and closed and item["tags"].get("area") != "no"
                    geometry = {"type": "Polygon", "coordinates": [orient(points, True)]} if polygon else {"type": "LineString", "coordinates": points}
                feature(kind, item, group, geometry)
            except ValueError as error:
                omit(kind, item, str(error))

    output.mkdir(parents=True, exist_ok=True)
    bounds = [item["bounds"] for item in inputs if item["bounds"]]
    if not bounds:
        raise ValueError("Input exports must declare their download bounds")
    manifest = {
        "schemaVersion": 1,
        "id": "osm-tampa-bay",
        "name": "South Tampa · local OSM exports",
        "bounds": [min(b[0] for b in bounds), min(b[1] for b in bounds), max(b[2] for b in bounds), max(b[3] for b in bounds)],
        "files": inputs,
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "copyrightUrl": "https://www.openstreetmap.org/copyright",
        "duplicatesRemoved": duplicates,
        "omissions": dict(omissions),
        "omissionExamples": omission_examples,
        "layers": [],
    }
    for group, (name, color, enabled) in GROUPS.items():
        collection = {"type": "FeatureCollection", "features": layers[group]}
        filename = f"{group}.geojson"
        (output / filename).write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        manifest["layers"].append({"id": group, "name": name, "color": color, "defaultVisible": enabled, "count": len(layers[group]), "file": filename})
    manifest["featureCount"] = sum(len(layer) for layer in layers.values())
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (output / "NOTICE.md").write_text("# OpenStreetMap local overlays\n\n© OpenStreetMap contributors. Converted from the local XML exports listed in manifest.json.\n\nThis derived dataset is available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). See [OpenStreetMap copyright](https://www.openstreetmap.org/copyright). Source tags, identities, versions, and file provenance are retained; contributor account metadata is omitted. Incomplete geometries are omitted and reported in the manifest.\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("data"))
    parser.add_argument("--output", type=Path, default=Path("public/data/osm/tampa-bay"))
    args = parser.parse_args()
    paths = sorted(args.input.glob("map*.osm"))
    if not paths:
        parser.error(f"No map*.osm files in {args.input}")
    result = convert(paths, args.output)
    print(json.dumps({"features": result["featureCount"], "layers": {item["id"]: item["count"] for item in result["layers"]}, "duplicatesRemoved": result["duplicatesRemoved"], "omissions": result["omissions"]}))
