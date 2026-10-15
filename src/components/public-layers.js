import { PUBLIC_LAYERS } from "../data/public-layers.js";
import { TYPE_COLORS } from "../domain/types.js";
import { infrastructureLayerColor } from "../spatial/infrastructure-style.js";
import { esc, icon } from "./ui.js";
import { NATIONAL_TRANSMISSION_VIEWS } from "../data/national-transmission.js";

export function renderPublicLayers(state) {
  const importedTypes = [
    ...new Set(
      state.bundle.assets
        .filter(
          (asset) =>
            !PUBLIC_LAYERS.some((layer) => layer.id === asset.datasetId),
        )
        .map((asset) => asset.assetType),
    ),
  ].filter((type) => !PUBLIC_LAYERS.some((layer) => layer.assetType === type));
  return `<button class="layers-heading" data-action="toggle-layers" aria-expanded="${state.layersOpen}" aria-controls="layer-list">${icon("layers")}<strong>Infrastructure layers</strong><span>${PUBLIC_LAYERS.filter((layer) => state.layers[layer.assetType] !== false).length}/3</span>${icon("chevron")}</button><div id="layer-list" ${state.layersOpen ? "" : "hidden"}>
    ${PUBLIC_LAYERS.map((layer) => {
      const status = state.publicLayerState[layer.id];
      const count = state.bundle.assets.filter(
        (asset) => asset.datasetId === layer.id,
      ).length;
      const hidden = state.layers[layer.assetType] === false;
      const national = layer.assetType === "transmission_line" && state.nationalTransmission;
      const displayedCount = national?.featureCount || count;
      const message = hidden
        ? "Hidden"
        : status?.status === "loading"
          ? "Loading…"
          : status?.status === "overview"
            ? national ? "Nationwide tiles · zoom in for source details." : "Zoom in for local records."
          : status?.status === "error" || status?.status === "zoom"
            ? `${count ? "Cached records retained. " : ""}${status.error}`
            : status?.rejected
              ? `${status.rejected} records omitted: invalid source geometry`
              : "";
      return `<div class="public-layer-row"><label><input type="checkbox" data-layer="${layer.assetType}" ${hidden ? "" : "checked"}><i class="layer-swatch ${layer.assetType === "substation" ? "diamond" : "line"}" style="--layer-color:${infrastructureLayerColor(layer.assetType)}"></i><span>${esc(layer.name)}</span><small data-public-count="${layer.id}" title="${national ? "Nationwide source records" : "Loaded source records"}">${displayedCount.toLocaleString()}</small></label>${message ? `<p class="public-layer-status ${status?.status === "error" ? "amber" : ""}">${esc(message)}${!hidden && status?.status === "error" ? ` <button class="text-button" data-refresh-layer="${layer.id}">Retry</button>` : ""}</p>` : ""}</div>`;
    }).join("")}
    ${importedTypes.map((type) => `<label><input type="checkbox" data-layer="${esc(type)}" ${state.layers[type] === false ? "" : "checked"}><i class="layer-swatch" style="--layer-color:${TYPE_COLORS[type] || "#37c6ef"}"></i><span>${esc(type.replaceAll("_", " "))}</span><small>${state.bundle.assets.filter((asset) => asset.assetType === type).length}</small></label>`).join("")}
    ${state.nationalTransmission?.featureCount ? `<div class="national-views" aria-label="Transmission coverage views">${Object.entries(NATIONAL_TRANSMISSION_VIEWS).map(([id, view]) => `<button class="text-button" data-action="national-${id}">${id === "country" ? "View entire U.S." : esc(view.name)}</button>`).join("")}</div>` : ""}
    ${state.nationalTransmissionError ? `<p class="layer-foot amber">${esc(state.nationalTransmissionError)}</p>` : ""}
    <p class="layer-foot">Substations appear in views spanning 1,000 ft or less. Detailed records follow the map area. Published geometry does not establish connectivity.</p>${state.mapMode === "3d" ? `<p class="layer-foot">Google photorealistic terrain and buildings with source geometry overlays. Transmission routes without elevations use a 24 m above-ground display estimate.</p>` : ""}<button class="text-button" data-action="refresh-public">${icon("source")} Refresh map area</button>
  </div>`;
}

export function appendPublicAttribution(host, bundle) {
  const sources = bundle.sources.filter((source) =>
    PUBLIC_LAYERS.some((layer) => layer.id === source.id),
  );
  if (
    !sources.length ||
    (bundle.workspace.id !== "public-utility-infrastructure" &&
      !bundle.datasets.some((dataset) => dataset.isRemote))
  )
    return () => {};
  const attribution = document.createElement("div");
  attribution.className = "public-attribution";
  attribution.setAttribute("aria-label", "Infrastructure source attribution");
  attribution.innerHTML = sources
    .map(
      (source) =>
        `<a href="${esc(source.licenseUrl || source.location)}" target="_blank" rel="noopener noreferrer" title="${esc(source.attribution)}">${source.id === "public-substations" ? "Substations · ORNL/partners" : source.id === "public-transmission" ? "Transmission · US Govt/Esri" : "Gas · EIA/ORNL"}</a>`,
    )
    .join(" <span>·</span> ");
  host.append(attribution);
  return () => attribution.remove();
}
