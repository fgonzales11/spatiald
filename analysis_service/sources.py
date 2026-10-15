"""Read-only public adapters. Successful versions are retained by the service."""
import io
import os
import re
import zipfile
from datetime import datetime, timezone
import httpx
import pandas as pd
from shapely.geometry import mapping, box
from shapely.ops import unary_union
from .spatial import geometry, collection
from .storage import now

CGS = "https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services"
CATALOG = [
    dict(id="fema", name="FEMA mapped flood hazard", hazardType="flood", adapter="arcgis", endpoint="https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28", interpretation="Mapped flood hazard, not current flooding"),
    dict(id="nws", name="NWS active alerts", hazardType="weather", adapter="nws", endpoint="https://api.weather.gov/alerts/active", interpretation="Alert area; expiry and collection time retained"),
    dict(id="cgs-liquefaction", name="CGS liquefaction investigation zones", hazardType="liquefaction", adapter="arcgis", endpoint=f"{CGS}/CGS_Liquefaction_Zones/FeatureServer/0", interpretation="Regulatory investigation zone, not predicted failure"),
    dict(id="cgs-landslide", name="CGS earthquake-induced landslide zones", hazardType="landslide", adapter="arcgis", endpoint=f"{CGS}/CGS_Landslide_Zones/FeatureServer/0", interpretation="Earthquake-induced landslide investigation zone"),
    dict(id="cgs-susceptibility", name="CGS landslide susceptibility", hazardType="landslide", adapter="arcgis", endpoint="https://gis.conservation.ca.gov/server/rest/services/CGS/MS58_LandslideSusceptibility_Classes/MapServer/0", interpretation="Susceptibility classes, not a landslide forecast"),
    dict(id="usgs-fault", name="USGS Quaternary fault traces", hazardType="fault", adapter="arcgis", endpoint="https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer/21", interpretation="Mapped trace with source scale; proximity buffer is an assumption"),
    dict(id="usgs-debris", name="USGS postfire debris-flow basins", hazardType="debris_flow", adapter="arcgis", endpoint="https://earthquake.usgs.gov/arcgis/rest/services/ls/pwfdf/MapServer/4", interpretation="Assessment basins and supplied rainfall scenarios, not complete runout footprints"),
    dict(id="acs", name="ACS neighborhood context", adapter="acs", endpoint="https://api.census.gov/data", interpretation="Published block-group estimates with margins of error; not customers served"),
    dict(id="census-blocks", name="Census block population", adapter="census", endpoint="https://api.census.gov/data/2020/dec/pl", interpretation="2020 published block counts; boundary vintage is 2020"),
    dict(id="eia-reliability", name="EIA historical SAIDI / SAIFI", adapter="eia", endpoint="https://www.eia.gov/electricity/data/eia861/", interpretation="Utility/reporting-scope annual averages; counties are approximate coverage"),
    dict(id="cec-ev", name="California vehicle population history", adapter="cec", endpoint="https://www.energy.ca.gov/files/zev-and-infrastructure-stats-data", interpretation="Registered vehicle stock, not sales; county and ZIP records retain their published geography"),
    dict(id="afdc-ev", name="DOE state vehicle registrations", adapter="afdc", endpoint="https://afdc.energy.gov/vehicle-registration", interpretation="Approximate state counts rounded by publisher; not county observations"),
    dict(id="naip", name="Public orthophoto AOI crop", adapter="imagery", endpoint="https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer", interpretation="Verify acquisition date and suitability before PV inference"),
]


