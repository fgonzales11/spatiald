# SPATIAL D — version 28 source export

This export contains the source of the latest published SPATIAL D version, verified on October 15, 2026.

- Live application: https://gis.n2wm787gnp.chatgpt.site
- Published version: **28**
- Source commit: `c3d7627515a2a81851b7390d99936c5755bf3f6e`
- Project: `appgprj_6ace2007c0ac819197cdf22df484fecf`

All repository files are preserved from that commit. This guide and `EXPORT-MANIFEST.json` are the only additions. The manifest records the SHA-256 of every exported source file.

## Included

- Complete application source, dependency lockfile, tests, build scripts, and local server.
- 2D, Google photorealistic 3D, and TRON views.
- The latest pole-cluster suppression and padmount display offsets, steady line glow, atmosphere/clouds, and reversed right-drag controls.
- 4,137 available circuit models, their geometry, GIS references, and bundled simulation runtime, including WASM/Pyodide assets and equipment models. The catalog has 4,138 entries; the malformed source model remains marked unavailable.
- Existing documentation and data provenance. Browser-saved preferences and user imports are separate from this source export.

## Run locally

Use Node.js 20.19+ or 22.12+ with npm. From the extracted `SPATIAL-D-v28` directory:

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` to set your existing `GOOGLE_API_KEY`, then start the development server:

```sh
npm run dev -- --port 5178
```

Open http://127.0.0.1:5178/#spatial or http://127.0.0.1:5178/#simulation.

**Current 3D renderer:** version 28 uses Google's Photorealistic 3D Tiles through the **Map Tiles API**, rendered with Three.js. The native Maps JavaScript 3D implementation remains in the source as a fallback. Some older sections in `README.md` and comments in `.env.example` describe the earlier native renderer; this guide describes the current default. The existing Google key needs Map Tiles API access and permission for the local website origin. Keep appropriate website and API restrictions on this browser-visible map key.

No credentials are included. With no map key, use the 2D or TRON views. Internet access is needed for external basemaps, Google tiles, and public live data sources; circuit inputs and their GIS references are bundled locally.

## Build and serve

```sh
npm run build
node --env-file=.env.local server/start.js
```

Open http://127.0.0.1:5178. The server uses `HOST` and `PORT` if set. If `GOOGLE_API_KEY` is already exported in the shell, `npm start` also works after building.

Leave `SPATIAL_D_OBJECT_STORAGE` unset for a local build. This keeps simulation files in `dist/client/simulation/`, so the local application does not depend on the published site's R2 bucket. The original Sites hosting configuration and Worker source are retained for deployment reference; transferring cloud hosting or its credentials is a separate operation.

The optional Python analysis service is described in `docs/analysis.md`; it is separate from the browser circuit simulator and the map.

## Checks

```sh
npm test
```

The published version passed 121 unit tests and browser checks before publication. This export was checked against the published source commit, its catalog references, and ZIP integrity. Installed dependencies, generated build output, Git history, local environment files, original DuckDB/PKL databases, and runtime caches are excluded.
