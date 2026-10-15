# Resilience workbench

Geobound's **Analysis** section is a local planning workbench. It analyzes supplied and published geometry; it does not infer outages, customers served, engineering connectivity, or failure probabilities.

## Start locally

Install Python 3.11, then from the project folder:

```sh
npm run analysis:setup
npm run analysis:serve
```

In a second terminal, run the existing application with `npm run dev`. The application proxies analytical requests to port 5181. Set `ANALYSIS_URL` if the service uses a different local address.

`docker compose up --build -d` runs both services. SQLite and analytical artifacts persist in the `analysis-data` volume. The host `.analysis-data/models` folder is mounted read-only for the trained PV checkpoint. Original imagery, Google tiles, and camera footage are not included in study exports.

The ordinary map, inventory, and imports remain available when the analysis service is offline. Reconnect in Analysis after starting the service.

## Complete a planning review

1. Create a Tampa Bay or Los Angeles County study, use the current spatial-map extent, draw a polygon, or import a GeoJSON boundary.
2. Capture the browser inventory, or collect complete detailed public-source records. Manual captures are marked as incomplete coverage. Public collection is independent of map toggles and nationwide display tiles; failed/incomplete collections are never certified.
3. Load hazard evidence or import GeoJSON, GeoPackage, zipped shapefiles, or georeferenced flood-depth GeoTIFFs. Explicitly certify coverage only when justified. Select the relevant immutable version and optional individual hazard feature.
4. Analyze exposure. Inspect asset evidence and nearby FDOT/Caltrans cameras. Set review priority with a reason, record annotations and proposed actions, and retain unknown criticality.
5. Replay supplied captures, select a measurement/event cutoff, or compare a baseline with an alternative supplied scenario. Relocation GeoJSON uses `properties.assetId` to reference the frozen snapshot. Annotation text alone does not change exposure.
6. Generate spatial results and charts, save charts, and export a review ZIP and printable HTML report. SVG/PNG charts, CSV tables, GeoJSON and GeoPackage outputs are available.

The ZIP includes canonical version 1 bundles plus separately versioned analytical records, source timestamps, result checksums and saved chart definitions. Importing creates a separate study and preserves entity IDs and analytical results. Raw rasters are excluded; reimport them to recompute raster-dependent jobs.

## Public sources and geography

- FEMA: special flood hazard area polygons and availability coverage. These are mapped hazards, not current flooding.
- NWS: active alerts with issue/effective/expiry times; affected-zone geometry is resolved where possible. Unresolved timing/geometry and out-of-state coverage remain unassessed.
- CGS: liquefaction and earthquake-induced landslide investigation zones, with unevaluated areas excluded; landslide susceptibility is a different product.
- USGS: mapped fault traces and postfire debris-flow assessment basins. Basin attributes retain published scenario information; these are not complete runout footprints.
- Census: 2020 block population and 2024 ACS block-group estimates. Configure `CENSUS_API_KEY` on the local service or import attributed datasets with matching GEOIDs/vintages. Original estimates and margins of error are retained; suppressed values remain unknown.
- EIA-861: annual SAIDI/SAIFI from 2013 onward, separated by method, reporting state/scope and major-event basis. The catalog accepts an EIA utility number (Tampa Electric: **18454**). County shapes represent approximate utility-linked coverage, not surveyed service boundaries or asset reliability. Original publisher columns are retained.
- CEC: county vehicle population histories, with the documented pre-2018 reporting discontinuity excluded from modeling. DOE AFDC supports separately labeled state histories. Missing finer-scale history is not downscaled into invented local observations.

Select a numeric **Map value** for context layers to display a choropleth, with unknown values distinguished. Click a context feature to inspect its source attributes. Neighborhood statistics do not identify customers served or people affected by an asset.

Every source refresh creates a new immutable layer version. Failure retains previous versions and records source health. A retrieval-complete dataset can still have incomplete hazard assessment coverage.

Map display geometry is simplified separately from the complete immutable geometry used for jobs and exports. Repaired publisher geometry retains its original geometry and repair reason in the stored layer; result rows reference that layer rather than duplicating the original shape.

## Imported histories

An EV CSV contains:

```csv
year,geographyId,geographyLevel,bev,phev,total,sourceUrl
```

Supply at least six consecutive comparable years for one published geography. Optional `reportingBreak` and `suppressed` flags prevent unsuitable records from entering a forecast. Models compare a multinomial adoption trend with last-observed share using chronological 1–3 year backtests. Fleet growth defaults to zero. Slower/baseline/faster trend multipliers are scenario assumptions; if the flat-share baseline wins, trend multipliers do not manufacture growth. Error envelopes describe historical errors and are not calibrated probability intervals. Values through 2035 are extrapolations.

