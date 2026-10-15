# SCE simulation

Simulation in the left navigation opens a compact panel over the existing map.
The circuit selector lists all 4,138 source keys. Selecting an available key
activates Load network. Loading verifies both data files, renders one logical
network layer, and awaits the camera flight before enabling Run power flow.
Circuit changes cancel in-flight requests and terminate an old solve. Network
visibility is available in both the simulation panel and Map layers.

The catalog contains 4,137 usable models. CKT_1469_18727 is truncated in the
source repository and is visibly unavailable. No substitute network is used.

## Electrical execution

The numerical package and Pyodide dependency bundle are reused from
`di-app-athon/public/powerflow` and
`di-app-athon/teco_outage_analysis/browser/vendor`. The current-path sampler
comes from `di-app-athon/src/legacy/powerflow-display.js`.

A module worker runs the actual multiconductor correction-current-injection
power flow in Pyodide 0.28.3 WebAssembly, including the source controllers.
Voltage/angle tolerances default to 1e-5, maximum iterations to 100, and device
controls to enabled. The Python runtime rebuilds native DataFrames and their
phase/circuit/winding MultiIndices from data-only JSON. No pickle is executed
in the browser, and no cached solver state or saved results are used.

Convergence is the fresh `net.model.solved` value. Converged equipment glows
green; a nonconverged result turns active connections red. Inactive equipment
remains gray. Power-flow display is a steady, depth-aware conductor glow, with no moving particles, trails, or pulsing. Worker/bootstrap failures report an error and permit retry.

All numerical libraries are same-origin static resources. The model, display
geometry, solver archive and runtime are validated against SHA-256 hashes.
Compression decoding handles both raw gzip and browser-decoded gzip transport.

## GIS relationship and positions

The final numeric component of CIRCUIT_KEY joins to the zero-padded GIS circuit
number. Circuit numbers are unique in Distribution_Circuits. There are 4,116
links to that layer, 17 additional links through
cGIS_Distribution_Circuits_GG_Concat, and four models located from ICA node
anchors without a matching circuit route. Each model retains the GIS source
layer, object ID, circuit number and name in the catalog and geometry provenance.

GIS network is the default. Every route vertex comes from `Distribution_Circuits`,
with `cGIS_Distribution_Circuits_GG_Concat` supplying routes where that table has
no circuit row. All matching rows are retained. Exact circuit-number joins select
routes; normalized, unambiguous circuit names select OH/UG transformer points.
Poles_Devices uses exact structure IDs from model switches. The published
`simulation/geospatial/index.json` binds each exported GIS document by SHA-256.

No PKL coordinates, harmonic interpolation, spring layout, or invented bus
positions are used for rendering. The circuit's complete electrical model still
runs independently in WebAssembly. The reference route does not establish a
one-to-one correspondence with electrical line IDs: glow denotes circuit solve
status, not fabricated per-segment numerical results.

Four circuit numbers have no full reference route. For those, only actual ICA
sections with exact model node-ID matches are shown, and the panel labels the
GIS coverage as partial. Empty references fail explicitly instead of falling
back to schematic placement. No source PKLs or database records are modified.

The original per-layer CRS is transformed to WGS84. Conductor height, sag, and
intermediate pole spacing are illustrative along the recorded route. Equipment
positions and OH/UG mounting retain the source GIS records. Exact source route
matches use the cGIS OH/UG classification; unmatched routes disclose an
illustrative overhead display. The optional ground-route view uses the same GIS
vertices.

## Verification

- `npm test`: numerical-result grouping, map-layer lifecycle, gzip transport,
  integrity checks and existing application regression checks.
- `scripts/audit-simulation-assets.py`: every catalog model and geometry digest,
  source identities, table/index shapes, finite coordinates, GIS links and counts.
- `scripts/verify-simulation.mjs`: actual browser WASM convergence, an actual
  fresh nonconverged MaxIter=1 run, selection/load gating, stale-run cancellation,
  topology/visibility controls, unavailable source and mobile layout.
