# SPATIAL D

A browser-based spatial digital twin foundation for utility asset inspection. Built with Vite, plain JavaScript, MapLibre, deck.gl, and Three.js. The default **United States** workspace connects published electric substations, electric power transmission lines, and natural gas pipelines. There is no synthetic startup network, connectivity, telemetry, or event history.

## Run locally

Requires Node.js 20.19+ or 22.12+ and npm.

```sh
npm install
npm run dev -- --port 5178
```

Open `http://127.0.0.1:5178`. Without a Google key the app opens in 2D. A network connection supplies the public infrastructure and OpenFreeMap geographic context. Successful infrastructure loads are cached in IndexedDB; source failures retain previous records and offer retry controls. If the basemap fails, loaded utility geometry remains on a plain background. If WebGL is unavailable, the inventory and import workflows remain accessible.

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run preview -- --port 5178
```

The production client output is `dist/client/`, with the Sites Worker in `dist/server/`. Run `npm start` after building to serve it with the highway-camera streaming proxy (default `http://127.0.0.1:5178`, configurable with `HOST` and `PORT`). Vite development and preview servers also include this proxy. Static hosting supports the map and inventory, but live cameras require the `/api/highway-cameras/:id/stream` and `/api/highway-cameras/:id/snapshot` routes from `server/highway-cameras.js` on the same origin. No account or database service is required. The isolated browser test server uses port 5179 with the Google key disabled. Public-provider requests are stubbed in automated tests so network availability does not determine their result.

## Run with Docker Compose

With Docker Desktop or Docker Engine and the Compose plugin running, build and
start the application from the repository root:

```sh
docker compose up --build -d
```

Open `http://127.0.0.1:5178`. The container serves the production application,
bundled transmission tiles, and camera video/image proxy. Its health check
confirms that the application responds. This default build opens in 2D.

To enable Google photorealistic 3D, supply the key from your existing
`.env.local` at runtime:

```sh
docker compose --env-file .env.local up --build -d
```

Compose passes `GOOGLE_API_KEY` (or the legacy `VITE_GOOGLE_MAPS_API_KEY`) to the running server. Changing it requires recreating the container, without rebuilding the frontend. The `.env.local` file is excluded from the image and build context. The map key is browser-visible through the runtime map configuration endpoint.

Use `GEOBOUND_PORT=5180 docker compose up --build -d` if port 5178 is occupied.
Compose binds the published port to the local machine. Workspaces and preferences
remain in browser storage for the chosen URL; no Docker volume is required.

```sh
docker compose ps
docker compose logs -f geobound
docker compose down
```

The [Dockerfile](Dockerfile) builds with Node.js 24 and copies the production
bundle and proxy source into a separate runtime image. The runtime runs as the
`node` user and does not require the frontend build tools or raw source models.

## Saved map layers and basemaps

Use the square **Map layers and basemaps** button at the bottom right of the map.
The menu contains the basemap selector, **Add layer**, **Add basemap**, and the
existing infrastructure, OSM, camera, PV, and 3D environment controls.

Add an overlay from a **GeoJSON file**, **GeoJSON URL**, or **raster XYZ tile URL**.
GeoJSON supports points, lines, polygons, multipart geometry, and geometry
collections with valid WGS84 longitude/latitude coordinates. Files and URL
responses are limited to 20 MB. Choose a name, color, and optional attribution.
Layers can be shown, hidden, removed, or framed using **View**. URL-based GeoJSON
also has **Refresh**; a failed refresh retains the saved snapshot.

Choose the Geobound dark, OpenFreeMap streets, OpenFreeMap light, or plain
background basemap, or add a custom **MapLibre style URL** or **raster XYZ tile
URL**. XYZ templates must contain `{z}`, `{x}`, and `{y}`. Remote providers must
allow browser requests through CORS. Relative style resources are resolved
against the style URL. Switching basemaps retains the camera and utility,
OSM, PV, camera, and custom overlays. Basemap failures show a plain background
with the overlays retained and a retry control in the menu.

Custom overlays and basemaps display in **2D**; adding or enabling an overlay,
selecting a basemap, or viewing a custom layer opens that map mode. These
sources, GeoJSON snapshots, visibility choices, and the selected basemap are
saved in IndexedDB across reloads and workspaces on the same browser origin.
Raster tiles and basemap imagery are fetched on demand and are not stored.
Hidden raster overlays do not request tiles. A storage failure rejects the
change and reports it rather than claiming that the source was saved.
Custom map context is separate from the utility registry and workspace exports.

