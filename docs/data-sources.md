# Default data-source locations

The authoritative catalog is [config/sources.json](../config/sources.json). The application exposes its categories, custodian, format, attribution/license reference, location, authentication requirement, and integration state. Catalog entries are definitions, not claims that live utility data is connected.

| Source | Location | First-version integration |
|---|---|---|
| Electric substations | `https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer/0` | Active ArcGIS adapter; WGS84 geometry, ordered paging, original source attributes. |
| Electric transmission | `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0` | Active ArcGIS adapter. The [publisher identifies this layer as archived](https://www.arcgis.com/home/item.html?id=d4090758322c4d32a4cd002ffaa0aa12). |
| Natural gas pipelines | `https://openenergyhub.ornl.gov/api/explore/v2.1/catalog/datasets/naturalgas_interintrastate_pipelines_us_eia` | Active ORNL/EIA adapter; spatially filtered records in pages of 100, or `/exports/geojson` for larger areas. |
| Local OpenStreetMap exports | `data/map1.osm`–`data/map4.osm` → `public/data/osm/tampa-bay/` | Six selectable context overlays; source tags, identities, versions, attribution, and coverage retained. [Conversion details](osm-layers.md). |
| Google 3D | `https://tile.googleapis.com/v1/3dtiles/root.json` | Implemented, requires `VITE_GOOGLE_MAPS_API_KEY`; [provider documentation](https://developers.google.com/maps/documentation/tile/use-renderer). |
| OpenFreeMap | `https://tiles.openfreemap.org/styles/liberty` | Implemented 2D basemap; [integration guide](https://openfreemap.org/quick_start/). |
| USGS 3DEP | `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer` | Catalog only; future elevation adapter. |
| NOAA / NWS | `https://api.weather.gov` | Catalog only; future observations, forecasts, and alerts. |
| FEMA NFHL | `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer` | Catalog only; future hazard overlay. |
| Census TIGERweb | `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb` | Catalog only; future administrative/statistical boundaries. |
| Utility GIS | Not configured | Future GeoJSON / ArcGIS REST / WFS connector; asset GeoJSON imports work now. |
| Utility AMI | Not configured | Future meter-data connector; observation CSV imports work now. |
| Utility SCADA | Not configured | Future read-only operational/historian adapter. |
| Utility OMS | Not configured | Future outage-management connector. |
| ERP / CRM / asset management | Not configured | Future enterprise records and regulatory metadata. |
| Predictive / simulation results | Not configured | Future solver and predictive datasets. |

The app starts in Tampa Bay with all three infrastructure layers enabled. The public APIs are queried by intersecting map area, with up to 4,000 records per layer per request area. Broader areas produce a zoom-in message instead of silently truncating a dataset. Each successful source is cached separately in the workspace; failed updates retain previous records. Source and basemap attribution remain visible on both maps. The original gas URL's `limit=20000` is unsupported; the adapter uses the [documented paging and export mechanisms](https://help.opendatasoft.com/apis/ods-explore-v2/).

`public/data/workspace.json` contains the empty starting workspace and catalog, not a synthetic network. Browser storage migration removes the previously shipped fake network and retains separate imports. Local files enter through the file picker.

## Category coverage

The catalog includes all nine categories in `scope.md`: foundational geospatial, 3D/elevation, real-time sensors, time-series/history, infrastructure/operations, environment/climate, regulation/compliance, demographics/socio-economics, and predictive/simulation data. Coverage means a source definition exists; it does not mean every dataset or adapter is available.

## Reference application

`/Users/admin/git/di-app-athon` supplied the layout and rendering reference. Its `public/data/smartds.json` is a separate synthetic electric dataset with different geography, and its TECO scene uses its own backend and data environment. Neither is required or automatically imported by Geobound.

The first version preserves custody through source and dataset metadata. Remote integrations should normalize authorized source data through `DataProvider`, retain source identities and timestamps, and enforce access in the future backend. Do not put private endpoint credentials in the browser catalog.