- `scripts/verify-simulation-3d.mjs`: actual Google photorealistic 3D, camera
  arrival before Run enables, recorded GIS routes, steady glow, restored atmosphere/clouds and reversed right-drag controls.

The scripts default to the local preview on port 5187. The 3D script also accepts
SIMULATION_ORIGIN to verify a published site. Browser verification uses Chrome.

## Schematic distribution geometry

`src/simulation/distribution-geometry.js` adapts chapter 2 of
`di-app-athon/rea/rea/story/vendor/network-browser/network_3d.js`: 15.1 m
terrain-relative conductors, 14.8 m wooden poles, 1.25 m phase spacing,
shared crossarm attachment frames and parabolic sag (at most 1.1 m).
Long sections receive illustrative supports at intervals of at most 55 m.
The small first-party GLBs are generated by `scripts/build-simulation-models.mjs`
using the existing di-app-athon GLB builder, with chapter 2 dimensions.

The SCE `line.type` column is generally blank. A blank value must not be treated
as underground. Explicit source type and cable standard labels (JCN, CLP, EPR,
PILC, CIC, UG) retain a ground trace; overhead conductor labels use elevated
wires. Other installation types use explicitly schematic overhead display.
Phase zero (neutral) is excluded from the one-wire-per-phase illustration.
Switch service follows connected buses; inference never crosses transformers.
Source oh_transformer/ug_transformer connectors select transformer mounting; otherwise mounting is inferred from primary-bus service for schematic display. Load-break switch models show open/closed blades and an open network connection has a visible gap. Transformer connection records do not generate extra switch models.
No inferred pole location, mounting or display height is supplied to the solver.

Three.js renders instanced poles, crossarms, insulators and transformer cans or cabinets over actual Google Photorealistic 3D Tiles. Fine wires and equipment are
bounded around the camera at street scale; the entire network retains elevated
centerlines at wider ranges. The dedicated HDR glow layer is occluded by scene depth and composed before tone mapping.
All equipment belongs to the same network visibility/lifecycle group.

## TRON view

The third map icon opens a MapLibre/deck.gl adaptation of
https://github.com/tangrams/tron-style (MIT, Mapzen 2013–2016). The map uses its
blue palette, cyan road glow, perspective buildings and luminous building edges
with current OpenFreeMap vector tiles. It requires no Nextzen credential.
The original 2D and Google photorealistic 3D modes remain available. Saved mode,
view center, network visibility, simulation results and user layers survive view
switching. TRON reuses the same raised conductor paths and equipment GLBs.
The full MIT notice is in public/TRON-LICENSE.txt.

## Hosted model storage

The 4,137 model pairs exceed the hosting archive input limit. The Sites build
uses SPATIAL_D_OBJECT_STORAGE=1 to stage integrity-checked files in the ignored
.simulation-upload directory and emit a versioned same-origin catalog. Model and
geometry objects live in the Site's R2 BUCKET; all other app assets are static.
Normal npm run build remains self-contained for local npm start and Docker use.
The import API is owner-secret protected, checks batch hashes and bounds, and
seals complete revisions against overwrite. The owner import secret is removed
from runtime configuration after uploading. Public clients can only read models.
The catalog is unavailable until the complete revision is sealed, so incomplete
uploads cannot present a partially available circuit list.

## Equipment placement filtering

A curve or a densely digitized line can have many GIS vertices within a few
meters. These vertices stay in the conductor path, but a connected group of
four or more generated supports within 6 m spacing produces no pole symbols.
The filter runs over the whole circuit before viewport detail limits, so zooming
or panning cannot reintroduce the same cluster. Recorded poles, switches and
pole-mounted transformers retain their GIS placement; nearby duplicate generated
supports are removed.

Pad-mounted transformer symbols keep their recorded point and ID and receive a
separate display position only when their footprint would overlap a pole.
Candidates maintain at least 4 m from every retained pole and pole-mounted
transformer, independent of the current viewport. Typical offsets are 4.25 m;
the bounded search suppresses a cabinet symbol if no clear location exists.
The same placement plan supplies Google 3D, TRON, and the native fallback.