def request(url, params=None):
    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": "Geobound-local-analysis/1.0", "Accept": "*/*"}) as client:
        response = client.get(url, params=params)
        if not response.is_success:
            from urllib.parse import urlparse
            location = urlparse(url)
            raise ValueError(f'Provider returned HTTP {response.status_code}: {location.hostname}{location.path}')
        return response


def json_request(url, params=None):
    data = request(url, params).json()
    if isinstance(data, dict) and data.get("error"):
        raise ValueError(data["error"].get("message", "Provider query failed"))
    return data


def arcgis(endpoint, aoi, where="1=1", check=lambda *_: None):
    g = geometry(aoi)
    w, s, e, n = g.bounds
    meta = json_request(endpoint, {"f": "json"})
    oid = meta.get("objectIdField") or next((f["name"] for f in meta.get("fields", []) if f["type"] == "esriFieldTypeOID"), None)
    if not oid:
        raise ValueError("Provider has no stable feature identity")
    base = {"f": "json", "where": where, "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects"}
    ids = json_request(endpoint + "/query", {**base, "returnIdsOnly": "true"})
    if ids.get("exceededTransferLimit") or "objectIds" not in ids:
        raise ValueError("Provider cannot certify complete feature IDs for this AOI; narrow the study area")
    identities = sorted(ids["objectIds"] or [])
    if len(identities) != len(set(identities)) or len(identities) > 100000:
        raise ValueError("Duplicate IDs or AOI exceeds the 100,000 feature analytical limit")
    output = []
    for start in range(0, len(identities), 50):
        check(start / max(1, len(identities)))
        expected = identities[start:start+50]
        page = json_request(endpoint + "/query", {"f": "geojson", "objectIds": ",".join(map(str, expected)), "outFields": "*", "outSR": 4326, "returnGeometry": "true"})
        if page.get("exceededTransferLimit") or len(page.get("features", [])) != len(expected):
            raise ValueError("Incomplete source page; previous version retained")
        seen = []
        for f in page["features"]:
            key = f.get("properties", {}).get(oid, f.get("id"))
            seen.append(key)
            f["id"] = str(key)
            if f.get('geometry'):
                from shapely.geometry import shape
                from shapely import make_valid
                from shapely.validation import explain_validity
                original = shape(f['geometry'])
                if not original.is_valid:
                    normalized = make_valid(original)
                    if normalized.is_empty or not normalized.is_valid:
                        raise ValueError('Source geometry could not be normalized; previous version retained')
                    f['properties']['sourceGeometry'] = f['geometry']
                    f['properties']['geometryRepair'] = {'method':'GEOS make_valid','reason':explain_validity(original)}
                    f['geometry'] = mapping(normalized)
        if set(map(str, seen)) != set(map(str, expected)):
            raise ValueError("Source identities changed during paging")
        output.extend(page["features"])
    data = collection({"type": "FeatureCollection", "features": output})
    edit = meta.get("editingInfo", {}).get("lastEditDate")
    return data, datetime.fromtimestamp(edit / 1000, timezone.utc).isoformat().replace("+00:00", "Z") if edit else None


def load_hazard(source, study, parameters, check):
    aoi = study["aoi"]
    if source["adapter"] == "nws":
        area = parameters.get("state", "CA" if geometry(aoi).centroid.x < -100 else "FL")
        page = json_request(source["endpoint"], {"area": area})
        features, seen, next_url = [], set(), None
        while True:
            for f in page.get("features", []):
                if f["id"] in seen:
                    raise ValueError("Duplicate alert identity")
                seen.add(f["id"])
                if f.get("geometry") is None:
                    zones = []
                    affected = (f.get('properties') or {}).get('affectedZones', [])
                    for zone in (f.get("properties") or {}).get("affectedZones", []):
                        if not zone.startswith("https://api.weather.gov/zones/"):
                            continue
                        check(.3)
                        try:
                            z = json_request(zone)
                            if z.get("geometry"):
                                zones.append(geometry(z["geometry"]))
                        except (ValueError, httpx.HTTPError):
                            pass
                    if zones:
                        f["geometry"] = mapping(unary_union(zones))
                        f["properties"]["geometryResolution"] = "affectedZones"
                    f['properties']['zoneResolutionComplete'] = bool(affected) and len(zones)==len(affected)
                if not f.get("geometry") or geometry(f["geometry"]).intersects(geometry(aoi)):
                    features.append(f)
            next_url = page.get("pagination", {}).get("next")
            if not next_url:
                break
            if not next_url.startswith("https://api.weather.gov/alerts"):
                raise ValueError("Unexpected alert pagination URL")
            check(.6)
            page = json_request(next_url)
        code = {'FL':'12','CA':'06'}.get(area)
        if code is None:
            raise ValueError('NWS pilots support Florida and California; import other alert areas with declared coverage')
        state_geo,_ = arcgis('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0',aoi,f"STATE='{code}'",check)
        coverage = unary_union([geometry(f['geometry']) for f in state_geo['features']]).intersection(geometry(aoi))
        return dict(data=collection({"type": "FeatureCollection", "features": features}, True),
                    coverageGeometry=None if coverage.is_empty else mapping(coverage), complete=not any(not f.get("geometry") or f['properties'].get('zoneResolutionComplete') is False for f in features), sourceUpdatedAt=None)
    where = "SFHA_TF='T'" if source["id"] == "fema" else parameters.get("where", "1=1")
    data, updated = arcgis(source["endpoint"], aoi, where, check)
    coverage, complete = aoi, True
    if source["id"] == "fema":
        availability, _ = arcgis("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/0", aoi, check=check)
        coverage = mapping(unary_union([geometry(f["geometry"]) for f in availability["features"]]).intersection(geometry(aoi)))
    elif source["id"].startswith("cgs-") and source["id"] != "cgs-susceptibility":
        unevaluated, _ = arcgis(f"{CGS}/CGS_SHZ_Unevaluated_Areas/FeatureServer/0", aoi, check=check)
        states, _ = arcgis("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0", aoi, "STATE='06'", check)
        covered = unary_union([geometry(f["geometry"]) for f in states["features"]]).intersection(geometry(aoi))
        covered = covered.difference(unary_union([geometry(f["geometry"]) for f in unevaluated["features"]]))
        coverage = mapping(covered)
    elif source["id"] in ("cgs-susceptibility", "usgs-debris"):
        # These products do not certify that all non-feature space has been assessed.
        coverage = mapping(unary_union([geometry(f["geometry"]) for f in data["features"]]))
    return dict(data=data, sourceUpdatedAt=updated, coverageGeometry=coverage if geometry_or_empty(coverage) else None,
                complete=complete, queryWhere=where)


def geometry_or_empty(value):
    from shapely.geometry import shape
    return not shape(value).is_empty


def census_layer(study, parameters, decennial=False, check=lambda *_: None):
    state = parameters.get("state", "06" if geometry(study["aoi"]).centroid.x < -100 else "12")
    county = parameters.get("county", "037" if state == "06" else "057")
    if not re.fullmatch(r"\d{2}", state) or not re.fullmatch(r"\d{3}", county):
        raise ValueError("Provide numeric state and county FIPS codes")
    year = int(parameters.get("year", 2020 if decennial else 2024))
    if decennial:
        endpoint = "https://api.census.gov/data/2020/dec/pl"
        variables = ["P1_001N"]
        level = "block"
        boundary = "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/10"
    else:
        endpoint = f"https://api.census.gov/data/{year}/acs/acs5"
        groups = ["B01003", "B01001", "B19013", "B17001", "B18101", "B16001", "B25003", "B08201"]
        variables = []
        for group in groups:
            check(.1)
            metadata = json_request(f"{endpoint}/groups/{group}.json")["variables"]
            for key, v in metadata.items():
                if key.endswith("E") and key.startswith(group) and (key in {"B01003_001E", "B19013_001E", "B17001_001E", "B17001_002E", "B25003_001E", "B25003_003E", "B08201_001E", "B08201_002E"}
                        or (group == "B01001" and any(t in v.get("label", "") for t in ["65 and 66 years", "67 to 69 years", "70 to 74 years", "75 to 79 years", "80 to 84 years", "85 years and over"]))
                        or (group == "B18101" and v.get("label", "").endswith("With a disability"))
                        or (group == "B16001" and v.get("label", "").endswith('Speak English less than "very well"'))):
                    variables.extend([key, key[:-1] + "M"])
        level = "block group"
        boundary = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2024/MapServer/10" if year == 2024 else parameters.get("boundaryUrl")
        if not boundary:
            raise ValueError("For another ACS vintage, supply matching boundary GeoJSON through the context importer")
    key = os.environ.get("CENSUS_API_KEY")
    if not key:
        raise ValueError("Set CENSUS_API_KEY on the local service, or import published Census/ACS GeoJSON with matching GEOIDs and vintage")
    records = {}
    for start in range(0, len(variables), 40):
        cols = variables[start:start+40]
        page = json_request(endpoint, {"get": "NAME," + ",".join(cols), "for": f"{level}:*", "in": f"state:{state} county:{county} tract:*", "key": key})
        for row in page[1:]:
            record = dict(zip(page[0], row))
            geoid = "".join(record[k] for k in (["state", "county", "tract", "block"] if decennial else ["state", "county", "tract", "block group"]))
            records.setdefault(geoid, {}).update(record)
    data, _ = arcgis(boundary, study["aoi"], f"STATE='{state}' AND COUNTY='{county}'", check)
    for f in data["features"]:
        p = f["properties"]
        geoid = p.get("GEOID", p.get("GEOID20"))
        attrs = records.get(str(geoid), {})
        normalized = {k: (float(v) if v is not None and re.fullmatch(r"-?\d+(\.\d+)?", str(v)) and float(v) >= 0 else None) for k, v in attrs.items() if k in variables}
        f["properties"].update(normalized, GEOID=geoid, vintage=year, geographyLevel=level, contextInterpretation="Neighborhood estimate/count, not people served by an asset")
        def total(prefix, field):
            values = [v for k, v in normalized.items() if k.startswith(prefix) and k.endswith("E")]
            p[field] = sum(values) if values and all(v is not None for v in values) else None
        p["population"] = normalized.get("P1_001N" if decennial else "B01003_001E")
        p["medianHouseholdIncome"] = normalized.get("B19013_001E")
        for prefix, name in [("B01001", "age65Plus"), ("B18101", "disabilityCount"), ("B16001", "limitedEnglishCount")]:
            total(prefix, name)
        for name, num, den in [("povertyRate", "B17001_002E", "B17001_001E"), ("renterRate", "B25003_003E", "B25003_001E"), ("noVehicleRate", "B08201_002E", "B08201_001E")]:
            p[name] = normalized.get(num) / normalized[den] if normalized.get(num) is not None and normalized.get(den) else None
        f["id"] = str(geoid)
    return dict(data=data, complete=True, coverageGeometry=study["aoi"], sourceCrs="EPSG:4326", vintage=year, geographyLevel=level,
                rows=[f["properties"] for f in data["features"]], sourceUrl=endpoint)


def cec_history(parameters, check):
    page = request("https://www.energy.ca.gov/files/zev-and-infrastructure-stats-data").text
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>Vehicle_Population[^<]*', page, re.I)
    if not links:
        raise ValueError("CEC download link changed; import the published vehicle population workbook or normalized history CSV")
    url = links[-1] if links[-1].startswith("http") else "https://www.energy.ca.gov" + links[-1]
    check(.2)
    result = parse_cec(request(url).content, parameters, url)
    if parameters.get('aoi'):
        county = str(parameters.get('countyName','Los Angeles')).replace("'", "''")
        data, _ = arcgis('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1',parameters['aoi'],f"STATE='06' AND BASENAME='{county}'",check)
        for f in data['features']:
            f['properties'].update(result['rows'][-1], vintage=result['rows'][-1]['year'])
        result['data'] = data
    return result


def parse_cec(content, parameters, source_url="Imported CEC workbook"):
    book = pd.ExcelFile(io.BytesIO(content))
    county = parameters.get("countyName", "Los Angeles")
    rows = []
    for sheet in book.sheet_names:
        raw = pd.read_excel(book, sheet_name=sheet, header=None)
        for index in range(min(25, len(raw))):
            cells = [str(x).strip() for x in raw.iloc[index]]
            if any(c in ("Year", "Data Year") for c in cells) and any("County" in c for c in cells):
                frame = raw.iloc[index+1:].copy()
                frame.columns = cells
                # The publisher uses flat tables; find fields by documented semantic names.
                find = lambda pattern: next((c for c in cells if re.search(pattern, c, re.I)), None)
                yc, cc, fuel, count = find(r"^(Data )?Year$"), find(r"^County$"), find(r"^Dashboard Fuel Type Group$|^Fuel Type$|Technology"), find(r"^Number of Vehicles$|^Vehicle Population$|^Population$|^Count$|^Vehicles$")
                if not all([yc, cc, fuel, count]):
                    continue
                for _, r in frame.iterrows():
                    if str(r[cc]).strip() != county or pd.isna(r[yc]) or pd.isna(r[count]):
                        continue
                    rows.append(dict(year=int(r[yc]), fuel=str(r[fuel]), count=float(r[count])))
                break
    if not rows:
        raise ValueError("No recognized county population table in this workbook; use year,bev,phev,total CSV with published provenance")
    grouped = {}
    for r in rows:
        p = grouped.setdefault(r["year"], dict(year=r["year"], bev=0., phev=0., total=0., geographyId=county, geographyLevel="county", sourceUrl=source_url))
        f = r["fuel"].lower()
        p["total"] += r["count"]
        if f in ("bev", "battery electric", "electric", "battery electric (bev)", "battery electric vehicle (bev)"):
            p["bev"] += r["count"]
        elif "plug" in f or f == "phev":
            p["phev"] += r["count"]
    # CEC documents a calendar-year transition discontinuity in 2017.
    rows = sorted((r for r in grouped.values() if r["year"] >= 2018), key=lambda r:r["year"])
    return dict(rows=rows, excludedHistoricalYears="Pre-2018 omitted because calendar-year reporting changed in 2017", data={"type": "FeatureCollection", "features": []},
                geographyLevel="county", geographyId=county, sourceUrl=source_url, complete=True)


def eia_history(parameters, check):
    start, end = int(parameters.get("startYear", 2013)), int(parameters.get("endYear", 2024))
    utility = str(parameters.get("utilityId", ""))
    if not utility.isdigit() or not 2013 <= start <= end <= 2030:
        raise ValueError("Provide EIA utility ID and a published annual range starting in 2013")
    records, territories = [], []
    for year in range(start, end+1):
        check((year-start) / (end-start+1))
        url = f"https://www.eia.gov/electricity/data/eia861/zip/f861{year}.zip"
        archive = zipfile.ZipFile(io.BytesIO(request(url).content))
        if year == end:
            territory_file = next((n for n in archive.namelist() if 'service_territory' in n.lower() and n.endswith('.xlsx')), None)
            if territory_file:
                frame = pd.read_excel(io.BytesIO(archive.read(territory_file)))
                matched = frame[frame['Utility Number'].astype(str).str.split('.').str[0] == utility]
                territories = [{'state': str(r['State']), 'county': str(r['County'])} for _,r in matched.iterrows()]
        files = [n for n in archive.namelist() if "reliability" in n.lower() and n.lower().endswith(".xlsx")]
        if len(files) != 1:
            raise ValueError(f"No unique reliability workbook for {year}; supply a published export")
        raw = pd.read_excel(io.BytesIO(archive.read(files[0])), header=None)
        index = next((i for i in range(min(15, len(raw))) if any("utility number" in str(v).lower() for v in raw.iloc[i])), None)
        if index is None:
            raise ValueError(f"Reliability workbook layout changed in {year}; use normalized CSV import")
        # Preserve publisher columns exactly, including major-event and method columns.
        cols = [str(v).strip() if not pd.isna(v) else f"column_{i}" for i, v in enumerate(raw.iloc[index])]
        frame = raw.iloc[index+1:].copy()
        frame.columns = [f"{c}_{i}" for i, c in enumerate(cols)]
        uc = next(c for c in frame.columns if "utility number" in c.lower())
        for _, r in frame.iterrows():
            if str(r[uc]).split(".")[0] != utility:
                continue
            original = {c: v.item() if hasattr(v, "item") else v for c, v in r.items() if not pd.isna(v)}
            # EIA's three header rows separate methods and major-event bases.
            method_labels = raw.iloc[max(0,index-2)].ffill().tolist()
            basis_labels = raw.iloc[max(0,index-1)].ffill().tolist()
            positions = [j for j,c in enumerate(cols) if 'saidi' in c.lower() and j+1<len(cols) and 'saifi' in cols[j+1].lower()]
            for position in positions:
                    method_label = str(method_labels[position]).lower()
                    method = 'IEEE' if 'ieee' in method_label else 'Other' if 'other' in method_label else 'Unknown'
                    basis_label = str(basis_labels[position]).lower()
                    basis = 'without_major_events' if 'without' in basis_label else 'loss_of_supply_removed' if 'loss' in basis_label else 'with_major_events' if 'all' in basis_label or 'with' in basis_label else 'Unknown'
                    if position + 1 >= len(r):
                        continue
                    saidi, saifi = pd.to_numeric(r.iloc[position], errors="coerce"), pd.to_numeric(r.iloc[position+1], errors="coerce")
                    if pd.isna(saidi) and pd.isna(saifi):
                        continue
                    records.append({"year": year, "utilityId": utility, "utilityName": str(r.iloc[2]), "state": str(r.iloc[3]),
                                    "method": method, "eventBasis": basis, "saidi": None if pd.isna(saidi) else float(saidi),
                                    "saifi": None if pd.isna(saifi) else float(saifi), "saidiUnit": "minutes/customer/year",
                                    "saifiUnit": "interruptions/customer/year", "sourceUrl": url, "sourceAttributes": original,
                                    "geographyLevel": "utility reporting scope", "interpretation": "Utility annual reliability; not asset-level reliability"})
    if not records:
        raise ValueError("No reliability records for this utility in the requested years")
    features = []
    coverage_error = None
    try:
        for territory in territories:
            abbreviation, county_name = territory['state'].replace("'", "''"), territory['county'].replace("'", "''")
            states, _ = arcgis('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0', parameters['aoi'], f"STUSAB='{abbreviation}'", check)
            if not states['features']:
                continue
            code = states['features'][0]['properties']['STATE']
            counties, _ = arcgis('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1', parameters['aoi'], f"STATE='{code}' AND BASENAME='{county_name}'", check)
            latest = [r for r in records if r['year'] == end and r['state'] == territory['state'] and r['eventBasis'] == 'with_major_events']
            selected = next((r for r in latest if r['method'] == 'IEEE'), latest[0] if latest else None)
            for f in counties['features']:
                p = f['properties']
                f['id'] = f"{utility}-{p['GEOID']}"
                p.update(utilityId=utility, geographicInterpretation='Approximate utility-linked county coverage; overlapping service territories are possible')
                if selected:
                    p.update({k: selected[k] for k in ('year','method','eventBasis','saidi','saifi','saidiUnit','saifiUnit')})
                features.append(f)
    except (ValueError, httpx.HTTPError) as exc:
        coverage_error = str(exc)
    return dict(rows=records, data={"type": "FeatureCollection", "features": features}, complete=True,
                coverageError=coverage_error, geographyLevel="utility reporting scope", interpretation="Annual indices at utility/reporting scope. Mapped counties are approximate coverage, never asset-level reliability.")


def afdc_history(parameters, check):
    state = parameters.get("stateName", "Florida")
    start, end = int(parameters.get("startYear", 2016)), int(parameters.get("endYear", 2025))
    if not 2016 <= start <= end <= 2030:
        raise ValueError("Provide a published vehicle registration year range")
    records = []
    for year in range(start, end + 1):
        check((year-start) / (end-start+1))
        url = f"https://afdc.energy.gov/vehicle-registration?year={year}"
        tables = pd.read_html(io.StringIO(request(url).text))
        table = next((t for t in tables if any("State" in str(c) for c in t.columns)), None)
        if table is None:
            raise ValueError("AFDC table changed; use a published history CSV")
        columns = {str(c): c for c in table.columns}
        sc = next(c for c in table.columns if "State" in str(c))
        found = table[table[sc].astype(str).str.strip() == state]
        if len(found) != 1:
            raise ValueError("State registration record not found")
        r = found.iloc[0]
        def count(label):
            col = next((c for c in table.columns if label in str(c)), None)
            if col is None:
                raise ValueError("Missing vehicle count field")
            return float(str(r[col]).replace(",", ""))
        nums = [pd.to_numeric(str(r[c]).replace(",", ""), errors="coerce") for c in table.columns if c != sc]
        records.append(dict(year=year, bev=count("Electric (EV)"), phev=count("Plug-In Hybrid"),
                            total=float(sum(n for n in nums if not pd.isna(n))), geographyId=state, geographyLevel="state",
                            roundedTo=100, sourceUrl=url))
    data = {'type':'FeatureCollection','features':[]}
    if parameters.get('aoi'):
        name = str(state).replace("'","''")
        data, _ = arcgis('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0',parameters['aoi'],f"BASENAME='{name}'",check)
        for f in data['features']:
            f['properties'].update(records[-1])
    return dict(rows=records, complete=True, geographyLevel="state", geographyId=state, data=data)


def public_imagery(study, parameters, artifacts, check):
    from .rasters import raster_metadata
    import uuid
    if not parameters.get("captureDate") or not parameters.get("sourceRights"):
        raise ValueError("Verify and supply imagery capture date and rights before requesting an orthophoto crop")
    endpoint = next(s["endpoint"] for s in CATALOG if s["id"] == "naip")
    bounds = geometry(study["aoi"]).bounds
    check(.1)
    response = request(endpoint + "/exportImage", {"f": "json", "bbox": ",".join(map(str, bounds)), "bboxSR": 4326, "imageSR": 3857,
                                                   "size": "2048,2048", "format": "tiff", "pixelType": "U8", "bandIds": "0,1,2"}).json()
    url = response.get("href")
    if not url or not url.startswith("https://gis.apfo.usda.gov/"):
        raise ValueError("Public orthophoto service is unavailable; upload a licensed GeoTIFF instead")
    check(.5)
    content = request(url).content
    if len(content) > 100 * 1024**2:
        raise ValueError("Public image crop exceeds 100 MB")
    name = str(uuid.uuid4()) + ".tif"
    path = artifacts / name
    path.write_bytes(content)
    try:
        return {**raster_metadata(path), "rasterArtifact": name, "captureDate": parameters["captureDate"],
                "sourceRights": parameters["sourceRights"], "sourceUrl": endpoint, "data": {"type": "FeatureCollection", "features": []}}
    except Exception:
        path.unlink(missing_ok=True)
        raise