For normalized reliability imports use `year,utilityId,state,method,eventBasis,saidi,saifi,saidiUnit,saifiUnit,sourceUrl`. Do not mix methods or event bases in a comparison. A missing value is not zero. Rates and medians cannot be summed; guided rate plots use summed numerators and denominators.

## PV model

The workbench requires a trained **ResNet34 U-Net**, a model card, 8-bit RGB imagery, declared capture date/rights, and georeferencing. Ground sample distance must be at most 0.6 m for rooftop array screening. A coarse crop of a large region is rejected rather than producing misleading estimates.

Train a public reference baseline:

```sh
npm run analysis:train-pv -- --public --epochs 10 --samples 96
```

This downloads CC0 array labels and checksum-verified reference imagery from the Bradbury et al. dataset. Training uses Fresno imagery, validation uses Oxnard, and testing uses Stockton. The checkpoint and model card are stored under `.analysis-data/models`. Reference-data performance does **not** establish Tampa or Los Angeles accuracy. The model is experimental; its measured precision, recall, Dice, IoU and crop-area errors are shown in the PV tab. It does not claim validated system-capacity errors.

The initial measured [model card](./pv-model-card.json) is included in this repository. Held-out Stockton Dice is 0.363 and median positive-crop area error is about 84%; this baseline needs pilot-specific labeling and adaptation before planning estimates are dependable. Docker uses CPU PyTorch by default.

Pilot adaptation uses independently reviewed labels:

```sh
npm run analysis:train-pv -- --manifest /absolute/path/pilot-labels.json --initialize .analysis-data/models/pv.pt --epochs 10
```

The manifest is an array of `{image, labels, city, split}` records, with distinct images in `train`, `validation`, and `test`. `labels` is WGS84 PV-array GeoJSON. In-product accept/reject/correction decisions are stored separately from the original model run. Those reviews can support subsequent independent labeling and evaluation.

Array area is measured in m². DC estimates use area × efficiency, with a tilt correction when supplied; efficiency defaults to 20% and unknown tilt to an explicit 0° assumption. Efficiency sensitivity is distinct from segmentation uncertainty. Reported nameplate capacity and modeled operating-point power are never replaced by detections.

## Interfaces and operational limits

- `GET /api/analysis/health` and `GET/POST /api/analysis/studies`.
- `GET /api/analysis/studies/:id` and `POST /api/analysis/studies/:id/entities/:kind` for snapshots, layers, scenarios, findings, charts and PV reviews.
- `POST /api/analysis/studies/:id/jobs`, `GET /api/analysis/jobs/:id`, and `POST /api/analysis/jobs/:id/cancel`.
- Multipart dataset upload, study ZIP export/import, printable reports, CSV/GeoJSON/GeoPackage result exports and local raster tiles.
- `/api/analysis/cameras` exposes normalized public camera metadata. Listed Caltrans HLS/image resources are relayed by a separate provider adapter; provider availability is not guaranteed.

Set `ANALYSIS_DATA_DIR` to relocate SQLite/artifacts. `PV_CHECKPOINT` and `PV_MODEL_CARD` select model files. `ANALYSIS_FEATURES` can restrict accepted job kinds for staged releases (comma-separated `source,exposure,scenario,replay,spatial,measurements,table,ev,pv`). Credentials remain in service configuration; source failures redact credential query strings.

Jobs run on one worker and persist progress/errors/results. Cancellation is checked between processing steps; a pending upstream HTTP request may finish before cancellation. Restarted unfinished jobs are marked interrupted, requiring an explicit new run. The POC limits vector/table uploads to 100 MB, raster uploads to 1 GB, study ZIPs to 250 MB compressed / 500 MB expanded, source collections to 100,000 features per layer, and PV jobs to 25 million pixels. Large run outputs remain complete in canonical ZIP records; redundant CSV/GeoJSON copies are omitted above 5 MB and can be exported separately. Use smaller study boundaries/crops for larger inputs.

## Verification

```sh
npm test
npm run analysis:test
npm run test:e2e
npm run build
```

Analytical tests cover overlapping hazards, holes, metric buffers, coverage-aware snapshot changes, immutable scenarios, original units/gaps, raster nodata, bounded forecasts, priority validation and checksummed package round-trips. Browser tests use isolated analytical storage and stub external providers; separate live-provider checks do not certify continued availability or regional model accuracy.
