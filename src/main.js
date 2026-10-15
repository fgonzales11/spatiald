import "./styles.css";
import { createSimulationController } from "./simulation/controller.js";
import { mountSimulationPanel } from "./simulation/panel.js";
import './analysis/workbench.css';
import { createAnalysisController } from './analysis/workbench.js';
import { googleMapsKey } from './data/runtime-config.js';
import { initialMapView } from './spatial/map-mode.js';
import { BUILTIN_BASEMAPS, emptyCatalog, MapCatalogRepository, mapSource, loadGeoJsonSource } from './data/dynamic-layers.js';
import { renderDynamicLayers, sourceDialog } from './components/dynamic-layers.js';
import { fetchBasemapStyle } from './spatial/basemaps.js';
import { createStore, readPreferences, savePreferences } from "./store.js";
import { BrowserDataProvider } from "./data/provider.js";
import {
  OsmLayerProvider,
  visibleOsmCount,
  selectedOsmFeature,
} from "./data/osm-layers.js";
import {
  renderOsmLayers,
  renderOsmInspector,
} from "./components/osm-layers.js";
import {
  PUBLIC_WORKSPACE_ID,
  PUBLIC_DATA_VERSION,
  PUBLIC_LAYERS,
  TAMPA_BOUNDS,
  TAMPA_CAMERA,
  PublicLayerProvider,
  AreaTooLargeError,
  containsBounds,
  paddedBounds,
  validBounds,
  mergePublicLayers,
} from "./data/public-layers.js";
import {
  renderPublicLayers,
} from "./components/public-layers.js";
import { fingerprint, previewImport } from "./data/imports.js";
import { assertBundle, connectedAssets, boundsOf } from "./domain/model.js";
import { TYPE_LABELS } from "./domain/types.js";
import { esc, icon, pretty, dateLabel, downloadText, workspaceLabel } from "./components/ui.js";
import { renderInspector } from "./components/inspector.js";
import { renderEnvironmentControls } from "./components/environment.js";
import { renderHighwayCameras } from "./components/highway-cameras.js";
import { renderSolarPvLayers } from "./components/solar-pv.js";
import { renderPklPvLayers } from "./components/pkl-pv.js";
import { infrastructureLayerColor } from "./spatial/infrastructure-style.js";
import { loadNationalTransmission, NATIONAL_TRANSMISSION_VERSION, NATIONAL_TRANSMISSION_VIEWS } from "./data/national-transmission.js";
import { tronPreferences } from "./spatial/tron-settings.js";
import { environmentPreferences } from "./spatial/environment-settings.js";
import {
  renderAssets,
  renderMeasurements,
  renderSources,
  renderSettings,
} from "./components/pages.js";

const titles = {
  spatial: "Spatial",
  simulation: "Simulation",
  assets: "Assets",
  measurements: "Measurements",
  analysis: 'Analysis',
  sources: "Data Sources",
  settings: "Settings",
};
const navIcons = {
  spatial: "globe",
  simulation: "bolt",
  assets: "assets",
  measurements: "chart",
  analysis: 'layers',
  sources: "source",
  settings: "settings",
};
const preferences = readPreferences();
let key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY?.trim() || "";
const provider = new BrowserDataProvider();
const publicProvider = new PublicLayerProvider();
const osmProvider = new OsmLayerProvider({ baseUrl: import.meta.env.BASE_URL });
const osmPending = new Set();
const mapCatalogRepository = new MapCatalogRepository();
let initialWorkspace,
  analysisController,
  simulationController,
  updateSimulationPanel,
  store,
  mapView = null,
  mapEpoch = 0,
  mapAbort,
  mapCamera = preferences.cameras || {},
  pendingFocus = null,
  mapWorkspace = null;
const scrollPositions = {};
let messageTimer;
let publicAbort,
  publicEpoch = 0,
  publicViewTimer,
  publicBounds = [...TAMPA_BOUNDS];
const $ = (selector) => document.querySelector(selector);
const sectionFromHash = () =>
  Object.hasOwn(titles, location.hash.slice(1))
    ? location.hash.slice(1)
    : "spatial";

function shell() {
  $("#app").innerHTML =
    `<div class="app-shell"><header class="topbar"><button class="icon-button mobile-menu" data-action="mobile-menu" aria-label="Open navigation">${icon("menu")}</button><a href="#spatial" class="brand" aria-label="SPATIAL D spatial workspace"><span class="brand-mark">${icon("layers")}</span><span>SPATIAL D<small>Spatial Digital Twin</small></span></a><span class="header-rule"></span><span id="section-name" class="section-name">Spatial</span><div class="header-right"><div class="global-search"><label>${icon("search")}<input id="global-search" placeholder="Search assets, feeders, meters…" aria-label="Search all assets" autocomplete="off" aria-controls="search-results" aria-expanded="false"></label><div id="search-results" class="search-results" hidden></div></div><select id="workspace-selector" aria-label="Active workspace"></select><span id="workspace-badge" class="badge demo">Demo</span><button class="icon-button" data-action="theme" aria-label="Switch theme" title="Switch theme">${icon("sun")}</button></div></header>
    <nav id="sidebar" class="sidebar" aria-label="Main navigation"><button class="sidebar-toggle" data-action="sidebar" aria-expanded="false" aria-controls="sidebar" aria-label="Expand sidebar">${icon("chevron")}</button><div class="nav-links">${Object.entries(
      titles,
    )
      .map(
        ([section, title]) =>
          `<a href="#${section}" data-nav="${section}" aria-label="${title}">${icon(navIcons[section])}<span class="nav-label">${title}</span><span class="nav-tooltip">${title}</span></a>`,
      )
      .join(
        "",
      )}</div><div class="rail-bottom"><span class="rail-dot" title="Browser workspace"></span><span class="nav-label">Local workspace</span></div></nav><button class="drawer-scrim" data-action="mobile-menu" aria-label="Close navigation" hidden></button>
    <main id="main"><section id="spatial-page" class="spatial-page" aria-label="Spatial workspace"><div id="map-host" class="map-host"></div><aside id="simulation-panel" class="simulation-panel floating-card" aria-label="Circuit simulation" hidden></aside><div id="map-empty" class="map-empty" hidden><div>${icon("globe")}<h2>Map view unavailable</h2><p>Your assets and measurement data are available in the inventory.</p><button class="primary" data-action="browse-assets">Browse assets</button><button class="secondary" data-action="retry-map">Retry map</button></div></div><div class="map-mode floating-card" role="group" aria-label="Map view"><button data-map-mode="2d" aria-label="Use 2D map" title="2D map" aria-pressed="false">${icon("map-flat")}</button><button data-map-mode="3d" aria-label="Use 3D map" title="3D map" aria-pressed="false">${icon("map-cube")}</button><button data-map-mode="tron" aria-label="Use TRON map" title="TRON neon map" aria-pressed="false">${icon("map-tron")}</button></div><div id="map-layers" class="map-layers floating-card" hidden></div><button id="map-layer-button" class="map-layer-button floating-card" data-action="toggle-map-layer-menu" aria-label="Map layers and basemaps" aria-controls="map-layers" aria-expanded="false" title="Map layers and basemaps">${icon("layers")}</button><div class="map-tools floating-card"><button data-zoom="1" aria-label="Zoom in">+</button><button data-zoom="-1" aria-label="Zoom out">−</button><button data-action="reset-map" aria-label="Reset map view">${icon("target")}</button></div><div id="map-notice" class="map-notice"></div><aside id="map-inspector" class="map-inspector floating-card" aria-label="Selected asset" hidden></aside><div class="map-scale-note">Utility overlays are illustrative · WGS84</div></section><section id="content-page" class="content-page" hidden></section></main>
    <footer class="statusbar" role="status" aria-label="Workspace status"><span class="status-primary"><i class="status-dot"></i><span id="status-source">Synthetic demonstration</span></span><span id="status-count"></span><span class="status-secondary" id="status-dataset"></span><span class="status-spacer"></span><span id="status-map"></span><span class="status-secondary mono" id="status-coordinates">WGS84 · EPSG:4326</span><span class="status-secondary" id="status-date"></span></footer></div><div id="toast" class="toast" role="alert" hidden></div><dialog id="confirm-dialog"><form method="dialog"><h2 id="confirm-title"></h2><p id="confirm-description"></p><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="confirm" class="primary danger" id="confirm-button">Confirm</button></div></form></dialog>${sourceDialog()}`;
}

