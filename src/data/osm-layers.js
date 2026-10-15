import { geometryErrors } from "../domain/model.js";

export const OSM_BASE = "data/osm/tampa-bay/";

/** Static context data is independent of the utility asset registry and topology. */
export class OsmLayerProvider {
  constructor({
    fetcher = (...args) => globalThis.fetch(...args),
    baseUrl = "/",
  } = {}) {
    this.fetcher = fetcher;
    this.baseUrl = baseUrl + OSM_BASE;
    this.cache = new Map();
    this.pending = new Map();
  }
  async json(file) {
    const response = await this.fetcher(this.baseUrl + file);
    if (!response.ok)
      throw new Error(
        `Local OSM data could not load (${response.status}). Retry the layer.`,
      );
    return response.json();
  }
  async manifest() {
    const manifest = await this.json("manifest.json");
    if (
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.layers) ||
      !Array.isArray(manifest.bounds) ||
      manifest.bounds.length !== 4 ||
      !manifest.bounds.every(Number.isFinite)
    )
      throw new Error(
        "The local OSM manifest is invalid. Regenerate the OSM layers.",
      );
    return manifest;
  }
  async loadLayer(layer) {
    if (this.cache.has(layer.id)) return this.cache.get(layer.id);
    if (this.pending.has(layer.id)) return this.pending.get(layer.id);
    const request = this.readLayer(layer);
    this.pending.set(layer.id, request);
    try {
      return await request;
    } finally {
      this.pending.delete(layer.id);
    }
  }
  async readLayer(layer) {
    if (!/^[a-z]+\.geojson$/.test(layer.file))
      throw new Error("Invalid local OSM layer location.");
    const collection = await this.json(layer.file);
    if (
      collection.type !== "FeatureCollection" ||
      !Array.isArray(collection.features) ||
      collection.features.length !== layer.count
    )
      throw new Error(
        "The local OSM layer is incomplete. Regenerate the OSM layers.",
      );
    const identities = new Set();
    for (const feature of collection.features) {
      if (
        feature.type !== "Feature" ||
        !/^osm:(node|way|relation):\d+$/.test(feature.properties?.id) ||
        feature.properties.group !== layer.id ||
        identities.has(feature.properties.id) ||
        geometryErrors(feature.geometry).length
      )
        throw new Error(
          "Invalid or duplicate local OSM feature. Regenerate the OSM layers.",
        );
      identities.add(feature.properties.id);
    }
    this.cache.set(layer.id, collection);
    return collection;
  }
}

export function visibleOsmCount(state) {
  return Object.entries(state.osmData || {}).reduce(
    (count, [id, collection]) =>
      count + (state.osmLayers[id] ? collection.features.length : 0),
    0,
  );
}

export function selectedOsmFeature(state) {
  if (!state.selectedOsmId) return null;
  for (const collection of Object.values(state.osmData || {})) {
    const feature = collection.features.find(
      (feature) => feature.properties.id === state.selectedOsmId,
    );
    if (feature) return feature;
  }
  return null;
}
