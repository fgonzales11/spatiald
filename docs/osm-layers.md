# Local OpenStreetMap layers

The local XML downloads in `data/map1.osm`–`data/map4.osm` provide six selectable layers alongside the public electric and gas infrastructure. Their coverage is part of South Tampa, from roughly 27.8737–27.9380° N and 82.5314–82.4747° W. The four download rectangles have gaps and overlap; they do not constitute complete regional coverage. The application starts over Tampa Bay and offers **Go to downloaded area** in the layer controls and Data Sources.

| Layer | Features | Initially visible |
|---|---:|---|
| Roads and paths | 5,225 | Yes |
| Buildings | 22,572 | No |
| Water and waterways | 113 | Yes |
| Land cover and parks | 1,660 | No |
| Places and amenities | 2,055 | No |
| OSM utility features | 577 | Yes |

Clicking a feature opens the inspector with original tags and a link to the OSM node, way, or relation. Utility asset selection takes precedence when both occupy the same screen location. Selection survives section navigation and map-mode switches; layer visibility survives reload. Disabled display layers are downloaded when enabled. The 3D transmission renderer also loads roads, water, buildings, and land cover for placement screening, independently of their display switches. Local-data failures leave the public infrastructure usable and expose a retry.

`scripts/convert-osm.py` uses Python's standard library to stream XML, merge identities by object type and ID, keep the newest version, resolve node references, and assemble multipolygon members by node identity. Reversed member ways, multiple outer rings, and holes are supported. Incomplete source geometry is omitted rather than joined across missing references. The current conversion reports three omitted relations with missing members; the coverage manifest includes their identities and reasons. Non-geographic route and restriction relations are not rendered. Individual complete member ways may remain visible when an incomplete relation cannot be reconstructed.

Classification uses source tags, with utilities taking precedence, then buildings, water, roads, land cover, and places. It never derives utility connections from proximity. All geometry retains WGS84 source coordinates. Untagged coordinate nodes are used for geometry resolution rather than displayed as features. Contributor account IDs and usernames are excluded from the derived files. Original exports remain unchanged.

Regenerate with `npm run generate:osm` after replacing the XML exports. The generated `public/data/osm/tampa-bay/manifest.json` includes source-file SHA-256 hashes, individual download bounds, duplicate counts, category counts, and geometry omissions. GeoJSON output and the manifest are deterministic for the same inputs. Existing generated files can be served and built without Python.

MapLibre renders category-specific fills, lines, and points. The 3D view batches context into line segments and point buffers to limit draw calls. Polygon outlines are shown in 3D; these are not reconstructed buildings or terrain. Source height tags remain metadata. Unknown absolute elevation stays unknown, and illustrative display lifts never modify geometry.

These layers are independent of the canonical utility workspace. Their geometry is excluded from workspace JSON exports and is available separately as the generated GeoJSON files. The application displays **© OpenStreetMap contributors** and links to [OpenStreetMap copyright](https://www.openstreetmap.org/copyright); the converted datasets are available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). A conversion notice accompanies the distributed files.

## Transmission support screening

The 3D equipment renderer uses the cleaned POSTE 05 model at every interior turn of the ArcGIS transmission-line routes, evaluating multipart paths independently. It skips straight spans, endpoints, repeated vertices, and numerical direction noise. A support must fall inside a declared OSM download rectangle and a mapped land polygon, with clearance from road centers, building footprints, and water. Restricted mapped uses are excluded. Nearby offsets are tried in both directions beside the route; gaps and unknown land are omitted. This screening is limited to the downloaded coverage and source completeness. It is a visualization rule, not a surveyed or approved construction location. Supports retain their published line's selection identity and never create explicit network connections or source assets.