function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    error ? 12000 : 5000,
  );
}
function confirmAction(title, description, label = "Confirm") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = description;
  $("#confirm-button").textContent = label;
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    );
    dialog.showModal();
  });
}
function persist() {
  const s = store.get();
  const saved = savePreferences({
    theme: s.theme,
    sidebarExpanded: s.sidebarExpanded,
    defaultMap: s.defaultMap,
    workspaceId: s.bundle.workspace.id,
    layers: s.layers,
    osmLayers: s.osmLayers,
    highwayCamerasVisible: s.highwayCamerasVisible,
    solarPvVisible: s.solarPvVisible,
    pklPvVisible: s.pklPvVisible,
    environment: s.environment,
    tronSettings: s.tronSettings,
    cameras: mapCamera,
    defaultDataVersion: PUBLIC_DATA_VERSION,
    nationalTransmissionVersion: s.nationalTransmission ? NATIONAL_TRANSMISSION_VERSION : preferences.nationalTransmissionVersion,
  });
  if (!saved && !s.preferenceWarning) {
    store.set({ preferenceWarning: true });
    notify(
      "Display preferences could not be saved. Browser storage may be full.",
      true,
    );
  }
}
function visibleAssets(s = store.get()) {
  return s.bundle.assets.filter((a) => s.layers[a.assetType] !== false);
}

function updateMap() {
  const s = store.get();
  mapView?.update({
    dynamicLayers: s.mapCatalog.layers,
    assets: visibleAssets(s),
    selectedId: s.selectedId,
    connectedIds: s.selectedId
      ? connectedAssets(s.bundle, s.selectedId).map((a) => a.id)
      : [],
    highwayCamerasVisible: s.highwayCamerasVisible,
    solarPvVisible: s.solarPvVisible,
    pklPvVisible: s.pklPvVisible,
    nationalTransmission: s.bundle.workspace.id === PUBLIC_WORKSPACE_ID ? s.nationalTransmission : null,
    transmissionVisible: s.layers.transmission_line !== false,
    context: {
      data: s.osmData,
      layers: s.osmLayers,
      manifest: s.osmManifest,
      selectedId: s.selectedOsmId,
    },
  });
}
function updateFooter() {
  const s = store.get(),
    b = s.bundle;
  $("#status-source").textContent =
    b.workspace.id === PUBLIC_WORKSPACE_ID
      ? "Published public sources"
      : b.datasets.length && b.datasets.every((d) => d.isSynthetic)
        ? "Synthetic demonstration"
        : "Browser workspace";
  $("#status-count").textContent =
    `${visibleAssets(s).length} displayed / ${b.assets.length} assets${b.workspace.id === PUBLIC_WORKSPACE_ID && s.mapMode !== "3d" && s.layers.transmission_line !== false && s.nationalTransmission?.featureCount ? ` · ${s.nationalTransmission.featureCount.toLocaleString()} nationwide lines` : ""}${visibleOsmCount(s) ? ` · ${visibleOsmCount(s).toLocaleString()} OSM` : ""}`;
  $("#status-dataset").textContent =
    b.datasets.length === 1
      ? b.datasets[0].name
      : `${b.datasets.length} datasets`;
  $("#status-map").textContent =
    ["3d", "tron"].includes(s.mapMode)
      ? s.mapStatus
      : s.mapStatus.includes("Loading")
        ? s.mapStatus
      : s.mapStatus.includes("unavailable")
        ? "2D · Context unavailable"
        : `2D · ${[...BUILTIN_BASEMAPS, ...s.mapCatalog.basemaps].find(b => b.id === s.mapCatalog.basemapId)?.name || "Basemap"}`;
  $("#status-date").textContent = b.datasets.length
    ? `${b.datasets.some((d) => d.isRemote) ? "Fetched" : "Data"}: ${dateLabel(
        b.datasets
          .map((d) => d.acquiredAt)
          .sort((a, b) => Date.parse(a) - Date.parse(b))
          .at(-1),
        b.workspace.timezone,
      )}`
    : "No dataset";
}
function mapPanelFocusSelector() {
  const active = document.activeElement;
  if (!active?.closest('#map-layers')) return null;
  if (active.id) return `#${CSS.escape(active.id)}`;
  const attribute = ['data-simulation-layer-toggle', 'data-layer', 'data-osm-layer', 'data-dynamic-layer', 'data-highway-cameras', 'data-solar-pv', 'data-pkl-pv', 'data-action', 'data-refresh-dynamic', 'data-remove-dynamic', 'data-focus-dynamic'].find(name => active.hasAttribute(name));
  return attribute ? `[${attribute}="${CSS.escape(active.getAttribute(attribute))}"]` : null;
}

