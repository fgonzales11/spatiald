import { assetNetworks, connectedAssets } from "../domain/model.js";
import { CATEGORIES, TYPE_LABELS } from "../domain/types.js";
import { esc, icon, pretty, badge, dateLabel, trendSVG, workspaceLabel } from "./ui.js";
import { renderInspector } from "./inspector.js";
import { renderOsmSource } from "./osm-layers.js";
import { PUBLIC_WORKSPACE_ID } from "../data/public-layers.js";

export function filteredAssets(state) {
  const { bundle, filters } = state;
  const q = filters.query.toLowerCase();
  const memberships = new Set(
    bundle.networkMemberships
      .filter((m) => m.networkId === filters.network)
      .map((m) => m.assetId),
  );
  return bundle.assets.filter(
    (a) =>
      (!q || `${a.name} ${a.id} ${a.externalId}`.toLowerCase().includes(q)) &&
      (!filters.type || a.assetType === filters.type) &&
      (!filters.network || memberships.has(a.id)),
  );
}

export function renderAssets(state) {
  const { bundle, filters, selectedId } = state;
  const assets = filteredAssets(state);
  const pageSize = 100;
  const page = Math.min(
    state.assetPage || 0,
    Math.max(0, Math.ceil(assets.length / pageSize) - 1),
  );
  const selected = bundle.assets.find((a) => a.id === selectedId);
  const types = [...new Set(bundle.assets.map((a) => a.assetType))];
  return `<div class="page-heading"><div><div class="eyebrow">Your network, in context</div><h1>Asset inventory</h1><p>Explore equipment, connections, and the data behind every asset.</p></div><button class="secondary" data-action="export">${icon("download")} Export workspace</button></div>
    <div class="metric-grid"><article><span>Total assets</span><strong>${bundle.assets.length}</strong><small>${bundle.datasets.length} dataset${bundle.datasets.length === 1 ? "" : "s"}</small></article><article><span>Networks</span><strong>${bundle.networks.length}</strong><small>${
      bundle.networks
        .map((n) => n.utilityType)
        .filter((v, i, a) => a.indexOf(v) === i)
        .map(pretty)
        .join(" · ") || "Unassigned"
    }</small></article><article><span>Recorded connections</span><strong>${bundle.terminals.filter((t) => t.nodeId).length}</strong><small>Explicit terminals</small></article><article>${bundle.workspace.id === PUBLIC_WORKSPACE_ID ? `<span>Telemetry</span><strong>—</strong><small>Not supplied by these sources</small>` : `<span>Needs attention</span><strong class="amber">${bundle.assets.filter((a) => a.status === "attention").length}</strong><small>Supplied asset state</small>`}</article></div>
    <div class="inventory-layout ${selected ? "has-selection" : ""}"><section class="panel inventory-panel"><div class="filter-row"><label class="search-field">${icon("search")}<input id="asset-query" aria-label="Filter asset inventory" placeholder="Search name or asset ID" value="${esc(filters.query)}"></label><select id="asset-type" aria-label="Filter asset type"><option value="">All asset types</option>${types.map((t) => `<option value="${esc(t)}" ${filters.type === t ? "selected" : ""}>${esc(TYPE_LABELS[t] || pretty(t))}</option>`).join("")}</select><select id="asset-network" aria-label="Filter network"><option value="">All networks</option>${bundle.networks.map((n) => `<option value="${esc(n.id)}" ${filters.network === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></div><div class="table-caption"><span>${assets.length} assets</span><span>WGS84 · ${bundle.datasets.every((d) => d.isSynthetic) ? "Synthetic workspace" : "Source-linked records"}</span></div>
    <div class="table-scroll"><table><thead><tr><th>Asset</th><th>Type</th><th>Network</th><th>${bundle.workspace.id === PUBLIC_WORKSPACE_ID ? "Published status" : "State"}</th><th>Connectivity</th><th></th></tr></thead><tbody>${
      assets
        .slice(page * pageSize, (page + 1) * pageSize)
        .map(
          (a) =>
            `<tr class="${a.id === selectedId ? "selected" : ""}"><td><button class="asset-link" data-select="${esc(a.id)}"><span class="asset-symbol ${esc(a.assetType)}">${icon(a.assetType.includes("line") || a.assetType.includes("cable") ? "network" : "bolt")}</span><span><b>${esc(a.name)}</b><small class="mono">${esc(a.id)}</small></span></button></td><td>${esc(pretty(a.assetType))}</td><td>${
              assetNetworks(bundle, a.id)
                .map((n) => esc(n.name))
                .join("<br>") || "Unassigned"
            }</td><td>${badge(pretty(a.attributes.publishedStatus || a.status), a.status)}</td><td>${bundle.terminals.some((t) => t.assetId === a.id && t.nodeId) ? `${connectedAssets(bundle, a.id).length} adjacent` : "Unavailable"}</td><td><button class="icon-button" data-focus="${esc(a.id)}" aria-label="Locate ${esc(a.name)} on map">${icon("pin")}</button></td></tr>`,
        )
        .join("") ||
      '<tr><td colspan="6" class="empty">No assets match these filters.</td></tr>'
    }</tbody></table></div>${assets.length > pageSize ? `<div class="inventory-pagination"><span>Page ${page + 1} of ${Math.ceil(assets.length / pageSize)} · ${assets.length} assets</span><button class="secondary" data-action="inventory-previous" ${page ? "" : "disabled"}>Previous</button><button class="secondary" data-action="inventory-next" ${(page + 1) * pageSize >= assets.length ? "disabled" : ""}>Next</button></div>` : ""}</section>
    ${selected ? `<aside class="panel inventory-inspector">${renderInspector(bundle, selected, { section: "assets" })}</aside>` : ""}</div>`;
}

export function renderMeasurements(state) {
  const { bundle, selectedId } = state;
  const measured = bundle.assets.filter((a) =>
    bundle.series.some((s) => s.assetId === a.id),
  );
  const selected = bundle.assets.find((a) => a.id === selectedId);
  const series = bundle.series.filter((s) => s.assetId === selectedId);
  const active = series.find((s) => s.id === state.seriesId) || series[0];
  const obs = active
    ? bundle.observations
        .filter((o) => o.seriesId === active.id)
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    : [];
  const numeric = obs.filter((o) => o.value !== null);
  const average = numeric.length
    ? numeric.reduce((s, o) => s + o.value, 0) / numeric.length
    : null;
  return `<div class="page-heading"><div><div class="eyebrow">A historical view</div><h1>Measurements</h1><p>Explore asset measurements with their original units and data quality.</p></div>${badge(bundle.series.length ? "Historical data" : "Not supplied", bundle.series.length ? "demo" : "")}</div>
    <div class="measure-layout"><aside class="panel measured-assets"><div class="panel-title">${icon("bolt")}<h2>Measured assets</h2><span>${measured.length}</span></div>${
      measured
        .map(
          (a) =>
            `<button class="measurement-asset ${a.id === selectedId ? "active" : ""}" data-select="${esc(a.id)}"><span>${esc(a.name)}<small>${
              assetNetworks(bundle, a.id)
                .map((n) => esc(n.name))
                .join(" · ") || "Unassigned"
            }</small></span>${icon("chevron")}</button>`,
        )
        .join("") ||
      '<p class="empty small">Import observation CSV to add measurement series.</p>'
    }</aside><section>
      ${
        !active
          ? `<div class="panel empty">${icon("chart")}<h2>${selected ? `No measurements for ${esc(selected.name)}` : "Select a measured asset"}</h2><p>Choose an asset from the list, or import its historical observations.</p></div>`
          : `<div class="panel"><div class="chart-heading"><div><div class="eyebrow">${esc(selected?.name)}</div><h2>${esc(active.quantity)}</h2><p class="small muted">${dateLabel(obs[0]?.observedAt, bundle.workspace.timezone)} – ${dateLabel(obs.at(-1)?.observedAt, bundle.workspace.timezone)}</p></div><select id="measurement-series" aria-label="Measurement series">${series.map((s) => `<option value="${esc(s.id)}" ${s.id === active.id ? "selected" : ""}>${esc(s.quantity)} (${esc(s.unit)})${s.phase ? ` · ${esc(s.phase)}` : ""}</option>`).join("")}</select></div><div class="chart-metrics"><div><small>Average</small><b>${average === null ? "—" : average.toFixed(2)} <span>${esc(active.unit)}</span></b></div><div><small>Phase</small><b>${esc(active.phase || "—")}</b></div><div><small>Observations</small><b>${obs.length}</b></div><div><small>Missing values</small><b class="${obs.some((o) => o.value === null) ? "amber" : ""}">${obs.filter((o) => o.value === null).length}</b></div></div><div class="chart-wrap">${trendSVG(obs, active, bundle.workspace.timezone)}</div><div class="chart-foot"><span><i class="legend-line"></i>${esc(active.quantity)} · ${esc(active.unit)}</span><span>Gaps indicate missing data · ${esc(bundle.workspace.timezone)}</span></div></div>
      <section class="panel observations"><div class="panel-title">${icon("clock")}<h2>Observation records</h2><span>Latest ${Math.min(obs.length, 24)}</span></div><div class="table-scroll"><table><thead><tr><th>Time (${esc(bundle.workspace.timezone)})</th><th>Value</th><th>Quality</th><th>Dataset</th></tr></thead><tbody>${obs
        .slice(-24)
        .reverse()
        .map(
          (o) =>
            `<tr><td>${dateLabel(o.observedAt, bundle.workspace.timezone)}</td><td>${o.value === null ? "—" : `${o.value} ${esc(active.unit)}`}</td><td>${badge(o.quality, o.quality === "missing" ? "warning" : "")}</td><td>${esc(bundle.datasets.find((d) => d.id === o.datasetId)?.name || o.datasetId)}</td></tr>`,
        )
        .join("")}</tbody></table></div></section>`
      }
    </section></div>`;
}

export function renderSources(state) {
  const { bundle, preview, sourceCategory, busy } = state;
  const sources = bundle.sources.filter(
    (s) => !sourceCategory || s.categories.includes(sourceCategory),
  );
  const implemented = bundle.sources.filter(
    (s) => s.adapterStatus === "implemented",
  ).length;
  return `<div class="page-heading"><div><div class="eyebrow">Know where your data comes from</div><h1>Data sources</h1><p>Discover sources, inspect provenance, and bring your own data into the workspace.</p></div><div>${bundle.workspace.id === PUBLIC_WORKSPACE_ID ? `<button class="secondary" data-action="refresh-public">${icon("source")} Refresh public layers</button> ` : ""}<button class="secondary" data-action="export">${icon("download")} Export workspace</button></div></div>
    <div class="sources-layout"><div><section class="panel"><div class="panel-title">${icon("layers")}<h2>Workspace datasets</h2><span>${bundle.datasets.length}</span></div><div class="dataset-list">${bundle.datasets.map((d) => `<article class="dataset"><div class="dataset-icon">${icon(d.isRemote ? "source" : d.isSynthetic ? "bolt" : "upload")}</div><div><h3>${esc(d.name)}</h3><p>${bundle.assets.filter((a) => a.datasetId === d.id).length} assets · ${d.isRemote ? `Source metadata ${esc(d.sourceUpdatedAt?.slice(0, 10) || "date not supplied")}` : `${bundle.observations.filter((o) => o.datasetId === d.id).length} observations · v${esc(d.version)}`}</p><small>Fetched ${dateLabel(d.acquiredAt, bundle.workspace.timezone)} · ${esc(d.crs)}</small></div><div class="dataset-actions">${badge(d.isRemote ? "Public source" : d.isSynthetic ? "Synthetic" : "Imported", d.isSynthetic ? "demo" : "")}<button class="text-button danger" data-remove-dataset="${esc(d.id)}" ${busy ? "disabled" : ""}>${d.isRemote && bundle.workspace.id === PUBLIC_WORKSPACE_ID ? "Hide layer" : "Remove"}</button></div></article>`).join("") || '<p class="empty small">No datasets loaded. Refresh public layers or import assets.</p>'}</div></section>
    ${renderOsmSource(state)}
    <div class="catalog-heading"><div><h2>Source catalog</h2><p class="small muted">${implemented} implemented adapters · remaining sources are catalog entries or future integrations</p></div><select id="source-category" aria-label="Filter source category"><option value="">All data categories</option>${CATEGORIES.map((c) => `<option ${sourceCategory === c ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("")}</select></div>
    <div class="source-grid">${sources
      .map((s) => {
        const configured = s.id === "google-3d" && state.googleConfigured;
        const label =
          s.adapterStatus !== "implemented"
            ? s.configurationState === "requires_configuration"
              ? "Unconfigured"
              : "Catalog only"
            : s.id === "google-3d"
              ? configured
                ? "Configured"
                : "Key required"
              : s.configurationState === "bundled"
                ? s.id === "osm-tampa-bay"
                  ? "Local layers"
                  : "Bundled demo"
                : "Implemented";
        const status = state.publicLayerState?.[s.id];
        return `<article class="panel source-card"><div class="source-top"><span class="source-mark">${icon(s.id === "google-3d" || s.id === "openfreemap" ? "globe" : "source")}</span>${badge(label, label === "Implemented" || label === "Configured" ? "normal" : label === "Key required" ? "warning" : "")}</div><h3>${esc(s.name)}</h3><p>${esc(s.description || "")}</p>${status ? `<p class="small ${status.status === "error" ? "amber" : "muted"}">${status.status === "ready" ? `${status.count} records loaded for the map area${status.rejected ? `; ${status.rejected} invalid records omitted` : ""}` : status.status === "loading" ? "Loading map area…" : esc(status.error || "")}</p>${status.status === "error" ? `<button class="text-button" data-refresh-layer="${esc(s.id)}">Retry layer</button>` : ""}` : ""}<div class="source-tags">${s.categories.map((c) => `<span>${esc(c.replace(" Data", ""))}</span>`).join("")}</div><dl><dt>Custodian</dt><dd>${esc(s.custodian)}</dd><dt>Format</dt><dd>${esc(s.format)}</dd><dt>Location</dt><dd>${s.location ? (/^https:\/\//.test(s.location) ? `<a href="${esc(s.location)}" target="_blank" rel="noopener noreferrer" class="source-location">${esc(s.location)}</a>` : `<span class="mono source-location">${esc(s.location)}</span>`) : '<span class="muted">Not configured</span>'}</dd></dl>${s.licenseUrl && /^https:\/\//.test(s.licenseUrl) ? `<a class="text-button" href="${esc(s.licenseUrl)}" target="_blank" rel="noopener noreferrer">Provider / license reference ${icon("arrow")}</a>` : ""}</article>`;
      })
      .join("")}</div></div>
    <aside class="panel import-panel"><div class="panel-title">${icon("upload")}<h2>Import data</h2></div><div class="import-body"><p>Add assets and observations, or open an exported workspace.</p><label class="upload-zone">${icon("upload")}<strong>Choose a data file</strong><span>GeoJSON, observation CSV, or workspace JSON</span><input id="import-file" type="file" accept=".json,.geojson,.csv,application/json,text/csv" ${busy ? "disabled" : ""}></label><p class="small muted">Up to 20 MB. Files stay in this browser.</p><div class="template-links"><a href="${import.meta.env.BASE_URL}templates/assets.geojson" download>Asset GeoJSON template ${icon("download")}</a><a href="${import.meta.env.BASE_URL}templates/observations.csv" download>Observation CSV template ${icon("download")}</a></div>
      ${
        preview
          ? `<div class="import-preview" aria-live="polite"><div class="eyebrow">Import preview</div><h3>${esc(preview.filename)}</h3><p class="small muted">${esc(preview.kind)}</p>${
              preview.errors.length
                ? `<div class="validation-errors"><strong>${preview.errors.length} validation error${preview.errors.length === 1 ? "" : "s"}</strong><ul>${preview.errors
                    .slice(0, 20)
                    .map((e) => `<li>${esc(e)}</li>`)
                    .join("")}</ul></div>`
                : `<dl class="detail-list"><dt>Assets to add</dt><dd>${preview.summary.assets}</dd><dt>Observations</dt><dd>${preview.summary.observations}</dd><dt>Bounds</dt><dd class="mono">${preview.summary.bounds?.map((v) => v.toFixed(4)).join(", ") || "—"}</dd><dt>Destination</dt><dd>${preview.newWorkspace ? "New browser workspace" : "Current workspace"}</dd></dl>`
            }<button class="primary full" data-action="commit-import" ${preview.errors.length || busy ? "disabled" : ""}>${icon("check")} ${busy ? "Saving…" : "Confirm import"}</button><button class="text-button" data-action="cancel-import">Clear preview</button></div>`
          : ""
      }
      <div class="import-note">${icon("info")}<p>Imports are validated before saving. Asset geometry alone does not establish network connectivity.</p></div>
    </div></aside></div>`;
}

export function renderSettings(state) {
  return `<div class="page-heading"><div><div class="eyebrow">Make this workspace yours</div><h1>Workspace settings</h1><p>Configure your view and manage the data stored in this browser.</p></div></div>
  <div class="settings-grid"><section class="panel settings-panel"><h2>Appearance</h2><label class="setting"><span><b>Theme</b><small>Applied across the application</small></span><select id="theme-select" aria-label="Theme"><option value="dark" ${state.theme === "dark" ? "selected" : ""}>Dark</option><option value="light" ${state.theme === "light" ? "selected" : ""}>Light</option></select></label><label class="setting"><span><b>Default map view</b><small>3D opens in 2D if map access is unavailable</small></span><select id="default-map" aria-label="Default map view"><option value="3d" ${state.defaultMap === "3d" ? "selected" : ""}>3D preferred</option><option value="2d" ${state.defaultMap === "2d" ? "selected" : ""}>2D</option><option value="tron" ${state.defaultMap === "tron" ? "selected" : ""}>TRON neon</option></select></label></section>
  <section class="panel settings-panel"><h2>TRON view</h2><p class="small muted">Applies to the TRON map only. Changes are saved automatically in this browser. Power-flow results use steady line glow.</p>${[
    ['transit','Transit','Show rail, transit, and ferry routes'],
    ['buildings','3D buildings','Show extruded buildings and neon wireframes'],
    ['interactive','Interactive','Allow map pan, zoom, rotation, and tilt gestures'],
  ].map(([key,label,description])=>`<label class="setting"><span><b>${label}</b><small>${description}</small></span><input type="checkbox" class="tron-setting" data-tron-setting="${key}" aria-label="TRON ${label}" ${state.tronSettings?.[key]!==false?'checked':''}></label>`).join('')}</section>
  <section class="panel settings-panel"><h2>Map configuration</h2><div class="setting"><span><b>Google photorealistic 3D</b><small>Photorealistic basemap · depth-aware network glow</small></span>${badge(state.googleConfigured ? "Key configured" : "Key required", state.googleConfigured ? "normal" : "warning")}</div><p class="small muted">Set <code>GOOGLE_API_KEY</code> (or the existing <code>VITE_GOOGLE_MAPS_API_KEY</code>) in the Site’s runtime environment and reload this page. Use a website-referrer-restricted browser key with the Maps JavaScript and Map Tiles APIs enabled and billing active.</p><div class="setting"><span><b>OpenFreeMap 2D</b><small>Public vector basemap</small></span>${badge("Implemented", "normal")}</div><p class="small muted">Basemaps provide geographic context. No map content is included in workspace exports.</p></section>
  <section class="panel settings-panel"><h2>Workspace</h2><label class="setting"><span><b>Name</b><small>Saved with the workspace</small></span><input id="workspace-name" value="${esc(workspaceLabel(state.bundle.workspace))}" aria-label="Workspace name" maxlength="100"></label><label class="setting"><span><b>Display timezone</b><small>Timestamps remain stored in UTC</small></span><input id="workspace-timezone" value="${esc(state.bundle.workspace.timezone)}" aria-label="Workspace timezone"></label><button class="secondary" data-action="save-workspace" ${state.busy ? "disabled" : ""}>${icon("check")} Save workspace preferences</button></section>
  <section class="panel settings-panel"><h2>Browser storage</h2><p class="muted small">${state.storageAvailable ? "Workspaces, public source snapshots, and imports are stored in IndexedDB on this browser and origin." : "Browser storage is unavailable. Export the current workspace before closing."} Display preferences are saved locally.</p><div class="setting"><span><b>Export current workspace</b><small>Includes records, relationships, and source metadata</small></span><button class="secondary" data-action="export">${icon("download")} Export</button></div>${state.bundle.workspace.id === PUBLIC_WORKSPACE_ID ? `<div class="setting"><span><b>Default infrastructure layers</b><small>Enable all three public sources and refresh the map area</small></span><button class="secondary" data-action="restore-public-layers">Restore layers</button></div>` : ""}</section></div>`;
}
