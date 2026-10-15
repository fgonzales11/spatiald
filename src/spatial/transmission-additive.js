import { PathLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { MVTLayer } from "@deck.gl/geo-layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import { geometryPaths } from "../domain/model.js";
import { CARTO_TRANSMISSION_RGBA } from "./infrastructure-style.js";

export function transmissionPaths(assets) {
  return assets.flatMap((asset) => {
    if (asset.assetType !== "transmission_line") return [];
    return geometryPaths(asset.geometry).flatMap((coordinates) => {
      const path = [];
      for (const coordinate of coordinates) {
        const previous = path.at(-1);
        if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1])
          path.push(coordinate.slice(0, 2));
      }
      return path.length > 1 ? [{ assetId: asset.id, path }] : [];
    });
  });
}

const additiveParameters = {
  depthCompare: "always", depthWriteEnabled: false, blend: true,
  blendColorOperation: "add", blendAlphaOperation: "add",
  blendColorSrcFactor: "src-alpha", blendColorDstFactor: "dst-alpha",
  blendAlphaSrcFactor: "src-alpha", blendAlphaDstFactor: "dst-alpha",
};
const localFilter = new DataFilterExtension({ filterSize: 1 });
class NationalTransmissionLayer extends MVTLayer {
  static layerName = "NationalTransmissionLayer";
  getTileData(props) {
    const { x, y, z } = props.index;
    if (!this.props.populatedTiles.has(`${z}/${x}/${y}`)) return Promise.resolve(null);
    return super.getTileData(props);
  }
}

export function createAdditiveTransmissionLayer({ workerUrl, onError } = {}) {
  let map, previousAssets = [], paths = [], baseLayers = [], extraLayers = [];
  const overlay = new MapLibreOverlay({ interleaved: true, layers: [] });
  const sync = () => overlay.setProps({layers:[...baseLayers,...extraLayers]});
  return {
    attach(nextMap) {
      if (map) return;
      map = nextMap;
      map.addControl(overlay);
    },
    setData({ assets, selectedId, connectedIds = [], nationalTransmission, transmissionVisible = true }) {
      // Selection changes update attributes without rebuilding the joined path geometry.
      if (assets.length !== previousAssets.length || assets.some((asset, i) => asset !== previousAssets[i])) {
        previousAssets = assets;
        paths = transmissionPaths(assets);
      }
      const neighbors = new Set(connectedIds);
      const localIds = new Set(paths.map((line) => line.assetId));
      const national = nationalTransmission && transmissionVisible && new NationalTransmissionLayer({
        id: "tb-national-transmission", beforeId: "tb-substations",
        data: nationalTransmission.tileUrl,
        populatedTiles: nationalTransmission.populatedTiles,
        minZoom: nationalTransmission.minZoom, maxZoom: nationalTransmission.maxZoom,
        maxCacheByteSize: 64 * 1024 * 1024, maxRequests: 6,
        // Binary geometry travels directly from a bundled worker to GPU buffers.
        binary: true, loadOptions: workerUrl ? { mvt: { workerUrl } } : { worker: false },
        filled: false, stroked: true, pickable: true, uniqueIdProperty: "id",
        getLineColor: CARTO_TRANSMISSION_RGBA, getLineWidth: 1,
        lineWidthUnits: "pixels", lineWidthMinPixels: 1,
        lineJointRounded: false, lineCapRounded: false, lineMiterLimit: 4,
        parameters: additiveParameters,
        extensions: [localFilter], filterRange: [1, 1],
        getFilterValue: (feature) => localIds.has(feature.properties.id) ? 0 : 1,
        updateTriggers: { getFilterValue: [...localIds] },
        onTileError: (error) => onError?.(`Nationwide transmission tile failed: ${error.message}`),
      });
      baseLayers = [national, new PathLayer({
        id: "tb-transmission-additive",
        beforeId: "tb-substations",
        data: paths,
        getPath: (line) => line.path,
        getColor: (line) => line.assetId === selectedId ? [255, 255, 255, 255]
          : neighbors.has(line.assetId) ? [101, 228, 245, 255] : CARTO_TRANSMISSION_RGBA,
        getWidth: (line) => line.assetId === selectedId ? 3 : neighbors.has(line.assetId) ? 2 : 1,
        widthUnits: "pixels",
        widthMinPixels: 1,
        jointRounded: false,
        capRounded: false,
        miterLimit: 4,
        antialiasing: true,
        pickable: false, // MapLibre's retained line geometry provides asset selection.
        updateTriggers: { getColor: [selectedId, ...connectedIds], getWidth: [selectedId, ...connectedIds] },
        parameters: additiveParameters,
      })]; sync();
    },
    setExtraLayers(layers) { extraLayers = layers; sync(); },
    prepareStyleChange() {
      // MapLibre emits styledata before our utility layers have been restored.
      // Keep the deck instance and cached tiles, but defer its layer group until then.
      overlay.setProps({ layers: [] });
    },
    pick(point) {
      return overlay.pickObject({ x: point.x, y: point.y, radius: 4, layerIds: ["tb-national-transmission"] })?.object;
    },
    dispose() {
      if (map) map.removeControl(overlay);
      else overlay.finalize();
      map = null;
    },
  };
}