## Highway cameras

**Highway cameras** includes **366 Tampa FDOT cameras**: the intersection of the 393 cameras listed on [MileCheck’s Tampa page](https://milecheckapp.com/cameras/tampa/) and enabled records with HTTPS video URLs and valid WGS84 points in `camera-feeds.json`. The 27 image-only cameras and cameras outside that Tampa list are omitted. The source list and provenance are stored in `src/data/tampa-cameras.json`. The layer starts enabled, persists its toggle, and uses camera symbols in both 2D and 3D. Symbols appear when the larger ground dimension of the view is **10,000 feet (3,048 m) or less**, so cameras remain selectable in wider neighborhood views. In 2D the filter includes cameras inside the viewport; in 3D sprites also require a visible projected position and use the camera's projected ground view extent. The full catalog remains available. Zooming beyond the limit or moving a selected camera out of view closes its feed and stops playback. Select a symbol to open a live video popup with playback controls, camera location and direction, retry, and a link to FL511. Closing the popup, hiding the layer, changing views, or leaving the map stops playback.

The feeds use HLS. The popup loads HLS.js on demand, with native HLS as a fallback. FL511 requires a fresh token exchange and provider referrer, so the server relays authorized playlists and their media files. The proxy accepts only listed cameras and resources inside their stream directories; tokens stay on the server. If video fails to load, the popup shows an official FDOT image and refreshes it every 30 seconds while open. Users can also choose **Show image** immediately or **Try video** to reconnect. Images are refreshed snapshots, not continuous video. The image proxy uses each record’s `imageId` (which can differ from its camera ID), accepts only cataloged official FL511 image URLs, and requires no video token exchange or MileCheck proxy. Closing the popup also cancels image refreshes. Both stream and image availability depend on FL511; unavailable images show a retry message without interrupting the map.

California cameras are saved separately for future use in [data/camera-catalogs/caltrans-camera-feeds.json](data/camera-catalogs/caltrans-camera-feeds.json), with a matching [CSV index](data/camera-catalogs/caltrans-camera-feeds.csv). The catalog comes from the [official Caltrans CCTV feeds](https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm) for all 12 districts, cross-checked against [QuickMap’s camera KML](https://quickmap.dot.ca.gov/data/v2_cctv.kml). Each video record includes its district and publisher index, WGS84 location, roadway, direction, county, service status, video and snapshot URLs, source timestamps, and a QuickMap location link. Image-only records are counted but excluded from this video catalog. Records marked out of service remain indexed with their published status. The catalog is outside the app’s public and source directories and is never imported into a map layer or the Tampa camera proxy.

Refresh this reference catalog with `npm run index:caltrans-cameras -- --verify`. The generator downloads all 12 district feeds, rejects duplicate identities and invalid coordinates, and checks each unique video playlist with at most six concurrent requests and an eight-second timeout. `playlist-ok` means the URL returned an HLS playlist containing media references at the recorded check time; it does not certify segment availability or continued playback. Failed endpoints retain their check status for future retries. The publisher’s original URL is preserved alongside the HTTPS URL, including corrections for a reported HTTP URL and one missing leading `h`. Without `--verify`, playlist statuses are explicitly `not-checked`. No footage or camera images are stored.

## Solar PV buildings

The **PV system size** layer in the 2D public workspace colors real footprints
from the existing local OSM Buildings layer. It includes only public TECO
solar locations within that layer's coverage: 114 sites assigned to 108
buildings. Each location selects the nearest footprint; equally distant
footprints select the larger building. No solar circle symbols are rendered.
Unreported sizes use base yellow. Reported sizes use a yellow-to-red scale
at 5, 10, 25 and 100 kW. Multiple records on one building retain all source
links and use the largest reported capacity, rather than adding potentially
duplicate permits. Click a roof for capacity, source records, and matching
distance. The layer toggle persists; expand its details for the legend and
**View PV sites** control.

The complete public [TECO CSV](data/solar/panelcensus/teco/teco-sites.csv)
contains 1,112 records from 23 result pages, all detail pages collected;
273 report system size and 839 leave it unknown. The
[model generator CSV](data/solar/teco-models/teco-asymmetric-sgen.csv) separately
contains all 883 devices from 63 supplied PKLs, joined to their connected
bus coordinates, with phase totals and public-site comparison candidates.
Model operating power is not substituted for installed PV capacity.

Regenerate the map layer with `npm run generate:solar-buildings`. It uses
the captured public records and the local OSM Buildings GeoJSON, preserving
source identities and ODbL attribution. Geographic assignment to a nearest
building does not independently verify rooftop PV.

**PKL PV buildings** is a separate 2D layer with an independent saved toggle.
It fills 462 local OSM building footprints red for the 463 model generators
whose connected buses lie inside that OSM coverage. It uses the same nearest
building rule and larger-footprint tie break. Red is drawn above public PV
colors where the two layers overlap; hiding the PKL layer reveals the public
size colors. Click a red building for generator identity, feeder, connected
bus, model file and modeled active power. The original selection includes all
`asymmetric_sgen` devices because the models do not classify technology or
contain PV names; modeled generation is not installed PV capacity.

Regenerate this layer with `npm run generate:pkl-pv-buildings`. The generator
checks all original PKL hashes against the verified extraction before making
the local OSM footprint associations. The browser loads a small static
GeoJSON dataset and never loads or executes pickle files.

## Public infrastructure

County solar installation figures for all 50 states are saved separately in [data/solar/panelcensus](data/solar/panelcensus/README.md), with CSV and JSON exports, state coverage, source table captures, and a verifier that compares every row with the live state pages. Refresh with `npm run scrape:solar-counties`, then verify with `npm run verify:solar-counties`.

The three startup layers are defined in `src/data/public-layers.js` and cataloged in `config/sources.json`:

- [Substations](https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer), queried through layer 0.
- [U.S. electric power transmission lines](https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer), queried through layer 0. The [publisher marks this dataset as archived](https://www.arcgis.com/home/item.html?id=d4090758322c4d32a4cd002ffaa0aa12).
- [Natural gas pipelines via ORNL Open Energy Hub](https://openenergyhub.ornl.gov/api/explore/v2.1/catalog/datasets/naturalgas_interintrastate_pipelines_us_eia/records?limit=100), sourced from EIA. Its records API accepts at most 100 records per request; the supplied `limit=20000` URL is invalid. Larger area queries use a filtered GeoJSON export.

On first upgrade, the 2D map frames the contiguous United States. **View entire U.S.**, **Alaska**, **Hawaii**, **Puerto Rico**, and **Guam** controls frame the available transmission coverage. The national overview uses 94,619 published transmission records, served as simplified, cached MVT tiles at zooms 0–8. Like CARTO cloud-next, deck.gl loads only visible tiles, decodes binary geometry in a bundled worker, and draws it on the GPU. Disabled transmission layers do not load tiles. Country navigation defers regional API requests; zooming into an area loads full source geometry, including intersecting pipelines rather than only their centroids. Local full-resolution transmission records replace matching tile features, preventing duplicate additive brightness.

The national overview remains available beyond the regional 4,000-record API limit. Both spatial views report navigation changes. Regional queries use a padded area, ordered paging, WGS84 output, and stable source IDs. A failed source retains its cached snapshot. Select an overview line to retrieve its complete original source record for inspection. Inventory pages show 100 rows at a time; inventory, search, and workspace exports include loaded full records. Overview tile fragments remain separate from workspace assets.

Regenerate the bundled overview with `npm run generate:national-transmission -- --refresh`. The generator checks the complete ordered source download, rejects duplicate IDs or incomplete pages, validates WGS84 line geometry, and writes the feature count, source dates, omitted IDs, and populated tile index to `public/data/us-transmission/manifest.json`. Without `--refresh` it reuses the last download in `/tmp/tidebound-us-transmission-source.json`. The overview is a published-source snapshot; **Refresh map area** refreshes detailed regional records.

Layer switches, **Refresh map area**, and Data Sources retry controls manage the three sources independently. Source attributes and timestamps remain inspectable, and map attribution links to the publishers. Missing geometry is reported as omitted source records. Duplicate identities, incomplete paging, unsupported coordinate systems, and API errors reject a source update. A failed source does not replace its previous snapshot or remove imported data. Selected assets and assets referenced by imported measurements or topology remain available when the map moves to a different area.

Substations use small black diamond symbols, with a pale outline for legibility and a white selection outline. Symbols appear only when the larger ground dimension of the map view is **1,000 feet (304.8 m) or less**, and update during zoom and resize. Searching for a substation zooms to that close view. Substation records remain in the inventory when symbols are hidden. In 3D the same limit uses the camera's projected ground view extent; black diamond markers and nearby transformer banks retain their illustrative detail. Transmission lines match [CARTO cloud-next’s page-two layer](https://github.com/CartoDB/cloud-next/blob/master/layers/powerLines.js): RGBA (83, 135, 185, 180) with [additive blending](https://github.com/CartoDB/cloud-next/blob/master/layers/blending.js), `SRC_ALPHA` + `DST_ALPHA` and `FUNC_ADD`. Overlaps brighten from blue toward white. The 2D renderer uses deck.gl’s joined paths with antialiasing and a one-pixel base width; the 3D conductors use the same blend factors. Selection remains available.

Published operational status is not real-time telemetry. These sources do not supply explicit terminals and connectivity nodes, so the app does not infer network connections, energized state, measurements, or events from their geometry. The footer distinguishes fetch time from provider metadata update dates.

On first upgrade, the application removes its previously shipped synthetic Tampa dataset and associated records from browser storage. Separately imported assets and workspaces are retained. The initial public workspace is `public/data/workspace.json`; regenerate it after catalog changes with `npm run generate:workspace`.

## Local OpenStreetMap overlays

The downloaded `data/map1.osm` through `data/map4.osm` are available under **Local OSM layers** on the map. Six independently selectable layers contain **32,202 features**: roads and paths (5,225), buildings (22,572), water and waterways (113), land cover and parks (1,660), places and amenities (2,055), and mapped utility features (577). Roads, water, and utilities start enabled; the other layers load when enabled. All choices persist locally. Click a feature to inspect its original OSM tags, stable identity, source edit timestamp, version, and contributing files.

These four exports cover parts of **South Tampa**, rather than the whole Tampa Bay region. Use **Go to downloaded area** to frame their coverage. The manifest lists each original download rectangle; complete source ways can extend outside those rectangles. The conversion merges duplicate node/way/relation identities, keeps the newest version, reconstructs complete multipolygons with holes, and omits three incomplete relations. Download gaps remain gaps. OSM utility tags do not establish engineering topology or operating state.

The converted, attributed GeoJSON files and coverage report live in `public/data/osm/tampa-bay/`. Regenerate after replacing the source exports:

```sh
npm run generate:osm
```

Regeneration requires Python 3 with its standard library; running the application and building existing generated files do not. Raw XML is converted before serving, and disabled display layers are fetched on demand. The 3D transmission renderer also loads roads, water, buildings, and land cover as independent placement constraints. In 3D these context features use batched outlines and points rather than thousands of individual meshes; source height tags remain metadata, and display offsets are illustrative. Local overlays also work when the remote basemap is unavailable.

OSM context remains separate from the canonical utility asset registry and workspace exports. The derived overlay files are distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) with [OpenStreetMap contributor attribution](https://www.openstreetmap.org/copyright). Their manifest, source hashes, and conversion notice are available alongside the files. See [the conversion details](docs/osm-layers.md).

## Photorealistic 3D

The active 3D view uses **Google Maps JavaScript API**, `importLibrary("maps3d")`, and `Map3DElement` in `SATELLITE` mode. This renders Google's photorealistic 3D building and terrain meshes, not a tilted 2D satellite map. The app retains the existing header, navigation, 2D view, regional source overlays, selection, and camera popups. Native gestures plus zoom/reset, rotate, north, and tilt controls move the camera. Viewpoints save center, altitude, range, tilt, and heading; old Three.js viewpoints retain their geographic center.

For local Vite development/preview, copy `.env.example` to the ignored `.env.local`, set `GOOGLE_API_KEY`, and restart Vite. For `npm start`, export `GOOGLE_API_KEY` in the process environment (or use Node's `--env-file=.env.local`). For Sites, set `GOOGLE_API_KEY` in the Site runtime environment. Existing `VITE_GOOGLE_MAPS_API_KEY` configuration remains supported as a fallback. `/api/map-config` returns only the named browser-map key with `Cache-Control: no-store`; unrelated server credentials are never returned. No key is hardcoded, logged, or committed. A Maps JavaScript key is necessarily visible to the browser: restrict it in Google Cloud to the website referrers (including `https://gis.n2wm787gnp.chatgpt.site/*`, and localhost only when needed) and **Maps JavaScript API**. Enable that API and billing; Map Tiles API access alone does not authorize the JavaScript SDK.

The loading panel stays visible until Google's `gmp-steadychange` reports a rendered scene. Script/network failure, authentication failure, initialization errors, or a 45-second render timeout give a concrete message, retain the 2D workflow, and offer Retry 3D. Hardware acceleration is required. Google's own attribution stays visible. Google tiles, imagery, and sampled display heights are never persisted in workspace storage or exports.

Transmission paths without complete coordinate elevations render 24 m above terrain using Google's `RELATIVE_TO_GROUND` altitude mode, matching the existing illustrative 24 m support model. Overhead distribution lines use a 14 m display offset. These defaults are visualization estimates, not surveyed conductor heights or engineering clearances; actual support positions and sag are not inferred. The inspector distinguishes display estimates from supplied elevations. Explicit numeric `heightAboveGroundM` or `conductorHeightM` attributes override the default offset; complete coordinate elevations retain `ABSOLUTE` placement. A path with partial coordinate elevations uses the relative display rule throughout rather than mixing altitude datums. Explicitly underground/buried/submarine construction, gas routes, and other context stay at ground level unless coordinate elevations are supplied. Only rendering coordinates are derived: the source record, workspace exports, and 2D geometry stay unchanged. Local OSM outlines and utility records remain selectable. Substation and camera extent thresholds remain in effect. The renderer bounds overlay work to the local viewport and 1,500 shapes, with a zoom-in message when exceeded. Custom layers, nationwide overview tiles, and PV-specific controls continue to use 2D.

The previous Three.js renderer and illustrative equipment/atmosphere implementation are retained in `src/spatial/map3d.js` for reference and existing renderer tests; they are not mounted by the active 3D view. Google's renderer owns sky and terrain, so the old volumetric-cloud controls are not shown.

## Legacy 3D utility equipment

Transmission routes show three separated A/B/C conductors with illustrative sag and a 3 px width (4.5 px when selected). Supports use the supplied **POSTE 05** pole model, with its transformer, lower crossarms, streetlight, and original wire spans removed from a separate runtime derivative. The paired upper crossarms and their eight insulators remain; three matching pairs carry A/B/C. **One illustrative pole sits directly on each interior route bend** in the ArcGIS transmission geometry. Shared bends reuse a single pole across overlapping records. Straight spans and route endpoints receive no generated poles; crossarms follow the bend bisector and all three phases attach to the pole's insulator seats. These illustrative bend supports are available outside the downloaded OSM area and do not depend on local screening files. Model instances are limited to the nearest 384 bends within 8 km, with terrain grounding for nearby supports, to keep the 3D view responsive as the camera moves. Neither pole placement nor source geometry is persisted as surveyed data.

The supplied OBJ, MTL, FBX, and Blender files remain unchanged in `src/assets/`. `npm run prepare:pole` creates `transmission-pole.glb` and its attachment metadata from the OBJ/MTL without requiring Blender or a browser. The derivative has a neutral gray matte shaft and gray paired crossarms with brown upper insulators, matching the supplied reference. Selection highlights the conductors while retaining this pole finish. The view loads this derivative once and instances it at nearby and distant turns. The display pole is normalized to 24 m; the conductor seats are derived from the actual upper-insulator mesh at approximately 23.84 m, with short jumpers across each paired row. Wire and pole transforms share the same terrain/source-elevation reference. The previous electricity-pole GLBs are unused. Generated supports are illustrative equipment, not surveyed pole records or imported assets.

Gas routes render as rounded translucent underground pipes, with a 0.9 m display radius and a centerline 2.2 m below the available surface. Nearby routes sample terrain independently of pole placement; interpolation follows the ground without aerial spline arches. A separate utility render pass makes the buried pipe visible as an inspection cutaway. Where terrain is unavailable, the display uses source elevation or the ellipsoid as its reference. Substations render as three-phase transformer banks: three phase units, three concentric winding assemblies per unit, grouped HV/LV/tertiary bushings, oil conservators, and 72 radiator fins per bank. The inspection cutaway reveals the windings. Nearby banks show equipment detail; distant substations retain map markers. Pipe depth/radius, sag, pole dimensions, phase spacing, and equipment arrangement are display defaults in `src/spatial/utility-equipment.js`, rather than verified engineering dimensions or winding configurations.

Where sufficiently detailed Google terrain is loaded, nearby equipment can use temporary surface heights for display and conductor alignment. Coarse or unreasonable surface estimates are rejected. Transmission spans interpolate missing ground heights along each route and share a resolved height with the pole at every bend. Overlapping routes resolve their shared poles before either line is drawn. This prevents unsampled bends from jumping to ellipsoid height and producing spikes. Source geometry and declared elevations remain unchanged; sampled or interpolated map heights are never persisted or exported. Generated supports, winding details, and pipe meshes are never added to the canonical network or measurements. Selection still identifies the published transmission, pipeline, or substation record.

The atmosphere starts with a reduced render rate while its background GPU work initializes, then restores the full rate. Both engines dispose their generated geometries, model textures, and instance buffers when the view closes.

## Workflows

- **Analysis:** local resilience studies, hazard exposure, evidence checklists, captured-history replay, supplied scenario comparisons, demographic/reliability context, experimental PV/EV models, geospatial tools, plots and portable review packages. Start the companion service with `npm run analysis:serve`; see [workbench setup and interpretation](docs/analysis.md).

- **Spatial:** asset layers, search, selection, recorded adjacency, zoom/reset, and 2D/3D views.
- **Assets:** searchable inventory, type/network filters, details, terminals, events, and provenance.
- **Measurements:** quantity/phase-specific historical charts, explicit units, quality flags, and gaps for missing values.
- **Data Sources:** dataset inspection, a categorized source catalog, validated imports, export, and dataset removal.
- **Settings:** appearance, preferred map mode, workspace name/timezone, and restoration of the three default public layer switches.

Sidebar expansion, theme, layer preferences, and camera positions are saved locally. Selection and filters survive section navigation. Workspaces and imported records persist in IndexedDB on the same browser and origin. Port or hostname changes create a different browser-storage origin. Export before clearing browser data or moving to another browser.

## Data and architecture

See [the data model and diagram](docs/data-model.md), [source locations and integration status](docs/data-sources.md), and [import formats](docs/imports.md).

- `src/domain/`: public JSDoc contracts, asset type registries, AJV schema validation, and relationship checks.
- `src/data/`: pure import previews and the asynchronous `BrowserDataProvider`. Reads return copies; mutations are validated and transactional. Import previews are checked against the persisted workspace before commit.
- `src/components/`: inspection and workflow views.
- `src/spatial/`: lazy-loaded 2D and 3D implementations of the `SpatialView` contract.
- `src/store.js`: observable application state and display preferences.
- `schemas/twin.schema.json`: version 1 interchange schema.
- `config/sources.json`: default data-source catalog.
- `public/data/workspace.json`: initial Tampa Bay workspace and source catalog, with no fabricated asset records.
- `src/data/public-layers.js`: read-only ArcGIS and ORNL adapters, normalization, area limits, and source snapshot merging.

Synthetic records used by isolated regression tests live under `tests/fixtures/tampa-electric/`; they are not shipped in `public/` or loaded by the production app. Regenerate these test fixtures with `npm run generate:test-fixture`.

Future remote data providers can implement the asynchronous methods documented in `src/domain/types.js`; the UI and spatial renderers consume normalized domain records. Water and gas types are registered and covered by model tests. Full utility workflows, live utility telemetry, additional contextual adapters, engineering solvers, authentication, and equipment actuation remain future work.

## Verification

Domain tests cover OSM deduplication, multipolygon holes, incomplete references, generated geometry and identities, public-source paging, geometry and unit normalization, error handling, cache migration, retention of imported references, explicit topology, CSV parsing, transactional imports, and persistence. Browser tests cover selectable OSM overlays, tag inspection, persisted visibility, local-source failures and retry, the public startup layers, inspection, pagination, area loading, cached-source failures and retry, clouds, selection, imports, settings, and responsive layouts.

Provider availability is separate from catalog status: **implemented** means an adapter exists; it does not claim that the remote service is currently healthy. Catalog-only entries never initiate requests.
