import { esc, icon, pretty } from "./ui.js";

export function renderOsmLayers(state) {
  const manifest = state.osmManifest;
  return `<button class="layers-heading osm-heading" data-action="toggle-osm" aria-expanded="${state.osmOpen}" aria-controls="osm-layer-list">${icon("layers")}<strong>Local OSM layers</strong><span>${manifest ? `${manifest.layers.filter((layer) => state.osmLayers[layer.id]).length}/${manifest.layers.length}` : "…"}</span>${icon("chevron")}</button><div id="osm-layer-list" class="context-layer-list" ${state.osmOpen ? "" : "hidden"}>
    ${manifest ? manifest.layers.map((layer) => `<div><label><input type="checkbox" data-osm-layer="${esc(layer.id)}" ${state.osmLayers[layer.id] ? "checked" : ""}><i class="layer-swatch ${["roads", "utilities"].includes(layer.id) ? "line" : ""}" style="--layer-color:${esc(layer.color)}"></i><span>${esc(layer.name)}</span><small>${layer.count.toLocaleString()}</small></label>${state.osmStatus[layer.id] ? `<p class="public-layer-status">${esc(state.osmStatus[layer.id])}${state.osmStatus[layer.id] !== "Loading…" ? ` <button class="text-button" data-osm-retry="${esc(layer.id)}">Retry</button>` : ""}</p>` : ""}</div>`).join("") : `<p class="small muted">${esc(state.osmError || "Loading local OSM catalog…")}</p>${state.osmError ? '<button class="text-button" data-action="retry-osm">Retry local data</button>' : ""}`}
    ${manifest ? `<p class="layer-foot">Four local exports · South Tampa coverage. Utility tags describe mapped features; connectivity and operational state are unavailable.</p>${Object.values(manifest.omissions).some(Boolean) ? `<p class="layer-foot">${Object.values(manifest.omissions).reduce((a, b) => a + b, 0)} incomplete source geometries omitted.</p>` : ""}<button class="text-button" data-action="focus-osm">${icon("target")} Go to downloaded area</button>` : ""}
  </div>`;
}

export function renderOsmInspector(feature) {
  const p = feature.properties;
  return `<div class="inspector-heading"><div><div class="eyebrow">OpenStreetMap · ${esc(pretty(p.group))}</div><h2>${esc(p.name)}</h2></div><button class="icon-button" data-action="clear-selection" aria-label="Close map feature inspector">${icon("close")}</button></div><div class="inspector-body"><div class="asset-status"><span class="badge">Local OSM feature</span></div><p class="small muted">Community mapped context. Utility topology, ownership verification, and operating state are not supplied.</p><dl class="detail-list"><dt>OSM identity</dt><dd class="mono">${esc(p.osmType)}/${esc(p.osmId)}</dd><dt>Version</dt><dd>${esc(p.version)}</dd><dt>Last source edit</dt><dd>${esc(p.timestamp || "Not supplied")}</dd><dt>Source files</dt><dd>${esc(p.sourceFiles.join(", "))}</dd><dt>Geometry</dt><dd>${esc(feature.geometry.type)} · WGS84</dd></dl><section class="inspector-section"><h3>OSM tags</h3><dl class="detail-list">${Object.entries(
    p.tags,
  )
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`)
    .join(
      "",
    )}</dl></section><section class="inspector-section provenance"><h3>Source provenance</h3><p>© OpenStreetMap contributors</p><a class="text-button" href="https://www.openstreetmap.org/${esc(p.osmType)}/${esc(p.osmId)}" target="_blank" rel="noopener noreferrer">Open OSM feature ${icon("arrow")}</a><p class="small muted">Downloaded XML snapshot · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">ODbL 1.0</a></p></section></div>`;
}

export function renderOsmSource(state) {
  const m = state.osmManifest;
  if (!m) return "";
  return `<section class="panel osm-source"><div class="panel-title">${icon("layers")}<h2>Local OpenStreetMap layers</h2><span>${m.featureCount.toLocaleString()} features</span></div><p>${esc(m.name)} · ${m.files.length} downloaded XML exports</p><p class="small muted">${m.layers.map((layer) => `${layer.count.toLocaleString()} ${layer.name.toLowerCase()}`).join(" · ")}</p><p class="small muted">Overlapping records are deduplicated by OSM type and ID, keeping the newest source version. These selectable map layers are independent of workspace assets and exports.</p><button class="secondary" data-action="focus-osm">${icon("target")} Go to downloaded area</button> <a class="text-button" href="${import.meta.env.BASE_URL}data/osm/tampa-bay/manifest.json" target="_blank" rel="noopener noreferrer">Coverage and conversion report ${icon("arrow")}</a></section>`;
}

export function appendOsmAttribution(host) {
  let element;
  return {
    update(visible) {
      if (visible && !element) {
        element = document.createElement("div");
        element.className = "osm-attribution";
        element.innerHTML =
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">Local overlays © OpenStreetMap contributors · ODbL</a>';
        host.append(element);
      } else if (!visible && element) {
        element.remove();
        element = null;
      }
    },
    dispose() {
      element?.remove();
    },
  };
}
