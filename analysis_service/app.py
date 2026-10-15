import copy
import csv
import hashlib
import html
import io
import json
import os
import uuid
import zipfile
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse, Response, FileResponse, HTMLResponse
from shapely.geometry import mapping

from .storage import Repository, checksum, encoded, now, Cancelled
from .spatial import geometry, collection, exposure, compare_snapshots, spatial_operation, HAZARDS, feature
from .models import forecast_ev, pv_capacity
from .rasters import raster_metadata, flood_footprint, zonal_statistics, equipment_depths
from .sources import CATALOG, load_hazard, census_layer, cec_history, eia_history, parse_cec

KINDS = {"study", "layer", "snapshot", "scenario", "finding", "chart", "run", "sourceHealth", "pvReview"}
ROOT = Path(__file__).resolve().parents[1]


def validate_snapshot(body):
    bundle = body.get("bundle")
    if not isinstance(bundle, dict) or bundle.get("schemaVersion") != 1:
        raise ValueError("Snapshot requires a canonical version 1 twin bundle")
    import jsonschema
    try:
        jsonschema.validate(bundle, json.loads((ROOT / "schemas/twin.schema.json").read_text()),format_checker=jsonschema.FormatChecker())
    except jsonschema.ValidationError as error:
        raise ValueError("Invalid canonical snapshot: " + error.message) from error
    for key in ("assets", "datasets", "sources", "series", "events", "nodes", "terminals"):
        ids = [r["id"] for r in bundle.get(key, [])]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Duplicate {key} identities")
    for a in bundle["assets"]:
        geometry(a["geometry"])
        if a["datasetId"] not in {d["id"] for d in bundle["datasets"]}:
            raise ValueError("Snapshot asset has no dataset")
    datasets={d['id']:d for d in bundle['datasets']}
    assets={a['id']:a for a in bundle['assets']}
    nodes={n['id']:n for n in bundle['nodes']}
    terminals={t['id']:t for t in bundle['terminals']}
    series={s['id']:s for s in bundle['series']}
    networks={n['id']:n for n in bundle['networks']}
    for row in bundle['datasets']:
        if row['sourceId'] not in {s['id'] for s in bundle['sources']}:
            raise ValueError('Dataset source reference is unresolved')
    for key in ('datasets','assets','nodes','networks','events'):
        if any(r['workspaceId']!=bundle['workspace']['id'] for r in bundle[key]):
            raise ValueError('Snapshot workspace references must match')
    for t in bundle['terminals']:
        if t['assetId'] not in assets or t.get('nodeId') and (t['nodeId'] not in nodes or nodes[t['nodeId']]['utilityType']!=assets[t['assetId']]['utilityType']):
            raise ValueError('Terminal reference is unresolved or incompatible')
    for s in bundle['series']:
        if s['assetId'] not in assets or s['datasetId'] not in datasets or s.get('terminalId') and (s['terminalId'] not in terminals or terminals[s['terminalId']]['assetId']!=s['assetId']):
            raise ValueError('Measurement series reference is unresolved or incompatible')
    for o in bundle['observations']:
        if o['seriesId'] not in series or o['datasetId'] not in datasets:
            raise ValueError('Observation reference is unresolved')
    for m in bundle['networkMemberships']:
        if m['assetId'] not in assets or m['networkId'] not in networks or assets[m['assetId']]['utilityType']!=networks[m['networkId']]['utilityType']:
            raise ValueError('Network membership is unresolved or incompatible')
    for e in bundle['eventAssets']:
        if e['assetId'] not in assets or e['eventId'] not in {v['id'] for v in bundle['events']}:
            raise ValueError('Event reference is unresolved')
    if body.get("coverageGeometry"):
        geometry(body["coverageGeometry"])
    if body.get("complete") and not body.get("coverageGeometry"):
        raise ValueError("Complete snapshots require a coverage geometry")
    body["capturedAt"] = body.get("capturedAt") or now()
    from datetime import datetime
    if datetime.fromisoformat(body["capturedAt"].replace("Z", "+00:00")).tzinfo is None:
        raise ValueError("Capture time requires an explicit timezone")
    body["checksum"] = checksum(bundle)
    return body


def validate_layer(body):
    from urllib.parse import urlparse,parse_qs
    if body.get('sourceUrl'):
        url = urlparse(body['sourceUrl'])
        if url.scheme not in ('https','http') or url.username or url.password or any(k.lower() in ('key','token','api_key','apikey','access_token') for k in parse_qs(url.query)):
            raise ValueError('Source links must be HTTP(S) URLs without credentials. Configure credentials on the local service.')
    if body.get("hazardType") and body["hazardType"] not in HAZARDS:
        raise ValueError("Unsupported hazard class")
    body.setdefault("name", "Imported analytical layer")
    body.setdefault("fetchedAt", now())
    if "data" in body:
        body["data"] = collection(body["data"], body.get("hazardType") == "weather")
    else:
        body["data"] = {"type": "FeatureCollection", "features": []}
    body.setdefault("rows", [{"featureId": f.get("id", i), **(f.get("properties") or {})} for i, f in enumerate(body["data"]["features"])])
    if body.get("coverageGeometry"):
        geometry(body["coverageGeometry"])
    body["checksum"] = checksum({k: v for k, v in body.items() if k not in ("id", "checksum", "createdAt", "updatedAt", "schemaVersion", "studyId", "rasterArtifact", "originalRasterAvailable")})
    return body