function renderMapPanels() {
  const s = store.get(),
    b = s.bundle;
  const panel = $('#map-layers');
  const scrollTop = panel.scrollTop;
  const focusSelector = mapPanelFocusSelector();
  const types = [...new Set(b.assets.map((a) => a.assetType))];
  $("#map-layers").innerHTML =
    `<button class="layers-heading" data-action="toggle-layers" aria-expanded="${s.layersOpen}" aria-controls="layer-list">${icon("layers")}<strong>Network layers</strong><span>${types.filter((t) => s.layers[t] !== false).length}/${types.length}</span>${icon("chevron")}</button><div id="layer-list" ${s.layersOpen ? "" : "hidden"}>${types.map((t) => `<label><input type="checkbox" data-layer="${esc(t)}" ${s.layers[t] !== false ? "checked" : ""}><i style="--layer-color:${infrastructureLayerColor(t)}" class="layer-swatch ${t === "substation" ? "diamond" : t.includes("line") || t.includes("cable") ? "line" : ""}"></i><span>${esc(TYPE_LABELS[t] || pretty(t))}</span><small>${b.assets.filter((a) => a.assetType === t).length}</small></label>`).join("")}<p class="layer-foot">Selection highlights recorded adjacency.</p></div>`;
  if (b.workspace.id === PUBLIC_WORKSPACE_ID) {
    $("#map-layers").innerHTML = renderPublicLayers(s);
  }
  $(".map-scale-note").textContent =
    b.datasets.some((d) => d.isRemote) || b.workspace.id === PUBLIC_WORKSPACE_ID
      ? "Published WGS84 geometry · display heights illustrative"
      : "Utility overlays are illustrative · WGS84";
  $("#map-layers").insertAdjacentHTML("beforeend", renderOsmLayers(s));
  $("#map-layers").insertAdjacentHTML("beforeend", renderHighwayCameras(s));
  $("#map-layers").insertAdjacentHTML("beforeend", renderSolarPvLayers(s));
  $("#map-layers").insertAdjacentHTML("beforeend", renderPklPvLayers(s));
  $("#map-layers").insertAdjacentHTML(
    "beforeend",
    renderEnvironmentControls(s),
  );
  const content = $('#map-layers').innerHTML;
  $('#map-layers').innerHTML = `<div class="map-layer-menu-title"><strong>Map layers</strong><button class="icon-button" data-action="close-map-layer-menu" aria-label="Close map layers">${icon('close')}</button></div>${renderDynamicLayers(s)}${content}`;
  const simulationState = simulationController?.getState();
  if (simulationState?.geometry) $('#map-layers').insertAdjacentHTML('beforeend', `<div class="simulation-layer-entry"><strong>Simulation network</strong><label><input type="checkbox" data-simulation-layer-toggle ${simulationState.visible ? 'checked' : ''}><span>${esc(simulationState.loadedKey)}</span></label><small>Solver and GIS views share one layer.</small></div>`);
  $('#map-layers').hidden = !s.mapLayerMenuOpen;
  $('#map-layer-button').setAttribute('aria-expanded', String(s.mapLayerMenuOpen));
  if (focusSelector) panel.querySelector(focusSelector)?.focus({ preventScroll: true });
  panel.scrollTop = scrollTop;
  $('#spatial-page').classList.toggle('layers-menu-open', s.mapLayerMenuOpen);
  const selected = b.assets.find((a) => a.id === s.selectedId);
  const contextFeature = selectedOsmFeature(s);
  $("#map-inspector").hidden = !selected && !contextFeature;
  if (selected) $("#map-inspector").innerHTML = renderInspector(b, selected);
  else if (contextFeature)
    $("#map-inspector").innerHTML = renderOsmInspector(contextFeature);
  $("#spatial-page").classList.toggle(
    "has-selection",
    Boolean(selected || contextFeature),
  );
  for (const button of document.querySelectorAll('[data-map-mode]')) {
    const active = button.dataset.mapMode === s.mapMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const notice = $("#map-notice");
  notice.innerHTML = s.mapNotice
    ? `${icon("info")}<span>${esc(s.mapNotice)}</span><button class="text-button" data-action="${key ? "retry-3d" : "map-settings"}">${key ? "Retry 3D" : "Settings"}</button>`
    : "";
  notice.hidden = !s.mapNotice;
  mapView?.resize();
}

function renderPage() {
  const s = store.get();
  if (s.section === 'analysis') {
    analysisController?.mount($("#content-page"));
    return;
  }
  const active = document.activeElement;
  const focus = active?.id,
    selection = active?.selectionStart,
    end = active?.selectionEnd;
  const scroll = $("#content-page").scrollTop;
  if (!["spatial", "simulation"].includes(s.section))
    $("#content-page").innerHTML = {
      assets: renderAssets,
      measurements: renderMeasurements,
      sources: renderSources,
      settings: renderSettings,
    }[s.section](s);
  if (s.section === 'sources') $("#content-page").insertAdjacentHTML('beforeend', analysisController?.sourceStatusHTML() || '');
  $("#content-page").scrollTop = scroll;
  if (focus) {
    const next = document.getElementById(focus);
    next?.focus({ preventScroll: true });
    if (typeof next?.setSelectionRange === "function" && selection !== null) {
      try {
        next.setSelectionRange(selection, end);
      } catch {}
    }
  }
}

function renderState(s, previous) {
  document.documentElement.dataset.theme = s.theme;
  $(".app-shell").classList.toggle("expanded", s.sidebarExpanded);
  $(".app-shell").classList.toggle("drawer-open", s.drawerOpen);
  $(".drawer-scrim").hidden = !s.drawerOpen;
  const toggle = $(".sidebar-toggle");
  toggle.setAttribute("aria-expanded", String(s.sidebarExpanded));
  toggle.setAttribute(
    "aria-label",
    s.sidebarExpanded ? "Collapse sidebar" : "Expand sidebar",
  );
  const themeButton = $('[data-action="theme"]');
  themeButton.setAttribute(
    "aria-label",
    `Switch to ${s.theme === "dark" ? "light" : "dark"} theme`,
  );
  themeButton.innerHTML = icon(s.theme === "dark" ? "sun" : "moon");
  for (const link of document.querySelectorAll("[data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === s.section);
    if (link.dataset.nav === s.section)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  const spatial = ["spatial", "simulation"].includes(s.section);
  const publicWorkspace = s.bundle.workspace.id === PUBLIC_WORKSPACE_ID;
  const headerTitle = spatial
    ? (publicWorkspace ? "United States" : workspaceLabel(s.bundle.workspace))
    : titles[s.section];
  const headerSubtitle = publicWorkspace ? "Electric transmission & natural gas" : "Spatial workspace";
  $("#section-name").innerHTML = `<span>${esc(headerTitle)}</span>${spatial ? `<small>${esc(headerSubtitle)}</small>` : ""}`;
  document.title = `${titles[s.section]} · SPATIAL D`;
  $("#spatial-page").hidden = !spatial;
  $("#content-page").hidden = spatial;
  $("#simulation-panel").hidden = s.section !== "simulation";
  if (s.section === "simulation") void simulationController?.catalog().catch(() => {});
  $("#workspace-selector").innerHTML = s.workspaces
    .map(
      (w) =>
        `<option value="${esc(w.id)}" ${w.id === s.bundle.workspace.id ? "selected" : ""}>${esc(workspaceLabel(w))}</option>`,
    )
    .join("");
  $("#workspace-badge").textContent =
    s.bundle.workspace.id === PUBLIC_WORKSPACE_ID
      ? "Public"
      : s.bundle.datasets.length &&
          s.bundle.datasets.every((d) => d.isSynthetic)
        ? "Demo"
        : "Local";
  const pageChange = !previous || s.section !== previous.section;
  if (pageChange && previous?.section === 'analysis' && s.section !== 'analysis') analysisController?.leave();
  if (pageChange && !spatial) mapView?.closeCameraPopup?.();
  const domainChange = !previous || s.bundle !== previous.bundle;
  if (domainChange && !$("#search-results").hidden)
    search($("#global-search").value);
  const selectionChange =
    !previous ||
    s.selectedId !== previous.selectedId ||
    s.selectedOsmId !== previous.selectedOsmId;
  const osmChange =
    s.osmData !== previous?.osmData ||
    s.osmManifest !== previous?.osmManifest ||
    s.osmLayers !== previous?.osmLayers;
  if (
    pageChange ||
    domainChange ||
    selectionChange ||
    s.layers !== previous?.layers ||
    s.highwayCamerasVisible !== previous?.highwayCamerasVisible ||
    s.solarPvVisible !== previous?.solarPvVisible ||
    s.solarPvStatus !== previous?.solarPvStatus ||
    s.solarPvOpen !== previous?.solarPvOpen ||
    s.pklPvVisible !== previous?.pklPvVisible ||
    s.pklPvStatus !== previous?.pklPvStatus ||
    s.pklPvOpen !== previous?.pklPvOpen ||
    s.mapCatalog !== previous?.mapCatalog ||
    s.mapLayerMenuOpen !== previous?.mapLayerMenuOpen ||
    s.mapSourceBusy !== previous?.mapSourceBusy ||
    s.dynamicLayerErrors !== previous?.dynamicLayerErrors ||
    s.basemapError !== previous?.basemapError ||
    s.layersOpen !== previous?.layersOpen ||
    s.environment !== previous?.environment ||
    s.environmentOpen !== previous?.environmentOpen ||
    s.mapMode !== previous?.mapMode ||
    s.mapNotice !== previous?.mapNotice ||
    s.publicLayerState !== previous?.publicLayerState ||
    s.nationalTransmission !== previous?.nationalTransmission ||
    s.nationalTransmissionError !== previous?.nationalTransmissionError ||
    osmChange ||
    s.osmOpen !== previous?.osmOpen ||
    s.osmStatus !== previous?.osmStatus ||
    s.osmError !== previous?.osmError ||
    s.equipmentStatus !== previous?.equipmentStatus
  )
    renderMapPanels();
  if (
    pageChange ||
    domainChange ||
    selectionChange ||
    s.filters !== previous?.filters ||
    s.seriesId !== previous?.seriesId ||
    s.preview !== previous?.preview ||
    s.sourceCategory !== previous?.sourceCategory ||
    s.busy !== previous?.busy ||
    s.theme !== previous?.theme ||
    s.defaultMap !== previous?.defaultMap ||
    s.tronSettings !== previous?.tronSettings ||
    s.publicLayerState !== previous?.publicLayerState ||
    s.assetPage !== previous?.assetPage ||
    s.osmManifest !== previous?.osmManifest
  )
    renderPage();
  if (
    domainChange ||
    selectionChange ||
    s.layers !== previous?.layers ||
    osmChange ||
    s.highwayCamerasVisible !== previous?.highwayCamerasVisible ||
    s.solarPvVisible !== previous?.solarPvVisible ||
    s.pklPvVisible !== previous?.pklPvVisible ||
    s.nationalTransmission !== previous?.nationalTransmission ||
    s.mapCatalog !== previous?.mapCatalog
  )
    updateMap();
  if (s.mapCatalog.basemapId !== previous?.mapCatalog?.basemapId && mapView?.setBasemap)
    mapView.setBasemap(selectedBasemap(s));
  if (s.tronSettings !== previous?.tronSettings)
    mapView?.setTronSettings?.(s.tronSettings);
  if (s.environment !== previous?.environment)
    mapView?.setEnvironment?.(s.environment);
  updateFooter();
  if (["spatial", "simulation"].includes(s.section)) requestAnimationFrame(() => mapView?.resize());
}

async function loadOsm() {
  try {
    const manifest = await osmProvider.manifest();
    const layers = { ...store.get().osmLayers };
    for (const layer of manifest.layers)
      if (typeof layers[layer.id] !== "boolean")
        layers[layer.id] = layer.defaultVisible;
    store.set({ osmManifest: manifest, osmLayers: layers, osmError: "" });
    await Promise.allSettled(
      manifest.layers
        .filter((layer) => layers[layer.id])
        .map((layer) => loadOsmLayer(layer.id)),
    );
  } catch (error) {
    store.set({ osmError: error.message });
  }
}

async function loadOsmLayer(id) {
  if (osmPending.has(id) || store.get().osmData[id]) return;
  const layer = store
    .get()
    .osmManifest?.layers.find((layer) => layer.id === id);
  if (!layer) return;
  osmPending.add(id);
  store.set({ osmStatus: { ...store.get().osmStatus, [id]: "Loading…" } });
  try {
    const collection = await osmProvider.loadLayer(layer);
    store.set({
      osmData: { ...store.get().osmData, [id]: collection },
      osmStatus: { ...store.get().osmStatus, [id]: "" },
    });
  } catch (error) {
    store.set({ osmStatus: { ...store.get().osmStatus, [id]: error.message } });
  } finally {
    osmPending.delete(id);
  }
}

function selectOsm(id) {
  mapView?.closeCameraPopup?.();
  const next = { ...store.get(), selectedOsmId: id };
  if (!selectedOsmFeature(next)) return;
  store.set({ selectedOsmId: id, selectedId: null, seriesId: null });
}

function schedulePublicArea(view) {
  if (
    store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID ||
    !validBounds(view.bounds)
  )
    return;
  clearTimeout(publicViewTimer);
  publicViewTimer = setTimeout(() => void loadPublicArea(view.bounds), 700);
}

async function loadPublicArea(
  bounds = publicBounds,
  { force = false, sourceId } = {},
) {
  if (
    !store ||
    store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID ||
    !validBounds(bounds)
  )
    return;
  const state = store.get();
  publicBounds = [...bounds];
  // National browsing is served by static tiles. Regional API inventory is
  // deferred so country navigation never waits on tens of thousands of records.
  if (state.nationalTransmission && (bounds[2] - bounds[0] > 5 || bounds[3] - bounds[1] > 5)) {
    publicAbort?.abort();
    ++publicEpoch;
    store.set({ publicLayerState: Object.fromEntries(PUBLIC_LAYERS.map((layer) => [layer.id, { status: "overview" }])) });
    return;
  }
  const targets = PUBLIC_LAYERS.filter(
    (layer) =>
      (!sourceId || layer.id === sourceId) &&
      state.layers[layer.assetType] !== false &&
      (force ||
        !containsBounds(
          state.bundle.datasets.find((dataset) => dataset.id === layer.id)
            ?.queryBounds,
          bounds,
        ) ||
        state.publicLayerState[layer.id]?.status === "error"),
  );
  if (!targets.length) return;
  publicAbort?.abort();
  const controller = (publicAbort = new AbortController());
  const epoch = ++publicEpoch;
  publicBounds = [...bounds];
  const queryBounds = paddedBounds(bounds);
  const states = { ...state.publicLayerState };
  for (const layer of targets) states[layer.id] = { status: "loading" };
  store.set({ publicLayerState: states });
  const completed = await Promise.allSettled(
    targets.map((layer) =>
      publicProvider.loadLayer(layer, queryBounds, {
        signal: controller.signal,
      }),
    ),
  );
  if (
    controller.signal.aborted ||
    epoch !== publicEpoch ||
    store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID
  )
    return;
  const successful = [],
    nextStates = { ...store.get().publicLayerState };
  completed.forEach((result, index) => {
    const layer = targets[index];
    if (result.status === "fulfilled") {
      successful.push(result.value);
      nextStates[layer.id] = {
        status: "ready",
        count: result.value.assets.length,
        total: result.value.total,
        rejected: result.value.rejected.length,
      };
    } else
      nextStates[layer.id] = {
        status: result.reason instanceof AreaTooLargeError
          ? layer.assetType === "transmission_line" && state.nationalTransmission ? "overview" : "zoom"
          : "error",
        error:
          result.reason.message || "Source could not load. Retry this layer.",
      };
  });
  try {
    if (successful.length) {
      let candidate;
      for (let attempt = 0; attempt < 3; attempt++) {
        const base = provider.db
          ? await provider.loadWorkspace(PUBLIC_WORKSPACE_ID)
          : store.get().bundle;
        candidate = mergePublicLayers(base, successful, store.get().selectedId);
        if (!provider.db) break;
        try {
          await provider.write(candidate, { expected: fingerprint(base) });
          break;
        } catch (error) {
          if (error.message.includes("changed after preview") && attempt < 2)
            continue;
          notify(
            "Public layers loaded, but the browser cache could not be saved. Export the workspace before closing.",
            true,
          );
          break;
        }
      }
      if (
        epoch !== publicEpoch ||
        store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID
      )
        return;
      await setBundle(candidate);
    }
  } catch (error) {
    if (epoch !== publicEpoch) return;
    for (const result of successful)
      nextStates[result.layer.id] = {
        status: "error",
        error: `Source update could not be applied: ${error.message}`,
      };
  }
  store.set({ publicLayerState: nextStates });
}

let nationalSelectionEpoch = 0;
async function selectNationalTransmission(objectId) {
  const epoch = ++nationalSelectionEpoch;
  const layer = PUBLIC_LAYERS.find((source) => source.id === "public-transmission");
  const id = `${layer.id}:${objectId}`;
  const existing = store.get().bundle.assets.find((asset) => asset.id === id);
  if (existing) { selectAsset(id); return; }
  try {
    const asset = await publicProvider.loadAsset(layer, objectId);
    if (epoch !== nationalSelectionEpoch || store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID) return;
    let candidate;
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = provider.db ? await provider.loadWorkspace(PUBLIC_WORKSPACE_ID) : store.get().bundle;
      candidate = structuredClone(base);
      if (!candidate.datasets.some((dataset) => dataset.id === layer.id)) candidate.datasets.push({
        id: layer.id, workspaceId: PUBLIC_WORKSPACE_ID, sourceId: layer.id, name: layer.name,
        version: "published", acquiredAt: asset.attributes.sourceFetchedAt, isSynthetic: false,
        isRemote: true, bounds: boundsOf([asset]), crs: "EPSG:4326", schemaVersion: 1,
      });
      candidate.assets = [...candidate.assets.filter((item) => item.id !== id), asset];
      assertBundle(candidate);
      if (!provider.db) break;
      try { await provider.write(candidate, { expected: fingerprint(base) }); break; }
      catch (error) {
        if (error.message.includes("changed after preview") && attempt < 2) continue;
        throw error;
      }
    }
    if (epoch !== nationalSelectionEpoch || store.get().bundle.workspace.id !== PUBLIC_WORKSPACE_ID) return;
    await setBundle(candidate);
    selectAsset(id);
  } catch (error) { notify(`Transmission record could not open: ${error.message}`, true); }
}

async function showNationalTransmission(view = "country") {
  const preset = NATIONAL_TRANSMISSION_VIEWS[view];
  if (!preset) return;
  navigate("spatial");
  store.set({ layers: { ...store.get().layers, transmission_line: true } });
  if (store.get().mapMode === "3d") await mountMap("2d");
  mapView?.focusBounds?.(preset.bounds);
  persist();
}

function navigate(section) {
  if (location.hash !== `#${section}`) location.hash = section;
  else applySection();
}
function applySection() {
  const previous = store.get().section;
  scrollPositions[previous] = $("#content-page").scrollTop;
  if (previous === "spatial" && mapView)
    mapCamera[store.get().mapMode] = mapView.captureCamera();
  store.set({ section: sectionFromHash(), drawerOpen: false });
  $("#content-page").scrollTop = scrollPositions[store.get().section] || 0;
  persist();
}
function selectAsset(id, { focus = false, measure = false } = {}) {
  mapView?.closeCameraPopup?.();
  const s = store.get(),
    asset = s.bundle.assets.find((a) => a.id === id);
  if (!asset) return;
  store.set({
    selectedId: id,
    selectedOsmId: null,
    seriesId: null,
    layers: { ...s.layers, [asset.assetType]: true },
  });
  $("#search-results").hidden = true;
  $("#global-search").setAttribute("aria-expanded", "false");
  if (measure) navigate("measurements");
  if (focus) {
    navigate("spatial");
    if (mapView) mapView.focusAsset(asset);
    else pendingFocus = id;
  }
}

async function mountMap(mode) {
  const previousMode = store.get().mapMode;
  const previousCamera = mapView?.captureCamera();
  const epoch = ++mapEpoch;
  mapAbort?.abort();
  const abort = mapAbort = new AbortController();
  if (mapView) {
    mapCamera[store.get().mapMode] = mapView.captureCamera();
    mapView.dispose();
    mapView = null;
  }
  $("#map-host").replaceChildren();
  $("#map-empty").hidden = true;
  if (mode === "3d" && !key) {
    mode = "2d";
    store.set({
      mapNotice:
        "Photorealistic 3D needs a Google Maps JavaScript API key. Your network is available in 2D.",
    });
  }
  store.set({ mapMode: mode, mapStatus: `Loading ${mode.toUpperCase()} map…` });
  const s = store.get();
  mapWorkspace = s.bundle.workspace.id;
  try {
    const module = await (mode === "3d"
      ? import("./spatial/map3d.js")
      : import("./spatial/map2d.js"));
    if (epoch !== mapEpoch) return;
    const other = previousCamera || mapCamera[mode === "3d" ? "2d" : "3d"];
    const camera =
      (previousCamera && previousMode !== mode ? {center: previousCamera.center, zoom: previousCamera.zoom, bearing: previousCamera.bearing ?? previousCamera.heading, heading: previousCamera.heading ?? previousCamera.bearing, pitch: mapCamera[mode]?.pitch} : mapCamera[mode]) ||
      (other?.center ? { center: other.center, zoom: other.zoom } : null);
    const view = await module.createSpatialView({
      signal: abort.signal,
      host: $("#map-host"),
      bundle: s.bundle,
      apiKey: key,
      mode,
      environment: s.environment,
      tronSettings: s.tronSettings,
      camera,
      basemap: selectedBasemap(s),
      onBasemapError: (message) => {
        if (epoch === mapEpoch) store.set({ basemapError: message });
      },
      onDynamicLayerError: (id, message) => {
        if (epoch === mapEpoch && store.get().dynamicLayerErrors[id] !== message)
          store.set({ dynamicLayerErrors: { ...store.get().dynamicLayerErrors, [id]: message } });
      },
      onSelect: (id) => selectAsset(id),
      onSelectNational: selectNationalTransmission,
      onNationalError: (message) => {
        if (epoch === mapEpoch) store.set({ nationalTransmissionError: message });
      },
      onSolarPvStatus: (status) => {
        if (epoch === mapEpoch) store.set({ solarPvStatus: status });
      },
      onPklPvStatus: (status) => {
        if (epoch === mapEpoch) store.set({ pklPvStatus: status });
      },
      onSelectContext: selectOsm,
      onEquipmentStatus: (status) => {
        if (epoch === mapEpoch) store.set({ equipmentStatus: status });
      },
      onEquipmentError: (message) => {
        if (epoch === mapEpoch) notify(message, true);
      },
      onViewChange: (view) => {
        if (epoch === mapEpoch) schedulePublicArea(view);
      },
      onPointer: ({ longitude, latitude }) => {
        $("#status-coordinates").textContent =
          `${Math.abs(latitude).toFixed(5)}° ${latitude < 0 ? "S" : "N"} · ${Math.abs(longitude).toFixed(5)}° ${longitude < 0 ? "W" : "E"}`;
      },
      onStatus: (message) => {
        if (epoch === mapEpoch) store.set({ mapStatus: message });
      },
      onEnvironmentError: (message) => {
        if (epoch === mapEpoch) notify(message, true);
      },
      onFatal: (message) =>
        queueMicrotask(() => {
          if (epoch !== mapEpoch) return;
          if (mode === "3d") {
            store.set({ mapNotice: message });
            void mountMap("2d");
          } else {
            mapView?.dispose();
            mapView = null;
            $("#map-host").replaceChildren();
            $("#map-empty").hidden = false;
            store.set({ mapStatus: "Map unavailable", mapNotice: message });
          }
        }),
    });
    if (epoch !== mapEpoch) { view.dispose(); return; }
    mapView = view;
    updateMap();
    await mapView.setSimulation?.(simulationController?.getLayer());
    mapView.setEnvironment?.(store.get().environment);
    if (pendingFocus) {
      const a = s.bundle.assets.find((a) => a.id === pendingFocus);
      if (a) mapView.focusAsset(a);
      pendingFocus = null;
    }
  } catch (error) {
    if (epoch !== mapEpoch) return;
    if (mode === "3d") {
      store.set({
        mapNotice:
          error.message || "Google photorealistic 3D could not initialize. Retry 3D.",
      });
      await mountMap("2d");
    } else {
      $("#map-empty").hidden = false;
      store.set({
        mapStatus: "Map unavailable",
        mapNotice:
          "This device could not initialize the map. Browse the asset inventory, or retry the map.",
      });
    }
  }
}

async function setBundle(bundle, { newWorkspace = false } = {}) {
  const workspaces = await provider.listWorkspaces();
  const s = store.get(),
    same = bundle.workspace.id === s.bundle.workspace.id;
  store.set({
    bundle,
    workspaces,
    preview: null,
    selectedId:
      same && bundle.assets.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : null,
    seriesId: null,
    filters: same ? s.filters : { query: "", type: "", network: "" },
    storageAvailable: Boolean(provider.db),
  });
  if (!same || mapWorkspace !== bundle.workspace.id) {
    publicAbort?.abort();
    ++publicEpoch;
    clearTimeout(publicViewTimer);
    mapCamera = {};
    await mountMap(store.get().defaultMap);
  } else updateMap();
  persist();
  void analysisController?.captureIfActive(bundle);
  if (newWorkspace) notify("Workspace imported and saved in this browser.");
  if (!same && bundle.workspace.id === PUBLIC_WORKSPACE_ID)
    void loadPublicArea(TAMPA_BOUNDS);
}

function search(query) {
  const results = $("#search-results");
  const q = query.toLowerCase().trim();
  if (!q) {
    results.hidden = true;
    $("#global-search").setAttribute("aria-expanded", "false");
    return;
  }
  const assets = store
    .get()
    .bundle.assets.filter((a) =>
      `${a.name} ${a.id} ${a.externalId}`.toLowerCase().includes(q),
    )
    .slice(0, 8);
  results.innerHTML = assets.length
    ? assets
        .map(
          (a) =>
            `<button data-search-select="${esc(a.id)}"><span>${icon("pin")}</span><span><b>${esc(a.name)}</b><small>${esc(pretty(a.assetType))} · ${esc(a.id)}</small></span>${icon("arrow")}</button>`,
        )
        .join("")
    : "<p>No matching assets.</p>";
  results.hidden = false;
  $("#global-search").setAttribute("aria-expanded", "true");
}

async function handleAction(action) {
  const s = store.get();
  if (action === 'toggle-map-layer-menu' || action === 'close-map-layer-menu') {
    const open = action === 'toggle-map-layer-menu' && !s.mapLayerMenuOpen;
    store.set({ mapLayerMenuOpen: open });
    if (open) $('#basemap-selector')?.focus();
    else $('#map-layer-button').focus();
  } else if (action === 'add-layer' || action === 'add-basemap') openMapSource(action === 'add-basemap');
  else if (action === 'cancel-map-source') {
    if (!s.mapSourceBusy) $('#map-source-dialog').close();
  } else if (action === 'retry-basemap') {
    if (s.mapMode === '3d') await mountMap('2d');
    else mapView?.setBasemap?.(selectedBasemap(s));
  } else if (action === "sidebar") {
    store.set({ sidebarExpanded: !s.sidebarExpanded });
    persist();
    mapView?.resize();
  } else if (action === "mobile-menu") {
    store.set({ drawerOpen: !s.drawerOpen });
    if (!s.drawerOpen) $("#sidebar a").focus();
    else $(".mobile-menu").focus();
  } else if (action === "theme") {
    store.set({ theme: s.theme === "dark" ? "light" : "dark" });
    persist();
  } else if (action === "browse-assets") navigate("assets");
  else if (action === "clear-selection")
    store.set({ selectedId: null, selectedOsmId: null, seriesId: null });
  else if (action === "toggle-osm") store.set({ osmOpen: !s.osmOpen });
  else if (action === "toggle-solar-pv") store.set({ solarPvOpen: !s.solarPvOpen });
  else if (action === "toggle-pkl-pv") store.set({ pklPvOpen: !s.pklPvOpen });
  else if (action === "retry-pkl-pv") await mapView?.retryPklPv?.();
  else if (action === "view-pkl-pv" && s.pklPvStatus?.bounds) mapView?.focusBounds?.(s.pklPvStatus.bounds);
  else if (action === "retry-osm") await loadOsm();
  else if (action === "retry-solar-pv") await mapView?.retrySolarPv?.();
  else if (action === "view-solar-pv" && s.solarPvStatus?.bounds) mapView?.focusBounds?.(s.solarPvStatus.bounds);
  else if (action === "focus-osm" && s.osmManifest) {
    navigate("spatial");
    mapView?.focusBounds?.(s.osmManifest.bounds);
  } else if (action === "toggle-layers")
    store.set({ layersOpen: !s.layersOpen });
  else if (action === "toggle-environment")
    store.set({ environmentOpen: !s.environmentOpen });
  else if (action === "map-settings") navigate("settings");
  else if (action === "refresh-public")
    await loadPublicArea(publicBounds, { force: true });
  else if (action.startsWith("national-")) await showNationalTransmission(action.slice(9));
  else if (action === "inventory-next")
    store.set({ assetPage: s.assetPage + 1 });
  else if (action === "inventory-previous")
    store.set({ assetPage: Math.max(0, s.assetPage - 1) });
  else if (action === "restore-public-layers") {
    const layers = { ...s.layers };
    for (const layer of PUBLIC_LAYERS) layers[layer.assetType] = true;
    store.set({ layers });
    persist();
    await loadPublicArea(publicBounds, { force: true });
  } else if (action === "retry-map") await mountMap(s.defaultMap);
  else if (action === "retry-3d") {
    key = await googleMapsKey(key);
    store.set({ mapNotice: "", googleConfigured: Boolean(key) });
    await mountMap("3d");
  } else if (action === "reset-map") mapView?.reset();
  else if (action === "cancel-import") store.set({ preview: null });
  else if (action === "export") {
    downloadText(
      `${s.bundle.workspace.id}.json`,
      JSON.stringify(s.bundle, null, 2),
    );
    notify("Workspace exported. Map imagery and API keys are excluded.");
  } else if (action === "commit-import") {
    if (!s.preview || s.busy) return;
    store.set({ busy: true });
    try {
      await setBundle(await provider.importDataset(s.preview), {
        newWorkspace: s.preview.newWorkspace,
      });
      notify("Import validated and saved.");
    } finally {
      store.set({ busy: false });
    }
  } else if (action === "save-workspace") {
    const name = $("#workspace-name").value.trim(),
      timezone = $("#workspace-timezone").value.trim();
    if (!name) throw new Error("Workspace name is required.");
    const next = structuredClone(s.bundle);
    next.workspace.name = name;
    next.workspace.timezone = timezone;
    store.set({ busy: true });
    try {
      await setBundle(
        await provider.write(next, { expected: fingerprint(s.bundle) }),
      );
      notify("Workspace preferences saved.");
    } finally {
      store.set({ busy: false });
    }
  }
}

function selectedBasemap(s = store.get()) {
  return [...BUILTIN_BASEMAPS, ...s.mapCatalog.basemaps].find(b => b.id === s.mapCatalog.basemapId) || BUILTIN_BASEMAPS[0];
}

async function changeMapCatalog(change) {
  if (store.get().mapSourceBusy) throw new Error('A map source is being saved. Please wait.');
  const focusSelector = mapPanelFocusSelector();
  store.set({ mapSourceBusy: true });
  $('#map-source-save').disabled = true;
  $('#map-source-save').textContent = 'Saving…';
  try {
    const next = await change(store.get().mapCatalog);
    await mapCatalogRepository.save(next);
    store.set({ mapCatalog: next, dynamicLayerErrors: {} });
  } finally {
    store.set({ mapSourceBusy: false });
    $('#map-source-save').disabled = false;
    $('#map-source-save').textContent = 'Add and save';
    if (focusSelector) $('#map-layers').querySelector(focusSelector)?.focus({ preventScroll: true });
  }
}

function openMapSource(basemap) {
  const form = $('#map-source-form');
  form.reset();
  form.dataset.basemap = String(basemap);
  $('#map-source-title').textContent = basemap ? 'Add basemap' : 'Add layer';
  $('#map-source-type').innerHTML = (basemap
    ? [['style', 'MapLibre style URL'], ['raster', 'Raster tile URL (XYZ)']]
    : [['geojson', 'GeoJSON URL'], ['file', 'GeoJSON file'], ['raster', 'Raster tile URL (XYZ)']])
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  $('#map-source-form-error').hidden = true;
  configureMapSourceForm();
  $('#map-source-dialog').showModal();
  $('#map-source-name').focus();
}

function configureMapSourceForm() {
  const type = $('#map-source-type').value;
  $('#map-source-url-field').hidden = type === 'file';
  $('#map-source-file-field').hidden = type !== 'file';
  $('#map-source-url').required = type !== 'file';
  $('#map-source-file').required = type === 'file';
  $('#map-source-attribution-field').hidden = type === 'style';
  $('#map-source-attribution').disabled = type === 'style';
  $('#map-source-color-field').hidden = type === 'raster' || $('#map-source-form').dataset.basemap === 'true';
  $('#map-source-url').placeholder = type === 'raster' ? 'https://example.com/tiles/{z}/{x}/{y}.png' : type === 'style' ? 'https://example.com/style.json' : 'https://example.com/layer.geojson';
  $('#map-source-hint').textContent = type === 'raster'
    ? 'Use an XYZ tile URL with {z}, {x}, and {y}. The provider must allow browser access (CORS).'
    : type === 'style' ? 'A MapLibre style JSON URL. The provider must allow browser access (CORS).'
    : 'A GeoJSON FeatureCollection in WGS84. Remote sources must allow browser access (CORS).';
}

function wire() {
  window.addEventListener("hashchange", applySection);
  window.addEventListener("beforeunload", () => {
    if (mapView) mapCamera[store.get().mapMode] = mapView.captureCamera();
    persist();
    publicAbort?.abort();
    clearTimeout(publicViewTimer);
    provider.dispose();
    mapCatalogRepository.dispose();
  });
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button,a");
    if (!target) return;
    try {
      if (target.dataset.removeDynamic || target.dataset.removeBasemap) {
        await changeMapCatalog(c => target.dataset.removeDynamic
          ? { ...c, layers: c.layers.filter(l => l.id !== target.dataset.removeDynamic) }
          : { ...c, basemaps: c.basemaps.filter(b => b.id !== target.dataset.removeBasemap), basemapId: 'default' });
      } else if (target.dataset.focusDynamic) {
        const layer = store.get().mapCatalog.layers.find(l => l.id === target.dataset.focusDynamic);
        if (store.get().mapMode === '3d') await mountMap('2d');
        mapView?.focusBounds?.(layer.bounds);
      } else if (target.dataset.refreshDynamic) {
        await changeMapCatalog(async c => {
          const layer = c.layers.find(l => l.id === target.dataset.refreshDynamic);
          const next = await loadGeoJsonSource(layer);
          return { ...c, layers: c.layers.map(l => l.id === next.id ? next : l) };
        });
      } else if (target.dataset.action) await handleAction(target.dataset.action);
      else if (target.dataset.osmRetry)
        await loadOsmLayer(target.dataset.osmRetry);
      else if (target.dataset.refreshLayer)
        await loadPublicArea(publicBounds, {
          force: true,
          sourceId: target.dataset.refreshLayer,
        });
      else if (target.dataset.select) selectAsset(target.dataset.select);
      else if (target.dataset.focus)
        selectAsset(target.dataset.focus, { focus: true });
      else if (target.dataset.measure)
        selectAsset(target.dataset.measure, { measure: true });
      else if (target.dataset.searchSelect) {
        selectAsset(target.dataset.searchSelect, { focus: true });
        $("#global-search").value = "";
      } else if (target.dataset.mapMode) {
        store.set({ defaultMap: target.dataset.mapMode, mapNotice: "" });
        persist();
        await mountMap(target.dataset.mapMode);
      } else if (target.dataset.zoom)
        mapView?.zoom(Number(target.dataset.zoom));
      else if (target.dataset.removeDataset) {
        if (store.get().busy) return;
        const d = store
          .get()
          .bundle.datasets.find((d) => d.id === target.dataset.removeDataset);
        const publicLayer = PUBLIC_LAYERS.find((layer) => layer.id === d.id);
        if (
          publicLayer &&
          store.get().bundle.workspace.id === PUBLIC_WORKSPACE_ID
        ) {
          store.set({
            layers: { ...store.get().layers, [publicLayer.assetType]: false },
          });
          persist();
          notify(
            `${publicLayer.name} hidden. Enable it in Infrastructure layers to show it again.`,
          );
          return;
        }
        if (
          !(await confirmAction(
            "Remove this dataset?",
            `Remove ${d.name} and its dependent assets, observations, and events from this workspace? Export first to keep a copy.`,
            "Remove dataset",
          ))
        )
          return;
        store.set({ busy: true });
        try {
          await setBundle(
            await provider.removeDataset(store.get().bundle.workspace.id, d.id),
          );
          notify("Dataset removed.");
        } finally {
          store.set({ busy: false });
        }
      }
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.id === "global-search") search(el.value);
    else if (el.id === "asset-query")
      store.set({
        filters: { ...store.get().filters, query: el.value },
        assetPage: 0,
      });
    else if (el.id === "cloud-coverage") {
      $("#cloud-coverage-value").textContent =
        `${Math.round(Number(el.value) * 100)}%`;
      mapView?.setEnvironment?.({
        ...store.get().environment,
        cloudCoverage: Number(el.value),
      });
    }
  });
  document.addEventListener("change", async (event) => {
    const el = event.target,
      s = store.get();
    try {
      if (el.id === 'map-source-type') configureMapSourceForm();
      else if (el.id === 'basemap-selector') {
        await changeMapCatalog(c => ({ ...c, basemapId: el.value }));
        if (store.get().mapMode !== '2d') await mountMap('2d');
      } else if (el.dataset.dynamicLayer) {
        await changeMapCatalog(c => ({ ...c, layers: c.layers.map(l => l.id === el.dataset.dynamicLayer ? { ...l, visible: el.checked } : l) }));
        if (el.checked && store.get().mapMode === '3d') await mountMap('2d');
      } else if (el.hasAttribute("data-highway-cameras")) {
        store.set({ highwayCamerasVisible: el.checked });
        persist();
      } else if (el.hasAttribute("data-solar-pv")) {
        store.set({ solarPvVisible: el.checked });
        persist();
      } else if (el.hasAttribute("data-pkl-pv")) {
        store.set({ pklPvVisible: el.checked });
        persist();
      } else if (el.dataset.osmLayer) {
        store.set({
          osmLayers: { ...s.osmLayers, [el.dataset.osmLayer]: el.checked },
          selectedOsmId: null,
        });
        persist();
        if (el.checked) void loadOsmLayer(el.dataset.osmLayer);
      } else if (el.dataset.layer) {
        store.set({ layers: { ...s.layers, [el.dataset.layer]: el.checked } });
        persist();
        if (
          el.checked &&
          PUBLIC_LAYERS.some((layer) => layer.assetType === el.dataset.layer)
        )
          void loadPublicArea(publicBounds);
      } else if (el.id === "clouds-enabled" || el.id === "cloud-coverage") {
        store.set({
          environment: {
            ...s.environment,
            ...(el.id === "clouds-enabled"
              ? { cloudsEnabled: el.checked }
              : { cloudCoverage: Number(el.value) }),
          },
        });
        persist();
      } else if (el.id === "asset-type" || el.id === "asset-network")
        store.set({
          filters: {
            ...s.filters,
            [el.id === "asset-type" ? "type" : "network"]: el.value,
          },
          assetPage: 0,
        });
      else if (el.id === "measurement-series")
        store.set({ seriesId: el.value });
      else if (el.id === "source-category")
        store.set({ sourceCategory: el.value });
      else if (el.id === "theme-select") {
        store.set({ theme: el.value });
        persist();
      } else if (el.dataset.tronSetting) {
        store.set({tronSettings:tronPreferences({...s.tronSettings,[el.dataset.tronSetting]:el.checked})});
        persist();
      } else if (el.id === "default-map") {
        store.set({ defaultMap: el.value });
        persist();
      } else if (el.id === "workspace-selector") {
        store.set({ busy: true });
        try {
          await setBundle(await provider.loadWorkspace(el.value));
        } finally {
          store.set({ busy: false });
        }
      } else if (el.id === "import-file" && el.files[0]) {
        const file = el.files[0];
        if (file.size > 20 * 1024 * 1024)
          throw new Error("Import is limited to 20 MB.");
        store.set({ busy: true });
        try {
          store.set({
            preview: previewImport({
              text: await file.text(),
              filename: file.name,
              current: store.get().bundle,
            }),
          });
        } finally {
          store.set({ busy: false });
        }
      }
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (store.get().mapLayerMenuOpen && !$('#map-source-dialog').open) {
        store.set({ mapLayerMenuOpen: false });
        $('#map-layer-button').focus();
      }
      if (store.get().drawerOpen) {
        store.set({ drawerOpen: false });
        $(".mobile-menu").focus();
      }
      $("#search-results").hidden = true;
      $("#global-search").setAttribute("aria-expanded", "false");
    }
    if (event.target.id === "global-search" && event.key === "ArrowDown") {
      $("#search-results button")?.focus();
      event.preventDefault();
    }
    if (
      event.target.closest("#search-results") &&
      ["ArrowDown", "ArrowUp"].includes(event.key)
    ) {
      const buttons = [...document.querySelectorAll("#search-results button")],
        i = buttons.indexOf(event.target.closest("button"));
      buttons[
        (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length
      ]?.focus();
      event.preventDefault();
    }
    if (event.target.id === "global-search" && event.key === "Enter")
      $("#search-results button")?.click();
    if (store.get().drawerOpen && event.key === "Tab") {
      const links = [
        ...document.querySelectorAll("#sidebar a,#sidebar button"),
      ];
      const first = links[0],
        last = links.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    }
  });
  $('#map-source-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    $('#map-source-form-error').hidden = true;
    try {
      await changeMapCatalog(async c => {
        const fields = Object.fromEntries(new FormData(form));
        let source = mapSource(fields, form.dataset.basemap === 'true');
        if (form.dataset.basemap === 'true') {
          if (source.type === 'style') await fetchBasemapStyle(source);
          return { ...c, basemaps: [...c.basemaps, source], basemapId: source.id };
        }
        if (source.type === 'geojson') {
          const file = fields.type === 'file' ? $('#map-source-file').files[0] : null;
          if (fields.type === 'file' && !file) throw new Error('Choose a GeoJSON file.');
          source = await loadGeoJsonSource(source, file);
        }
        return { ...c, layers: [...c.layers, source] };
      });
      $('#map-source-dialog').close();
      if (store.get().mapMode === '3d') await mountMap('2d');
      notify('Map source added and saved in this browser.');
    } catch (error) {
      $('#map-source-form-error').textContent = error.message;
      $('#map-source-form-error').hidden = false;
    }
  });
  $('#map-source-dialog').addEventListener('close', () => {
    const action = $('#map-source-form').dataset.basemap === 'true' ? 'add-basemap' : 'add-layer';
    $(`#map-layers [data-action="${action}"]`)?.focus({ preventScroll: true });
  });
  $('#map-source-dialog').addEventListener('cancel', event => {
    if (store.get().mapSourceBusy) event.preventDefault();
  });
  document.addEventListener("pointerdown", (event) => {
    if (store.get().mapLayerMenuOpen && !$('#map-source-dialog').open && !event.target.closest('#map-layers, #map-layer-button'))
      store.set({ mapLayerMenuOpen: false });
    if (!event.target.closest(".global-search")) {
      $("#search-results").hidden = true;
      $("#global-search").setAttribute("aria-expanded", "false");
    }
  });
}

