import { tronStyle } from "./tron-style.js";
import { createTronScene } from "./tron-scene.js";
import { reverseMapLibreRightDrag } from "./right-drag.js";
import { createSimulation2D } from "../simulation/map-layer.js";
import { Map, Popup, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { boundsOf, assetCenter } from "../domain/model.js";
import { infrastructureColor, substationDiamondImage } from "./infrastructure-style.js";
import { createAdditiveTransmissionLayer } from "./transmission-additive.js";
import { PUBLIC_WORKSPACE_ID } from "../data/public-layers.js";
import { appendPublicAttribution } from "../components/public-layers.js";
import { appendOsmAttribution } from "../components/osm-layers.js";
import { HIGHWAY_CAMERAS, HIGHWAY_CAMERA_BY_ID } from "../data/highway-cameras.js";
import { cameraSymbolCanvas, createCameraPopup } from "../components/highway-cameras.js";
import { visibleCameraIds } from "./camera-symbol-range.js";
import { groundViewExtent, withinSubstationViewExtent } from "./substation-symbol-range.js";
import mvtWorkerUrl from "../../node_modules/@loaders.gl/mvt/dist/mvt-worker.js?url";
import { createSolarPvLayer } from "./solar-pv-layer.js";
import { createPklPvPopup } from "../components/pkl-pv.js";

import { localStyle, fetchBasemapStyle } from './basemaps.js';
import { BUILTIN_BASEMAPS } from '../data/dynamic-layers.js';
import { createDynamicMapLayers } from './dynamic-layers.js';

setWorkerUrl(workerUrl);
const colors = ["get", "displayColor"];
const assetLayers = ["tb-substations", "tb-points", "tb-lines", "tb-area"];

export function createSpatialView({
  host,
  bundle,
  camera: savedCamera,
  basemap = BUILTIN_BASEMAPS[0],
  mode = "2d",
  tronSettings,
  onBasemapError,
  onDynamicLayerError,
  onSelect,
  onSelectNational,
  onNationalError,
  onSolarPvStatus,
  onPklPvStatus,
  onSelectContext,
  onPointer,
  onViewChange,
  onStatus,
  onFatal,
}) {
  let current = { assets: bundle.assets, selectedId: null, connectedIds: [] };
  let disposed = false,
    baseFailure = false,
    remoteRequested = false;
  let selectedBasemap = basemap, basemapAbort, basemapEpoch = 0;
  const b =
    bundle.workspace.id === PUBLIC_WORKSPACE_ID
      ? boundsOf([{ geometry: bundle.workspace.serviceArea }])
      : boundsOf(bundle.assets);
  const tron = mode === "tron";
  const modeLabel = tron ? "TRON" : "2D";
  const map = new Map({
    container: host,
    style: localStyle(),
    center: savedCamera?.center || [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
    zoom: savedCamera?.zoom ?? 14,
    maxZoom: 21,
    pitch: tron ? savedCamera?.pitch ?? 55 : 0,
    bearing: savedCamera?.bearing ?? 0,
    attributionControl: {
      compact: false,
      customAttribution: bundle.workspace.id === PUBLIC_WORKSPACE_ID
        ? ['SPATIAL D', 'Solar · <a href="https://panelcensus.com/sites?operator=Tampa%20Electric%20Co" target="_blank" rel="noopener noreferrer">PanelCensus</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>']
        : "SPATIAL D",
    },
    preserveDrawingBuffer: true,
    antialias: true,
  });
  const restoreRightDrag = reverseMapLibreRightDrag(map);
  let simulationLayer;
  map
    .getCanvas()
    .setAttribute(
      "aria-label",
      `Interactive ${modeLabel} utility network map. Search or use the asset inventory for keyboard inspection.`,
    );
  map.getCanvas().setAttribute("data-testid", "map-canvas");
  const removeAttribution = appendPublicAttribution(host, bundle);
  const osmAttribution = appendOsmAttribution(host);
  const contextSources = new globalThis.Map();
  const dynamicLayers = createDynamicMapLayers(map);
  const transmissionLayer = createAdditiveTransmissionLayer({ workerUrl: mvtWorkerUrl, onError: onNationalError });
  simulationLayer = tron ? createTronScene(map, {settings:tronSettings,setLayers: layers => transmissionLayer.setExtraLayers(layers), onError: message => onBasemapError?.(message)}) : createSimulation2D(map);
  const solarPvLayer = bundle.workspace.id === PUBLIC_WORKSPACE_ID ? createSolarPvLayer(map, { onStatus: onSolarPvStatus, underLayer:'tb-pkl-pv-buildings' }) : null;
  const pklPvLayer = bundle.workspace.id === PUBLIC_WORKSPACE_ID ? createSolarPvLayer(map, {
    onStatus:onPklPvStatus,idPrefix:'tb-pkl-pv',dataFile:'teco-pkl-pv-buildings.json',createPopup:createPklPvPopup,
  }) : null;
  function syncSubstationExtent() {
    if (disposed || !map.getLayer("tb-substations")) return;
    const b = map.getBounds();
    const extent = groundViewExtent([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    const visibility = withinSubstationViewExtent(extent) ? "visible" : "none";
    if (map.getLayoutProperty("tb-substations", "visibility") !== visibility)
      map.setLayoutProperty("tb-substations", "visibility", visibility);
  }
  let cameraPopup, cameraPlayer, cameraPopupObserver;
  let selectedCameraId, cameraFilterKey;
  function closeCameraPopup() {
    cameraPopupObserver?.disconnect();
    cameraPopupObserver = null;
    cameraPlayer?.dispose();
    cameraPlayer = null;
    selectedCameraId = null;
    const popup = cameraPopup;
    cameraPopup = null;
    popup?.remove();
  }
  function syncCameras() {
    if (!map.getLayer("tb-highway-cameras")) return;
    map.setLayoutProperty("tb-highway-cameras", "visibility", current.highwayCamerasVisible === false ? "none" : "visible");
    if (current.highwayCamerasVisible === false) closeCameraPopup();
    syncCameraRange();
  }
  function syncCameraRange() {
    if (disposed || !map.getLayer("tb-highway-cameras")) return;
    const b = map.getBounds();
    const ids = visibleCameraIds(HIGHWAY_CAMERAS.features, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    const key = ids.join(":");
    if (key !== cameraFilterKey) {
      map.setFilter("tb-highway-cameras", ["in", ["get", "id"], ["literal", ids]]);
      cameraFilterKey = key;
    }
    if (selectedCameraId && !ids.includes(selectedCameraId)) closeCameraPopup();
  }
  function showCamera(id) {
    const feature = HIGHWAY_CAMERA_BY_ID.get(String(id));
    if (!feature) return;
    solarPvLayer?.close();
    pklPvLayer?.close();
    closeCameraPopup();
    selectedCameraId = String(id);
    cameraPlayer = createCameraPopup(feature, { onClose: closeCameraPopup });
    const sizePopup = () => {
      if (cameraPlayer)
        cameraPlayer.element.style.maxHeight = `${Math.max(100, host.clientHeight / 2 - 36)}px`;
      cameraPopup?.setLngLat(feature.geometry.coordinates);
    };
    sizePopup();
    cameraPopup = new Popup({ closeButton: false, maxWidth: "380px", offset: 20, className: "camera-map-popup" })
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(cameraPlayer.element)
      .addTo(map);
    cameraPopup.on("close", closeCameraPopup);
    cameraPopupObserver = new ResizeObserver(sizePopup);
    cameraPopupObserver.observe(cameraPlayer.element);
    cameraPopupObserver.observe(host);
  }
  function contextLayerIds() {
    return (current.context?.manifest?.layers || [])
      .flatMap((layer) =>
        ["point", "line", "fill"].map((kind) => `osm-${layer.id}-${kind}`),
      )
      .filter((id) => map.getLayer(id));
  }
  function syncContext() {
    const context = current.context;
    osmAttribution.update(
      Boolean(
        context && Object.keys(context.data).some((id) => context.layers[id]),
      ),
    );
    if (!context || !map.getLayer("tb-area")) return;
    for (const layer of context.manifest?.layers || []) {
      const data = context.data[layer.id];
      if (!data) continue;
      const sourceId = `osm-${layer.id}`;
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: "geojson", data });
        contextSources.set(layer.id, data);
      } else if (contextSources.get(layer.id) !== data) {
        map.getSource(sourceId).setData(data);
        contextSources.set(layer.id, data);
      }
      const color = [
        "case",
        ["==", ["get", "id"], context.selectedId || ""],
        "#ffffff",
        layer.color,
      ];
      for (const kind of ["fill", "line", "point"]) {
        const id = `${sourceId}-${kind}`;
        if (!map.getLayer(id)) {
          const type = kind === "point" ? "circle" : kind;
          const paint =
            kind === "fill"
              ? {
                  "fill-color": color,
                  "fill-opacity": layer.id === "water" ? 0.36 : 0.14,
                }
              : kind === "line"
                ? {
                    "line-color": color,
                    "line-width": layer.id === "utilities" ? 2 : 1.2,
                    "line-opacity": 0.8,
                  }
                : {
                    "circle-color": color,
                    "circle-radius": 3.5,
                    "circle-stroke-width": 1,
                    "circle-stroke-color": "#102332",
                  };
          map.addLayer(
            {
              id,
              type,
              source: sourceId,
              filter: [
                "==",
                ["geometry-type"],
                kind === "fill"
                  ? "Polygon"
                  : kind === "point"
                    ? "Point"
                    : "LineString",
              ],
              paint,
            },
            map.getLayer('tb-pv-buildings') ? 'tb-pv-buildings' : map.getLayer('tb-pkl-pv-buildings') ? 'tb-pkl-pv-buildings' : 'tb-area',
          );
        }
        map.setLayoutProperty(
          id,
          "visibility",
          context.layers[layer.id] ? "visible" : "none",
        );
        map.setPaintProperty(
          id,
          `${kind === "point" ? "circle" : kind}-color`,
          color,
        );
      }
    }
  }
  const reportView = () => {
    if (disposed) return;
    const b = map.getBounds(),
      center = map.getCenter();
    onViewChange?.({
      bounds: [
        Math.max(-180, b.getWest()),
        Math.max(-90, b.getSouth()),
        Math.min(180, b.getEast()),
        Math.min(90, b.getNorth()),
      ],
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
    });
  };
  map.on("moveend", reportView);
  map.on("move", syncCameraRange);
  map.on("resize", syncCameraRange);
  map.on("move", syncSubstationExtent);
  map.on("resize", syncSubstationExtent);
  const onStyle = () => {
    if (disposed) return;
    if (!map.getSource("tb-assets"))
      map.addSource("tb-assets", { type: "geojson", data: features() });
    if (!map.getSource("tb-boundary"))
      map.addSource("tb-boundary", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: bundle.workspace.serviceArea,
          properties: {},
        },
      });
    if (!map.getLayer("tb-boundary"))
      map.addLayer({
        id: "tb-boundary",
        type: "line",
        source: "tb-boundary",
        paint: {
          "line-color": "#6593a7",
          "line-opacity": 0.35,
          "line-width": 1,
          "line-dasharray": [3, 3],
        },
      });
    if (!map.getLayer("tb-area"))
      map.addLayer({
        id: "tb-area",
        type: "fill",
        source: "tb-assets",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": colors, "fill-opacity": 0.3 },
      });
    if (!map.getLayer("tb-line-glow"))
      map.addLayer({
        id: "tb-line-glow",
        type: "line",
        source: "tb-assets",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["!=", ["get", "assetType"], "transmission_line"]],
        paint: {
          "line-color": colors,
          "line-width": 11,
          "line-opacity": 0.12,
          "line-blur": 5,
        },
      });
    if (!map.getLayer("tb-lines"))
      map.addLayer({
        id: "tb-lines",
        type: "line",
        source: "tb-assets",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": [
            "case",
            ["==", ["get", "highlight"], "selected"],
            "#ffffff",
            ["==", ["get", "highlight"], "neighbor"],
            "#65e4f5",
            colors,
          ],
          "line-width": [
            "case",
            ["==", ["get", "highlight"], "selected"],
            5,
            3,
          ],
          // Keep transmission geometry here for hit testing; the custom layer draws it.
          "line-opacity": ["case", ["==", ["get", "assetType"], "transmission_line"], 0, 0.95],
        },
      });
    if (!map.getLayer("tb-underground"))
      map.addLayer({
        id: "tb-underground",
        type: "line",
        source: "tb-assets",
        filter: ["==", ["get", "assetType"], "underground_cable"],
        paint: {
          "line-color": "#d7c3ff",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
    if (!map.getLayer("tb-points"))
      map.addLayer({
        id: "tb-points",
        type: "circle",
        source: "tb-assets",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "assetType"], "substation"]],
        layout: {
          "circle-sort-key": [
            "match",
            ["get", "assetType"],
            "pole",
            0,
            "meter",
            1,
            "transformer",
            2,
            "switch",
            3,
            4,
          ],
        },
        paint: {
          "circle-color": colors,
          "circle-radius": [
            "case",
            ["==", ["get", "highlight"], "selected"],
            10,
            ["==", ["get", "highlight"], "neighbor"],
            7,
            ["==", ["get", "assetType"], "pole"],
            3,
            ["==", ["get", "assetType"], "meter"],
            4,
            6,
          ],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "highlight"], "selected"],
            "#fff",
            ["==", ["get", "highlight"], "neighbor"],
            "#e4faff",
            "#0b2636",
          ],
          "circle-stroke-width": [
            "case",
            ["==", ["get", "highlight"], "selected"],
            3,
            1.6,
          ],
        },
      });
    if (!map.hasImage("substation-diamond"))
      map.addImage("substation-diamond", substationDiamondImage(), { sdf: true, pixelRatio: 2 });
    if (!map.getLayer("tb-substations"))
      map.addLayer({
        id: "tb-substations", type: "symbol", source: "tb-assets",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "assetType"], "substation"]],
        layout: {
          "icon-image": "substation-diamond",
          "icon-rotate": 45,
          "icon-size": ["match", ["get", "highlight"], "selected", 0.45, "neighbor", 0.4, 0.3],
          "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-rotation-alignment": "viewport", "icon-pitch-alignment": "viewport",
        },
        paint: {
          "icon-color": colors,
          "icon-halo-color": ["match", ["get", "highlight"], "selected", "#ffffff", "neighbor", "#65e4f5", "#9aa6ae"],
          "icon-halo-width": ["match", ["get", "highlight"], "selected", 1.5, "neighbor", 1, 0.4],
        },
      });
    map.getSource("tb-assets").setData(features());
    syncContext();
    dynamicLayers.sync(current.dynamicLayers || []);
    if (!map.hasImage("highway-camera")) {
      const canvas = cameraSymbolCanvas();
      map.addImage("highway-camera", canvas.getContext("2d").getImageData(0, 0, 64, 64), { pixelRatio: 2 });
    }
    if (!map.getSource("tb-highway-cameras"))
      map.addSource("tb-highway-cameras", { type: "geojson", data: HIGHWAY_CAMERAS });
    if (!map.getLayer("tb-highway-cameras")) {
      cameraFilterKey = undefined;
      map.addLayer({
        id: "tb-highway-cameras", type: "symbol", source: "tb-highway-cameras",
        layout: { "icon-image": "highway-camera", "icon-size": 0.9, "icon-allow-overlap": true },
      });
    }
    syncCameras();
    solarPvLayer?.setVisible(current.solarPvVisible);
    solarPvLayer?.attach();
    pklPvLayer?.setVisible(current.pklPvVisible);
    pklPvLayer?.attach();
    syncSubstationExtent();
    transmissionLayer.setData(current);
    transmissionLayer.attach(map);
  };
  function features() {
    return {
      type: "FeatureCollection",
      features: current.assets.map((a) => ({
        type: "Feature",
        id: a.id,
        geometry: a.geometry,
        properties: {
          id: a.id,
          name: a.name,
          assetType: a.assetType,
          displayColor: infrastructureColor(a),
          highlight:
            a.id === current.selectedId
              ? "selected"
              : current.connectedIds.includes(a.id)
                ? "neighbor"
                : "normal",
        },
      })),
    };
  }
  map.on("style.load", onStyle);
  map.on("load", () => {
    if (!savedCamera)
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        {
          padding:
            host.clientWidth < 600
              ? 60
              : { top: 120, bottom: 80, left: 310, right: 80 },
          duration: 0,
          maxZoom: 16,
        },
      );
    reportView();
    if (!baseFailure) onStatus(`${modeLabel} · Loading geographic context…`);
  });
  map.on("mousemove", (e) => {
    onPointer?.({ longitude: e.lngLat.lng, latitude: e.lngLat.lat });
    if (map.isStyleLoaded())
      map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, {
        layers: [
          ...assetLayers.filter((id) => map.getLayer(id)),
          ...contextLayerIds(),
          ...(map.getLayer("tb-highway-cameras") ? ["tb-highway-cameras"] : []),
          ...(solarPvLayer?.layerIds() || []),
          ...(pklPvLayer?.layerIds() || []),
        ],
      }).length
        ? "pointer"
        : "";
  });
  map.on("click", (e) => {
    if (!map.isStyleLoaded()) return;
    const cameras = map.queryRenderedFeatures(e.point, { layers: map.getLayer("tb-highway-cameras") ? ["tb-highway-cameras"] : [] });
    if (cameras[0]) { showCamera(cameras[0].properties.id); return; }
    closeCameraPopup();
    solarPvLayer?.close();
    pklPvLayer?.close();
    const found = map.queryRenderedFeatures(e.point, {
      layers: assetLayers.filter((id) => map.getLayer(id)),
    });
    if (found[0]) onSelect(found[0].properties.id);
    else {
      const line = transmissionLayer.pick(e.point);
      if (line) { onSelectNational?.(line.properties.externalId); return; }
      const pkl = map.queryRenderedFeatures(e.point, { layers: pklPvLayer?.layerIds() || [] });
      if(pkl[0] && pklPvLayer?.show(pkl[0], e.lngLat)) return;
      const pv = map.queryRenderedFeatures(e.point, { layers: solarPvLayer?.layerIds() || [] });
      if(pv[0] && solarPvLayer?.show(pv[0], e.lngLat)) return;
      const context = map.queryRenderedFeatures(e.point, {
        layers: contextLayerIds(),
      });
      if (context[0]) onSelectContext?.(context[0].properties.id);
    }
  });
  map.on("error", (event) => {
    if (disposed) return;
    const sourceId = event.sourceId || event.error?.sourceId;
    const dynamicId = sourceId && dynamicLayers.sourceLayerId(sourceId);
    if (sourceId?.startsWith('dynamic-')) {
      if (dynamicId) onDynamicLayerError?.(dynamicId, 'Map source unavailable. Check the tile URL and provider access.');
      return;
    }
    // Utility and local context errors must never discard a working basemap.
    if (sourceId && (sourceId.startsWith('tb-') || sourceId.startsWith('osm-'))) return;
    if (baseFailure || !remoteRequested) return;
    baseFailure = true;
    applyStyle(localStyle());
    onBasemapError?.('Basemap unavailable. Saved layers and utility overlays are retained.');
    onStatus('Basemap unavailable · asset overlays retained');
  });
  map.getCanvas().addEventListener("webglcontextlost", lost);
  function lost(e) {
    e.preventDefault();
    onFatal?.("Map rendering was interrupted. Your inventory and data remain available.");
  }
  function applyStyle(style) {
    simulationLayer.styleChanging?.();
    transmissionLayer.prepareStyleChange();
    closeCameraPopup();
    solarPvLayer?.close();
    pklPvLayer?.close();
    map.setStyle(style, { diff: false });
  }
  async function setBasemap(next) {
    selectedBasemap = next;
    const epoch = ++basemapEpoch;
    basemapAbort?.abort();
    basemapAbort = new AbortController();
    baseFailure = false;
    remoteRequested = false;
    onBasemapError?.('');
    onStatus(`${modeLabel} · Loading ${tron ? "neon vector map" : next.name}…`);
    try {
      const style = await fetchBasemapStyle(tron ? BUILTIN_BASEMAPS.find(b => b.id === 'streets') : next, AbortSignal.any([basemapAbort.signal, AbortSignal.timeout(15000)]));
      if (disposed || epoch !== basemapEpoch) return;
      remoteRequested = next.type !== 'blank';
      applyStyle(tron ? tronStyle(style) : style);
      if (!baseFailure) onStatus(tron ? "TRON · Neon vector map" : `2D · ${next.name}`);
    } catch (error) {
      if (disposed || epoch !== basemapEpoch) return;
      baseFailure = true;
      applyStyle(localStyle());
      onBasemapError?.(`${error.message} Saved layers and utility overlays are retained.`);
      onStatus('Basemap unavailable · asset overlays retained');
    }
  }
  // Wait for the initial style to attach before replacing it.
  map.once('load', () => { void setBasemap(selectedBasemap); });
  function captureCamera() {
    const c = map.getCenter();
    return {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
  }
  function restoreCamera(c) {
    if (c?.center)
      map.jumpTo({
        center: c.center,
        zoom: c.zoom ?? 14,
        bearing: c.bearing ?? 0,
        pitch: tron ? c.pitch ?? 55 : 0,
      });
  }
  return {
    setSimulation: simulationLayer.set,
    async focusSimulation(bounds) {
      map.stop();
      const done = new Promise(resolve => { const timer = setTimeout(resolve, 1200); map.once('moveend', () => { clearTimeout(timer); resolve(); }); });
      this.focusBounds(bounds); await done;
    },
    setBasemap,
    setTronSettings: value => simulationLayer.configure?.(value),
    update(next) {
      current = next;
      transmissionLayer.setData(current);
      if (map.getSource("tb-assets"))
        map.getSource("tb-assets").setData(features());
      syncContext();
      if (map.getLayer("tb-area")) dynamicLayers.sync(current.dynamicLayers || []);
      syncCameras();
      solarPvLayer?.setVisible(current.solarPvVisible);
      pklPvLayer?.setVisible(current.pklPvVisible);
    },
    closeCameraPopup() { closeCameraPopup(); solarPvLayer?.close(); pklPvLayer?.close(); },
    retrySolarPv: () => solarPvLayer?.retry(),
    retryPklPv: () => pklPvLayer?.retry(),
    focusBounds: (bounds) =>
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        {
          padding:
            host.clientWidth < 600
              ? 60
              : { top: 60, bottom: 140, left: 60, right: 360 },
          duration: 500,
          ...(tron ? {pitch: map.getPitch()} : {}),
        },
      ),
    focusAsset(asset) {
      map.easeTo({
        center: assetCenter(asset),
        zoom: Math.max(map.getZoom(), asset.assetType === "substation" ? 20 : 16),
        duration: 500,
      });
    },
    captureCamera,
    restoreCamera,
    resize: () => map.resize(),
    zoom: (delta) => map.zoomTo(map.getZoom() + delta, { duration: 200 }),
    reset: () =>
      map.fitBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        {
          padding:
            host.clientWidth < 600
              ? 60
              : { top: 120, bottom: 80, left: 310, right: 80 },
          duration: 500,
          maxZoom: 16,
        },
      ),
    dispose() {
      disposed = true;
      simulationLayer.dispose();
      basemapAbort?.abort();
      dynamicLayers.dispose();
      closeCameraPopup();
      removeAttribution();
      osmAttribution.dispose();
      map.off("move", syncCameraRange);
      map.off("resize", syncCameraRange);
      map.getCanvas().removeEventListener("webglcontextlost", lost);
      transmissionLayer.dispose();
      solarPvLayer?.dispose();
      pklPvLayer?.dispose();
      restoreRightDrag();
      map.remove();
    },
  };
}