def table_csv(rows):
    keys = list(dict.fromkeys(k for r in rows for k in r))
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=keys)
    writer.writeheader()
    for r in rows:
        values = {k: encoded(v) if isinstance(v, (dict, list)) else v for k, v in r.items()}
        # Prevent spreadsheet formula evaluation when exported source text is opened in Excel.
        values = {k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v for k, v in values.items()}
        writer.writerow(values)
    return stream.getvalue()


def create_app(data_dir=None):
    repo = Repository(data_dir or os.environ.get("ANALYSIS_DATA_DIR", ROOT / ".analysis-data"))
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="geobound-analysis")

    @asynccontextmanager
    async def lifespan(_):
        yield
        executor.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Geobound analytical workbench", version="1.0", lifespan=lifespan)
    app.state.repo = repo

    @app.exception_handler(ValueError)
    async def value_error(_, exc):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(KeyError)
    async def missing_field(_, exc):
        return JSONResponse(status_code=422, content={"detail": f"Required field missing: {exc.args[0]}"})

    import sqlite3
    @app.exception_handler(sqlite3.IntegrityError)
    async def immutable_conflict(_, exc):
        return JSONResponse(status_code=409, content={'detail':'This immutable identity already exists. Supply a new version identity.'})

    def study(identity):
        return repo.get(identity, "study", identity)

    def result_layer(study_id, layer_id):
        return repo.get(study_id, "layer", layer_id)

    def raster_path(layer):
        if not layer.get("rasterArtifact"):
            raise ValueError("Select a raster layer")
        path = repo.artifacts / Path(layer["rasterArtifact"]).name
        if not path.is_file():
            raise ValueError("Original raster is not available locally; reimport it to recompute this analysis")
        return path

    def run_job(job):
        identity, sid, kind, p = job["id"], job["studyId"], job["kind"], job["parameters"]
        def check(progress=0.):
            if repo.job(identity)["status"] in ("cancelling", "cancelled"):
                raise Cancelled()
            repo.job(identity, {"status": "running", "progress": min(.98, max(0., float(progress)))})
        try:
            check()
            inputs = {"studyAoi": study(sid)["aoi"], "parameters": copy.deepcopy(p), 'analysisAt': p.get('analysisAt',now())}
            if kind == "source":
                source = next((s for s in CATALOG if s["id"] == p.get("sourceId")), None)
                if source is None:
                    raise ValueError("Unknown public source")
                if source["adapter"] in ("arcgis", "nws"):
                    loaded = load_hazard(source, study(sid), p, check)
                elif source["adapter"] in ("acs", "census"):
                    loaded = census_layer(study(sid), p, source["adapter"] == "census", check)
                elif source["adapter"] == "cec":
                    loaded = cec_history({**p,'aoi':study(sid)['aoi']}, check)
                elif source["adapter"] == "eia":
                    loaded = eia_history({**p, 'aoi': study(sid)['aoi']}, check)
                elif source["adapter"] == "afdc":
                    from .sources import afdc_history
                    loaded = afdc_history({**p,'aoi':study(sid)['aoi']}, check)
                elif source["adapter"] == "imagery":
                    from .sources import public_imagery
                    loaded = public_imagery(study(sid), p, repo.artifacts, check)
                else:
                    raise ValueError("This source requires a supplied published export")
                body = validate_layer({**source, **loaded, "sourceId": source["id"], "sourceUrl": loaded.get("sourceUrl", source["endpoint"]), "id": str(uuid.uuid4()), "attribution": source["name"]})
                check(.95)
                layer = repo.put(sid, "layer", body)
                result = {"layerId": layer["id"], "summary": {"features": len(layer['data']['features']), "records": len(layer.get('rows', [])), "complete": layer.get('complete', False)}, "interpretation": "Immutable input geometry and records are stored in the referenced layer version"}
                repo.put(sid, "sourceHealth", {"id": source["id"], "status": "ready", "lastSuccessAt": now(), "layerId": layer["id"]}, True)
            elif kind in ("exposure", "scenario"):
                snapshot = repo.get(sid, "snapshot", p["snapshotId"])
                layers = [result_layer(sid, x) for x in p.get("layerIds", [])]
                for layer in layers:
                    selected = p.get("featureFilters", {}).get(layer["id"])
                    if selected:
                        layer["data"]["features"] = [f for f in layer["data"]["features"] if str(f.get("id")) == str(selected)]
                        if not layer["data"]["features"]:
                            raise ValueError("Selected hazard feature not found in its immutable version")
                if not layers:
                    raise ValueError("Select at least one hazard layer")
                for layer in layers:
                    if layer.get('rasterArtifact'):
                        wet, covered = flood_footprint(raster_path(layer), check)
                        layer['data'] = {'type': 'FeatureCollection', 'features': [] if wet.is_empty else [feature(wet, {'depthRasterId': layer['id']})]}
                        layer['complete'] = True
                        layer['coverageGeometry'] = None if covered.is_empty else mapping(covered)
                inputs["snapshotChecksum"] = snapshot["checksum"]
                inputs["layerChecksums"] = [l["checksum"] for l in layers]
                result = exposure(snapshot, layers, inputs["studyAoi"], float(p.get("faultBufferM", 0)), check, inputs['analysisAt'])
                if kind == "scenario":
                    scenario = repo.get(sid, "scenario", p["scenarioId"])
                    if scenario["snapshotId"] != snapshot["id"]:
                        raise ValueError("Baseline and scenario must use the same frozen asset snapshot")
                    alternative = copy.deepcopy(snapshot)
                    for override in scenario.get("assetOverrides", []):
                        asset = next((a for a in alternative["bundle"]["assets"] if a["id"] == override["assetId"]), None)
                        if asset is None:
                            raise ValueError("Scenario override references an unknown asset")
                        asset["geometry"] = override["geometry"]
                    scenario_layers = [result_layer(sid, x) for x in scenario["layerIds"]]
                    inputs['scenarioLayerChecksums'] = [l['checksum'] for l in scenario_layers]
                    depths = []
                    for l in scenario_layers:
                        if l.get("rasterArtifact"):
                            wet, covered = flood_footprint(raster_path(l), check)
                            depths.extend(equipment_depths(raster_path(l), alternative['bundle']['assets'],l.get('verticalReference'),l.get('unit'),check))
                            l["data"] = {"type": "FeatureCollection", "features": [] if wet.is_empty else [feature(wet, {"depthRasterId": l["id"]})]}
                            l["complete"] = True
                            l["coverageGeometry"] = None if covered.is_empty else mapping(covered)
                    changed = exposure(alternative, scenario_layers, inputs["studyAoi"], float(p.get("faultBufferM", 0)), check, inputs['analysisAt'])
                    before = {r["assetId"] for r in result["rows"] if r["status"] == "exposed"}
                    after = {r["assetId"] for r in changed["rows"] if r["status"] == "exposed"}
                    baseline_clear = {r['assetId'] for r in result['rows'] if r['status'] == 'not_exposed'}
                    alternative_clear = {r['assetId'] for r in changed['rows'] if r['status'] == 'not_exposed'}
                    unassessed = sorted({r['assetId'] for r in result['rows'] + changed['rows'] if not r['assessmentComplete']})
                    delta_rows = [{"assetType": t, "baseline": result["summary"]["byType"].get(t, 0), "alternative": changed["summary"]["byType"].get(t, 0)} for t in sorted(result["summary"]["byType"].keys() | changed["summary"]["byType"].keys())]
                    result = {"baseline": result, "alternative": changed, "rows": delta_rows, "data": changed["data"],
                              "entering": sorted(after & baseline_clear), "leaving": sorted(before & alternative_clear), "comparisonUnassessed": unassessed,
                              "exposedLengthDeltaM": changed["summary"]["exposedLengthM"] - result["summary"]["exposedLengthM"],
                              "depthStatistics": depths, "depthInterpretation": "Mapped raster depth. Equipment inundation is derived only for supplied point elevations, ground elevations, units, and matching vertical references; display offsets are never used.",
                              "scenario": scenario}
                    inputs["scenarioChecksum"] = checksum(scenario)
            elif kind == "replay":
                a = repo.get(sid, "snapshot", p["beforeId"])
                b = repo.get(sid, "snapshot", p["afterId"])
                result = compare_snapshots(a, b)
                inputs.update(beforeChecksum=a["checksum"], afterChecksum=b["checksum"])
            elif kind == "spatial":
                left = result_layer(sid, p["leftId"])
                right = result_layer(sid, p["rightId"]) if p.get("rightId") else None
                if p["operation"] == "zonal_statistics":
                    if right is None:
                        raise ValueError("Select a raster as the second layer")
                    result = zonal_statistics(raster_path(right), left["data"]["features"], check)
                else:
                    result = spatial_operation(p["operation"], left["data"], right["data"] if right else None, p.get("distanceM", 0))
                inputs.update(leftChecksum=left["checksum"], rightChecksum=right["checksum"] if right else None)
            elif kind == "table":
                layer = result_layer(sid, p["layerId"])
                result = {"rows": layer.get("rows", []), "data": layer["data"], "sourceMetadata": {k: layer.get(k) for k in ("sourceUrl", "unit", "vintage", "geographyLevel", "interpretation")}}
                inputs["layerChecksum"] = layer["checksum"]
            elif kind == 'measurements':
                snapshot = repo.get(sid,'snapshot',p['snapshotId'])
                series = next((s for s in snapshot['bundle']['series'] if s['id']==p['seriesId']),None)
                if series is None:
                    raise ValueError('Measurement series not found')
                observed = sorted([o for o in snapshot['bundle']['observations'] if o['seriesId']==series['id'] and o['observedAt']<=p.get('asOf',now())],key=lambda o:o['observedAt'])
                output = []
                from datetime import datetime,timedelta
                previous = None
                for o in observed:
                    date = datetime.fromisoformat(o['observedAt'].replace('Z','+00:00'))
                    interval = series.get('sampleIntervalSeconds')
                    if previous and interval and date-previous>timedelta(seconds=interval*1.5):
                        output.append({'observedAt':(previous+timedelta(seconds=interval)).isoformat(),'value':None,'quality':'missing','unit':series['unit'],'assetId':series['assetId']})
                    output.append({**o,'unit':series['unit'],'quantity':series['quantity'],'phase':series.get('phase'),'assetId':series['assetId']})
                    previous = date
                result={'rows':output,'series':series,'interpretation':'Original units, recorded quality, and explicit chart gaps'}
                inputs['snapshotChecksum']=snapshot['checksum']
            elif kind == "ev":
                layer = result_layer(sid, p["historyId"])
                records = layer.get("rows", [])
                if p.get("geographyId"):
                    records = [r for r in records if str(r.get("geographyId")) == str(p["geographyId"])]
                result = forecast_ev(records, p.get("endYear", 2035), p.get("fleetGrowth", 0), check)
                result['data'] = copy.deepcopy(layer['data'])
                for f in result['data']['features']:
                    future = [r for r in result['rows'] if r['kind']=='forecast' and r['scenario']=='baseline' and r['year']==p.get('endYear',2035)]
                    f['properties'].update(geographyId=records[-1].get('geographyId'),forecastYear=p.get('endYear',2035),
                                           bevForecast=next((r['count'] for r in future if r['vehicle']=='BEV'),None),
                                           phevForecast=next((r['count'] for r in future if r['vehicle']=='PHEV'),None),interpretation='Experimental forecast at published geography; no feeder load inferred')
                inputs["historyChecksum"] = layer["checksum"]
            elif kind == "pv":
                layer = result_layer(sid, p["imageryId"])
                if not layer.get("captureDate") or not layer.get("sourceRights"):
                    raise ValueError("Imagery capture date and source rights are required")
                from .pv import infer
                result = infer(raster_path(layer), os.environ.get("PV_CHECKPOINT", str(repo.root / "models/pv.pt")),
                               os.environ.get("PV_MODEL_CARD", str(repo.root / "models/pv-model-card.json")),
                               float(p.get("efficiency", .2)), float(p.get("tilt", 0)), float(p.get("threshold", .5)), check)
                result["imagery"] = {k: layer.get(k) for k in ("id", "captureDate", "resolution", "sourceRights", "sourceUrl", "sourceCrs")}
                inputs["imageryChecksum"] = layer["checksum"]
            else:
                raise ValueError("Unsupported analysis job")
            check(.99)
            run = repo.put(sid, "run", {"jobId": identity, "kind": kind, "inputs": inputs,
                                        "result": result, "resultChecksum": checksum(result), "codeVersion": "geobound-analysis-1"})
            repo.job(identity, {"status": "completed", "progress": 1, "runId": run["id"], "endedAt": now()})
        except Cancelled:
            repo.job(identity, {"status": "cancelled", "endedAt": now()})
        except Exception as exc:
            if repo.job(identity)['status'] == 'cancelling':
                repo.job(identity, {'status':'cancelled','endedAt':now()})
                return
            repo.job(identity, {"status": "failed", "error": str(exc), "endedAt": now()})
            if kind == "source":
                try:
                    old = repo.get(sid, "sourceHealth", p["sourceId"])
                except ValueError:
                    old = {"id": p.get("sourceId", "unknown")}
                repo.put(sid, "sourceHealth", {**old, "status": "error", "error": str(exc), "lastAttemptAt": now()}, True)

    @app.get("/api/analysis/health")
    def health():
        checkpoint = Path(os.environ.get("PV_CHECKPOINT", repo.root / "models/pv.pt"))
        card_path = Path(os.environ.get("PV_MODEL_CARD", repo.root / "models/pv-model-card.json"))
        card = json.loads(card_path.read_text()) if card_path.is_file() else None
        configured = checkpoint.is_file() and bool(card and card.get("training"))
        kinds = ('source','exposure','replay','scenario','spatial','measurements','table','ev','pv')
        enabled = set(os.environ['ANALYSIS_FEATURES'].split(',')) if 'ANALYSIS_FEATURES' in os.environ else set(kinds)
        return {"status": "ready", "schemaVersion": 1, "enabledJobKinds": sorted(enabled), "capabilities": {k: k in enabled and (configured if k == 'pv' else True) for k in kinds},
                "pvStatus": "experimental" if configured else "training_required", "pvModelCard": card,
                "censusConfigured": bool(os.environ.get("CENSUS_API_KEY")), "sources": CATALOG}

    @app.get("/api/analysis/studies")
    def list_studies():
        return [v for _, v in repo.list(kind="study")]

    @app.post("/api/analysis/studies", status_code=201)
    def create_study(body: dict):
        geometry(body["aoi"])
        if geometry(body["aoi"]).geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Study boundary must be a polygon")
        identity = str(uuid.uuid4())
        return repo.put(identity, "study", {"id": identity, "name": str(body.get("name", "Resilience review"))[:200], "aoi": body["aoi"],
                                            "workspaceId": body.get("workspaceId"), "timezone": body.get("timezone", "America/Los_Angeles")})

    @app.get("/api/analysis/studies/{sid}")
    def load_study(sid: str):
        s = study(sid)
        grouped = {}
        for kind, body in repo.list(sid):
            if kind != "study":
                # Map display geometry is intentionally smaller than the immutable analytical input.
                # Jobs and exports read the original repository records, never this representation.
                if kind == 'layer':
                    for r in body.get('rows', []):
                        r.pop('sourceGeometry', None)
                    for f in body.get('data', {}).get('features', []):
                        f.get('properties', {}).pop('sourceGeometry', None)
                        if f.get('geometry'):
                            f['geometry'] = mapping(geometry(f['geometry']).simplify(.00001, preserve_topology=True))
                    body['displayGeometryOnly'] = True
                if kind == 'run':
                    result = body.get('result', {})
                    if body.get('kind') == 'source':
                        result.pop('data', None)
                        result.pop('rows', None)
                    for r in result.get('rows', []):
                        for h in r.get('hazards', []):
                            (h.get('properties') or {}).pop('sourceGeometry', None)
                    for f in result.get('data', {}).get('features', []):
                        for k in ('hazards', 'checklist'):
                            f.get('properties', {}).pop(k, None)
                grouped.setdefault(kind, []).append(body)
        return Response(encoded({"study": s, "entities": grouped, "jobs": repo.jobs(sid)}), media_type='application/json')

    @app.post("/api/analysis/studies/{sid}/entities/{kind}", status_code=201)
    def add_entity(sid: str, kind: str, body: dict):
        study(sid)
        if kind not in KINDS - {"study", "run", "sourceHealth"}:
            raise ValueError("Unsupported entity type")
        body = copy.deepcopy(body)
        mutable = kind in ("finding", "chart", "pvReview")
        if kind == "layer":
            body = validate_layer(body)
        elif kind == "snapshot":
            body = validate_snapshot(body)
        elif kind == "finding":
            if body.get("priority", "Unassigned") not in ("High", "Normal", "Deferred", "Unassigned"):
                raise ValueError("Invalid review priority")
            if body.get("priority", "Unassigned") != "Unassigned" and not str(body.get("reason", "")).strip():
                raise ValueError("Assigned priorities require a reason")
            if body.get("status", "open") not in ("open", "reviewed", "completed"):
                raise ValueError("Invalid review status")
            snapshot = repo.get(sid, "snapshot", body["snapshotId"])
            if body["assetId"] not in {a["id"] for a in snapshot["bundle"]["assets"]}:
                raise ValueError("Finding references an unknown snapshot asset")
        elif kind == "scenario":
            repo.get(sid, "snapshot", body["snapshotId"])
            for lid in body.get("layerIds", []):
                result_layer(sid, lid)
            for override in body.get("assetOverrides", []):
                geometry(override["geometry"])
            if not body.get("layerIds"):
                raise ValueError("Supply scenario hazard inputs; an annotation cannot change exposure")
        elif kind == "chart":
            repo.get(sid, "run", body["runId"])
        elif kind == "pvReview":
            run = repo.get(sid, "run", body["runId"])
            source = next((f for f in run["result"].get("data", {}).get("features", []) if f.get("id") == body["arrayId"]), None)
            if source is None or body.get("status") not in ("accepted", "rejected", "corrected"):
                raise ValueError("Invalid PV review")
            if body.get("geometry"):
                from .spatial import metrics
                body["sizing"] = pv_capacity(metrics(geometry(body["geometry"]))["areaM2"], float(body.get("efficiency", .2)), float(body.get("tilt", 0)))
        body["updatedAt"] = now()
        return repo.put(sid, kind, body, mutable)

    @app.post("/api/analysis/studies/{sid}/jobs", status_code=202)
    def create_job(sid: str, body: dict):
        study(sid)
        if body.get("kind") not in ("source", "exposure", "scenario", "replay", "spatial", "pv", "ev", "table", "measurements"):
            raise ValueError("Unsupported job kind")
        enabled = os.environ.get('ANALYSIS_FEATURES')
        if enabled is not None and body['kind'] not in set(enabled.split(',')):
            raise ValueError('This capability is disabled in the local release configuration')
        if any(k.lower() in ('token','api_key','apikey','password') for k in body.get('parameters',{})):
            raise ValueError('Configure credentials on the local service rather than in analysis parameters')
        job = repo.add_job(sid, body["kind"], body.get("parameters", {}))
        executor.submit(run_job, job)
        return job

    @app.get("/api/analysis/jobs/{jid}")
    def get_job(jid: str):
        return repo.job(jid)

    @app.post("/api/analysis/jobs/{jid}/cancel")
    def cancel_job(jid: str):
        current = repo.job(jid)
        if current["status"] in ("queued", "running"):
            return repo.job(jid, {"status": "cancelling"})
        return current

    @app.post("/api/analysis/upload/{sid}")
    async def upload(sid: str, file: UploadFile = File(...), metadata: str = Form("{}")):
        study(sid)
        meta = json.loads(metadata)
        filename = file.filename or "dataset"
        suffix = Path(filename).suffix.lower()
        if suffix in (".tif", ".tiff"):
            identity = str(uuid.uuid4()) + ".tif"
            path = repo.artifacts / identity
            size = 0
            try:
                with path.open("wb") as target:
                    while chunk := await file.read(1024 * 1024):
                        size += len(chunk)
                        if size > 1024**3:
                            raise ValueError("Raster uploads are limited to 1 GB; provide an AOI crop")
                        target.write(chunk)
                attributes = raster_metadata(path)
                content_hash = hashlib.sha256()
                with path.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        content_hash.update(chunk)
                body = validate_layer({**meta, **attributes, "name": meta.get("name", filename), "rasterArtifact": identity,
                                       "contentChecksum": content_hash.hexdigest()})
                return repo.put(sid, "layer", body)
            except Exception:
                path.unlink(missing_ok=True)
                raise
        content = await file.read(100 * 1024**2 + 1)
        if len(content) > 100 * 1024**2:
            raise ValueError("Vector/table uploads are limited to 100 MB")
        if suffix in (".json", ".geojson"):
            value = json.loads(content)
            if value.get("schemaVersion") == 1 and "assets" in value:
                return repo.put(sid, "snapshot", validate_snapshot({**meta, "bundle": value}))
            body = {**meta, "data": collection(value, meta.get("hazardType") == "weather")}
        elif suffix == ".csv":
            rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
            # No implicit unit changes or rate calculations for imported tables.
            numeric = {"year", "bev", "phev", "total", "saidi", "saifi", "value", "numerator", "denominator", "marginOfError"}
            for row in rows:
                for k in numeric & row.keys():
                    row[k] = float(row[k]) if str(row[k]).strip() else None
                for key in ("suppressed", "reportingBreak"):
                    if key in row:
                        row[key] = str(row[key]).lower() in ("true", "1", "yes")
            body = {**meta, "rows": rows}
        elif suffix == ".xlsx" and meta.get("sourceId") == "cec-ev":
            body = {**meta, **parse_cec(content, meta, meta.get('sourceUrl') or 'https://www.energy.ca.gov/files/zev-and-infrastructure-stats-data')}
        elif suffix in (".gpkg", ".zip"):
            import fiona
            with fiona.BytesCollection(content) as source:
                from rasterio.warp import transform_geom
                if not source.crs and not meta.get('sourceCrs'):
                    raise ValueError('Vector files require a declared CRS; coordinates cannot be assumed')
                data = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": f["id"], "geometry": transform_geom(source.crs or meta['sourceCrs'], 4326, dict(f["geometry"])), "properties": dict(f["properties"])} for f in source]}
            body = {**meta, "data": data}
        else:
            raise ValueError("Use GeoJSON, CSV, GeoTIFF, GeoPackage, zipped shapefile, or a CEC workbook")
        return repo.put(sid, "layer", validate_layer({"name": filename, **body}))

    @app.get('/api/analysis/studies/{sid}/layers/{lid}/tiles/{z}/{x}/{y}.png')
    def raster_tile(sid: str, lid: str, z: int, x: int, y: int):
        import numpy as np
        import rasterio
        from rasterio.vrt import WarpedVRT
        from rasterio.windows import from_bounds
        from rasterio.enums import Resampling
        from PIL import Image
        if not 0 <= z <= 22 or not 0 <= x < 2**z or not 0 <= y < 2**z:
            raise ValueError('Invalid raster tile coordinates')
        layer = result_layer(sid, lid)
        path = raster_path(layer)
        half = 20037508.342789244
        span = 2 * half / 2**z
        west, north = -half + x*span, half-y*span
        with rasterio.open(path) as ds, WarpedVRT(ds, crs='EPSG:3857') as vrt:
            window = from_bounds(west,north-span,west+span,north,vrt.transform)
            if layer.get('bands',1) >= 3:
                rgb = vrt.read([1,2,3],window=window,out_shape=(3,256,256),resampling=Resampling.bilinear,masked=True)
                values = np.clip(rgb.filled(0),0,255).astype('uint8').transpose(1,2,0)
                alpha = (~np.ma.getmaskarray(rgb).any(axis=0)).astype('uint8')*255
            else:
                values = vrt.read(1,window=window,out_shape=(256,256),resampling=Resampling.nearest,masked=True).astype(float)
                valid = ~np.ma.getmaskarray(values) & np.isfinite(values.filled(np.nan))
                positive = np.clip(values.filled(0)/float(layer.get('displayMaximum',5)),0,1)
                values = np.stack([35+positive*30,90+positive*70,160+positive*90],axis=-1).astype('uint8')
                alpha = valid.astype('uint8')*180
            pixels = np.concatenate([values,alpha[...,None]],axis=-1)
        image=io.BytesIO();Image.fromarray(pixels).save(image,format='PNG')
        return Response(image.getvalue(),media_type='image/png',headers={'Cache-Control':'private, max-age=3600'})

    def report(sid):
        s = study(sid)
        rows = [(k, v) for k, v in repo.list(sid) if k != "study"]
        sections = []
        for kind, body in rows:
            if kind not in ("finding", "run", "chart", "pvReview"):
                continue
            heading = html.escape(str(body.get('name', body.get('kind', kind.title()))))
            if kind == 'finding':
                visible = '<dl>' + ''.join(f"<dt>{html.escape(key)}</dt><dd>{html.escape(str(body.get(key,'Not supplied')))}</dd>" for key in ('assetId','priority','reason','status','annotations','proposedActions')) + '</dl>'
            elif kind == 'chart' and body.get('svg'):
                visible = '<img style="max-width:100%" alt="Saved analytical chart" src="data:image/svg+xml;base64,' + base64.b64encode(body['svg'].encode()).decode() + '">'
            elif kind == 'run':
                result = body['result'];summary = result.get('summary') or result.get('alternative',{}).get('summary')
                visible = '<p>Saved analysis run: ' + html.escape(body['id']) + '</p>'
                if summary:
                    visible += f"<p>Exposed: {summary['exposed']} · Not exposed: {summary['not_exposed']} · Not assessed: {summary['not_assessed']} · Exposed infrastructure: {summary['exposedLengthM']/1000:.2f} km</p>"
                if body['kind'] == 'scenario':
                    visible += f"<p>Entering exposure: {len(result['entering'])} · Leaving exposure: {len(result['leaving'])} · Length difference: {result['exposedLengthDeltaM']/1000:.2f} km</p>"
                if body['kind'] == 'ev':
                    visible += '<p>Experimental EV forecast through 2035. Model: ' + html.escape(result['model']) + '. Long-range values are scenario extrapolations.</p>'
                if body['kind'] == 'pv':
                    visible += '<p>Experimental PV area/DC capacity estimates. Efficiency and tilt are explicit assumptions; pilot accuracy has not been independently established.</p>'
            else:
                visible = '<p>' + html.escape(str(body.get('status','Recorded evidence'))) + '</p>'
            metadata = {k:v for k,v in body.items() if k not in ('result','svg')}
            if kind == 'run':
                metadata['resultMetadata'] = {k:v for k,v in body['result'].items() if k not in ('rows','data','baseline','alternative')}
            sections.append(f"<section><h2>{heading}</h2>{visible}<details><summary>Reproducibility metadata (complete records in study ZIP)</summary><pre>{html.escape(json.dumps(metadata, indent=2, ensure_ascii=False))}</pre></details></section>")
        sources = [v for k, v in rows if k == "layer"]
        source_table = "".join(f"<tr><td>{html.escape(l['name'])}</td><td>{html.escape(str(l.get('sourceUpdatedAt', 'Unknown')))}</td><td>{html.escape(str(l.get('fetchedAt', 'Unknown')))}</td><td>{html.escape(str(l.get('attribution', 'Not supplied')))}</td></tr>" for l in sources)
        return f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(s['name'])}</title><style>body{{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#16252e}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}}table{{border-collapse:collapse;width:100%}}td,th{{padding:8px;text-align:left;border-bottom:1px solid #ddd}}section{{break-inside:avoid}}@media print{{body{{margin:0}}}}</style></head><body><h1>{html.escape(s['name'])}</h1><p>Geobound resilience review · Generated {now()}</p><p>Spatial screening and experimental model outputs. Criticality, equipment elevation, customers interrupted, and people served are unknown unless independently supplied.</p><h2>Source evidence</h2><table><thead><tr><th>Source</th><th>Publisher date</th><th>Collected</th><th>Attribution</th></tr></thead><tbody>{source_table}</tbody></table>{''.join(sections)}</body></html>"

    @app.get("/api/analysis/studies/{sid}/report")
    def study_report(sid: str):
        return HTMLResponse(report(sid))

    @app.get("/api/analysis/studies/{sid}/package")
    def package(sid: str):
        study(sid)
        stream = io.BytesIO()
        entries = []
        artifacts = []
        large_runs = []
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            def write_artifact(name, payload):
                data = payload.encode() if isinstance(payload, str) else payload
                archive.writestr(name, data)
                artifacts.append({'path':name, 'sha256':hashlib.sha256(data).hexdigest()})
            for index, (kind, body) in enumerate(repo.list(sid)):
                # A package retains raster metadata, never the original imagery/raster bytes.
                name = f"records/{index:05d}-{kind}.json"
                payload = encoded(body).encode()
                archive.writestr(name, payload)
                entries.append({"path": name, "kind": kind, "sha256": hashlib.sha256(payload).hexdigest()})
                if kind == "run":
                    if len(payload) > 5 * 1024**2:
                        # Complete outputs already exist in the checksummed canonical run record.
                        # Avoid duplicating very large geometry into CSV and GeoJSON in the ZIP.
                        large_runs.append(body['id'])
                        continue
                    if body["result"].get("rows"):
                        write_artifact(f"outputs/{body['id']}.csv", table_csv(body["result"]["rows"]))
                    if body["result"].get("data"):
                        write_artifact(f"outputs/{body['id']}.geojson", encoded(body["result"]["data"]))
            write_artifact("review.html", report(sid))
            archive.writestr("manifest.json", encoded({"schemaVersion": 1, "studyId": sid, "entries": entries,
                            "artifacts": artifacts, "largeRunOutputsInCanonicalRecords": large_runs, "excluded": ["credentials", "Google imagery", "live video", "raw rasters"], "exportedAt": now()}))
        return Response(stream.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="geobound-study.zip"'})

    @app.post("/api/analysis/packages/import", status_code=201)
    async def import_package(file: UploadFile = File(...)):
        content = await file.read(250 * 1024**2 + 1)
        if len(content) > 250 * 1024**2:
            raise ValueError("Study package exceeds 250 MB")
        archive = zipfile.ZipFile(io.BytesIO(content))
        if sum(i.file_size for i in archive.infolist()) > 500 * 1024**2:
            raise ValueError("Expanded package exceeds 500 MB")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("schemaVersion") != 1:
            raise ValueError("Unsupported analytical package version")
        for entry in manifest.get('artifacts', []):
            if hashlib.sha256(archive.read(entry['path'])).hexdigest() != entry['sha256']:
                raise ValueError('Package artifact checksum mismatch; nothing imported')
        records = []
        for entry in manifest["entries"]:
            if entry["kind"] not in KINDS:
                raise ValueError("Unknown package entity")
            payload = archive.read(entry["path"])
            if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise ValueError("Package checksum mismatch; nothing imported")
            body = json.loads(payload)
            encoded(body)
            if entry["kind"] == "snapshot":
                validate_snapshot(body)
            elif entry["kind"] == "layer":
                validate_layer(body)
                body.pop("rasterArtifact", None)
                if body.get("bands"):
                    body["originalRasterAvailable"] = False
            elif entry["kind"] == "study":
                geometry(body["aoi"])
            records.append((entry["kind"], body))
        if sum(k == "study" for k, _ in records) != 1:
            raise ValueError("Package requires exactly one study")
        sid = str(uuid.uuid4())
        repo.import_entities(sid, records)
        return study(sid)

    @app.get("/api/analysis/studies/{sid}/runs/{rid}/export/{format}")
    def export_run(sid: str, rid: str, format: str):
        run = repo.get(sid, "run", rid)
        result = run["result"]
        if format == "csv":
            return Response(table_csv(result.get("rows", [])), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="analysis.csv"'})
        data = result.get("data")
        if not data:
            raise ValueError("This run has no spatial output")
        if format == "geojson":
            return Response(encoded(data), media_type="application/geo+json", headers={"Content-Disposition": 'attachment; filename="analysis.geojson"'})
        if format == "gpkg":
            import fiona
            path = repo.artifacts / f"{uuid.uuid4()}.gpkg"
            with fiona.open(path, "w", driver="GPKG", layer="analysis", crs="EPSG:4326", schema={"geometry": "Unknown", "properties": {"identity": "str", "attributes": "str"}}) as target:
                for i, f in enumerate(data["features"]):
                    target.write({"geometry": f["geometry"], "properties": {"identity": str(f.get("id", i)), "attributes": encoded(f.get("properties") or {})}})
            return FileResponse(path, filename="analysis.gpkg")
        raise ValueError("Use csv, geojson, or gpkg")

    return app


app = create_app()