async function start() {
  try {
    key = await googleMapsKey(key);
    const response = await fetch(
      `${import.meta.env.BASE_URL}data/workspace.json`,
    );
    if (!response.ok)
      throw new Error("The starting workspace could not be loaded.");
    initialWorkspace = assertBundle(await response.json());
    await provider.initialize(initialWorkspace);
    if (initialWorkspace.workspace.id === PUBLIC_WORKSPACE_ID)
      await provider.retireSyntheticDemo();
    const newDefault = preferences.defaultDataVersion !== PUBLIC_DATA_VERSION;
    let bundle;
    try {
      bundle = await provider.loadWorkspace(
        (!newDefault && preferences.workspaceId) ||
          initialWorkspace.workspace.id,
      );
    } catch {
      bundle = await provider.loadWorkspace(initialWorkspace.workspace.id);
    }
    if (bundle.workspace.id === PUBLIC_WORKSPACE_ID) {
      bundle.sources = [
        ...new Map(
          [...bundle.sources, ...initialWorkspace.sources].map((source) => [
            source.id,
            source,
          ]),
        ).values(),
      ];
      if (newDefault || !mapCamera["2d"])
        mapCamera = {
          "2d": { ...TAMPA_CAMERA },
          "3d": { center: [...TAMPA_CAMERA.center] },
        };
    }
    let nationalTransmission = null, nationalTransmissionError = "";
    try { nationalTransmission = await loadNationalTransmission(import.meta.env.BASE_URL); }
    catch (error) { nationalTransmissionError = error.message; }
    // A new national layer must not override a configured Google 3D preference.
    const startupView = initialMapView({
      defaultMap: preferences.defaultMap,
      googleConfigured: Boolean(key),
      nationalOverview: bundle.workspace.id === PUBLIC_WORKSPACE_ID && nationalTransmission?.featureCount > 0
        && preferences.nationalTransmissionVersion !== NATIONAL_TRANSMISSION_VERSION,
    });
    const initialNationalView = startupView.showNationalOverview;
    if (initialNationalView && sectionFromHash() !== 'simulation') {
      mapCamera["2d"] = { center: [-98, 38], zoom: 3.5 };
      publicBounds = [...NATIONAL_TRANSMISSION_VIEWS.country.bounds];
    }
    let mapCatalog = emptyCatalog(), mapCatalogWarning = '';
    try { mapCatalog = await mapCatalogRepository.read(); }
    catch (error) { mapCatalogWarning = error.message; }
    store = createStore({
      mapCatalog,
      mapLayerMenuOpen: false,
      mapSourceBusy: false,
      dynamicLayerErrors: {},
      basemapError: '',
      bundle,
      workspaces: await provider.listWorkspaces(),
      section: sectionFromHash(),
      theme: preferences.theme === "light" ? "light" : "dark",
      sidebarExpanded: Boolean(preferences.sidebarExpanded),
      drawerOpen: false,
      defaultMap: ["2d", "tron"].includes(preferences.defaultMap) ? preferences.defaultMap : "3d",
      mapMode: "2d",
      mapStatus: "Loading map…",
      mapNotice: "",
      layers: {
        ...(newDefault && bundle.workspace.id === PUBLIC_WORKSPACE_ID ? {} : preferences.layers || { pole: false }),
        ...(initialNationalView ? { transmission_line: true } : {}),
      },
      publicLayerState: {},
      nationalTransmission,
      nationalTransmissionError,
      osmManifest: null,
      osmData: {},
      osmLayers: preferences.osmLayers || {},
      osmStatus: {},
      osmError: "",
      osmOpen: false,
      highwayCamerasVisible: preferences.highwayCamerasVisible !== false,
      solarPvVisible: preferences.solarPvVisible !== false,
      solarPvStatus: null,
      solarPvOpen: false,
      pklPvVisible: preferences.pklPvVisible !== false,
      pklPvStatus: null,
      pklPvOpen: false,
      equipmentStatus: null,
      selectedOsmId: null,
      assetPage: 0,
      layersOpen: true,
      environment: environmentPreferences(preferences.environment),
      tronSettings: tronPreferences(preferences.tronSettings),
      environmentOpen: true,
      selectedId: null,
      seriesId: null,
      filters: { query: "", type: "", network: "" },
      preview: null,
      sourceCategory: "",
      busy: false,
      googleConfigured: Boolean(key),
      storageAvailable: Boolean(provider.db),
    });
    analysisController = createAnalysisController({
      getContext: () => ({ bundle: store.get().bundle, bounds: publicBounds, camera: mapView?.captureCamera() }),
      notify,
    });
    shell();
    simulationController = createSimulationController({
      onChange: state => {
        updateSimulationPanel?.(state);
        if (store.get().mapLayerMenuOpen) renderMapPanels();
      },
      onLayer: async layer => {
        if(layer && store.get().mapMode==='3d' && !mapView?.simulationPostprocessing)await mountMap('3d');
        else await mapView?.setSimulation?.(layer);
      },
      onFocus: async bounds => {
        if (!mapView) throw Error('Map is still loading. Retry Load network when the map is ready.');
        if (mapView.focusSimulation) await mapView.focusSimulation(bounds);
        else { mapView.focusBounds(bounds); await new Promise(resolve => setTimeout(resolve, 800)); }
      },
    });
    updateSimulationPanel = mountSimulationPanel($('#simulation-panel'), simulationController, { onClose: () => navigate('spatial') });
    updateSimulationPanel(simulationController.getState());
    document.addEventListener('change', event => {
      if (event.target.matches('[data-simulation-layer-toggle]')) simulationController.visible(event.target.checked);
    });
    wire();
    store.subscribe(renderState);
    renderState(store.get());
    if (provider.warning || mapCatalogWarning) notify(provider.warning || mapCatalogWarning, true);
    void loadOsm();
    await mountMap(startupView.mode);
    if (initialNationalView && store.get().section !== 'simulation' && !simulationController.getState().selectedKey) {
      mapView?.focusBounds?.(NATIONAL_TRANSMISSION_VIEWS.country.bounds);
      persist();
    }
    if (bundle.workspace.id === PUBLIC_WORKSPACE_ID)
      void loadPublicArea(publicBounds, { force: true });
  } catch (error) {
    $("#app").innerHTML =
      `<div class="boot boot-error">${icon("alert")}<h1>Workspace could not open</h1><p>${esc(error.message)}</p><button class="primary" onclick="location.reload()">Retry</button></div>`;
  }
}
void start();
