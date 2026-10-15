import sources from "../../config/sources.json" with { type: "json" };
import { assertBundle, boundsOf, geometryErrors } from "../domain/model.js";

export const PUBLIC_WORKSPACE_ID = "public-utility-infrastructure";
export const PUBLIC_DATA_VERSION = "public-layers-v1";
export const TAMPA_BOUNDS = [-82.908, 27.648, -82.008, 28.248];
export const TAMPA_CAMERA = { center: [-82.458, 27.948], zoom: 10.6 };
export const PUBLIC_LAYERS = [
  {
    id: "public-substations",
    name: "Substations",
    assetType: "substation",
    utilityType: "electric",
    adapter: "arcgis",
    endpoint:
      "https://services6.arcgis.com/OO2s4OoyCZkYJ6oE/arcgis/rest/services/Substations/FeatureServer/0",
  },
  {
    id: "public-transmission",
    name: "Electric transmission",
    assetType: "transmission_line",
    utilityType: "electric",
    adapter: "arcgis",
    endpoint:
      "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0",
  },
  {
    id: "public-gas-pipelines",
    name: "Natural gas pipelines",
    assetType: "gas_main",
    utilityType: "gas",
    adapter: "ods",
    endpoint:
      "https://openenergyhub.ornl.gov/api/explore/v2.1/catalog/datasets/naturalgas_interintrastate_pipelines_us_eia",
  },
];
export const MAX_AREA_FEATURES = 4000;

export function createPublicWorkspace() {
  const [w, s, e, n] = TAMPA_BOUNDS;
  return assertBundle({
    schemaVersion: 1,
    workspace: {
      id: PUBLIC_WORKSPACE_ID,
      name: "United States · Public infrastructure",
      timezone: "America/New_York",
      serviceArea: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    },
    sources: structuredClone(sources),
    datasets: [],
    networks: [],
    assets: [],
    networkMemberships: [],
    nodes: [],
    terminals: [],
    series: [],
    observations: [],
    events: [],
    eventAssets: [],
  });
}

export class AreaTooLargeError extends Error {
  constructor(count) {
    super(
      `${count.toLocaleString()} features in this area. Zoom in to load this layer (up to ${MAX_AREA_FEATURES.toLocaleString()} per area).`,
    );
    this.name = "AreaTooLargeError";
    this.count = count;
  }
}

export function validBounds(bounds) {
  return (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every(Number.isFinite) &&
    bounds[0] >= -180 &&
    bounds[2] <= 180 &&
    bounds[1] >= -90 &&
    bounds[3] <= 90 &&
    bounds[0] < bounds[2] &&
    bounds[1] < bounds[3]
  );
}
export function containsBounds(outer, inner) {
  return (
    validBounds(outer) &&
    validBounds(inner) &&
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3]
  );
}
export function paddedBounds(bounds) {
  if (!validBounds(bounds))
    throw new Error("A valid WGS84 map area is required.");
  const dx = (bounds[2] - bounds[0]) * 0.2,
    dy = (bounds[3] - bounds[1]) * 0.2;
  return [
    Math.max(-180, bounds[0] - dx),
    Math.max(-90, bounds[1] - dy),
    Math.min(180, bounds[2] + dx),
    Math.min(90, bounds[3] + dy),
  ];
}
const utc = (value) => {
  const date = new Date(value);
  return value != null && Number.isFinite(+date)
    ? date.toISOString()
    : undefined;
};
const present = (value) =>
  value != null &&
  !/^(UNKNOWN.*|NOT AVAILABLE|N\/A|NONE)$/i.test(String(value).trim()) &&
  String(value).trim() !== "";
const operatingStatus = (value) =>
  /^(IN SERVICE|OPERATING|OPERATIONAL|ACTIVE)$/i.test(value || "")
    ? "normal"
    : /^(OUT OF SERVICE|INACTIVE|ABANDONED|RETIRED)$/i.test(value || "")
      ? "out_of_service"
      : "unknown";

export function arcgisGeometry(geometry) {
  if (!geometry) return null;
  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y))
    return { type: "Point", coordinates: [geometry.x, geometry.y] };
  if (Array.isArray(geometry.paths)) {
    const paths = geometry.paths.map((path) => path.map((p) => p.slice(0, 2)));
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0] }
      : { type: "MultiLineString", coordinates: paths };
  }
  return null;
}

export function normalizePublicAsset(
  layer,
  feature,
  objectIdField = "OBJECTID",
) {
  const p = layer.adapter === "arcgis" ? feature.attributes : feature;
  const identity = layer.adapter === "arcgis" ? p?.[objectIdField] : p?.fid;
  if (identity == null || String(identity).trim() === "")
    throw new Error("Source record has no stable identifier.");
  const geometry =
    layer.adapter === "arcgis"
      ? arcgisGeometry(feature.geometry)
      : (p.geo_shape?.geometry ?? p.geo_shape);
  if (geometryErrors(geometry).length)
    throw new Error(`Source record ${identity} has no valid WGS84 geometry.`);
  const sourceAttributes = Object.fromEntries(
    Object.entries(p).filter(
      ([key]) => !["geo_shape", "geo_point_2d"].includes(key),
    ),
  );
  const attributes = {
    sourceAttributes,
    publishedStatus: p.STATUS ?? p.status ?? "Not supplied",
  };
  let name;
  if (layer.assetType === "substation") {
    name = present(p.NAME)
      ? p.NAME
      : `Unnamed substation · ${p.ID ?? identity}`;
    if (p.MAX_VOLT > 0) attributes.maximumVoltageKv = p.MAX_VOLT;
    if (p.MIN_VOLT > 0) attributes.minimumVoltageKv = p.MIN_VOLT;
    if (present(p.CITY)) attributes.city = p.CITY;
    if (present(p.STATE)) attributes.state = p.STATE;
  } else if (layer.assetType === "transmission_line") {
    name = [
      present(p.OWNER) ? p.OWNER : "Transmission line",
      p.ID ?? identity,
    ].join(" · ");
    if (p.VOLTAGE > 0) attributes.nominalVoltageV = p.VOLTAGE * 1000;
    if (present(p.OWNER)) attributes.owner = p.OWNER;
    if (present(p.TYPE)) attributes.construction = p.TYPE;
    if (present(p.SUB_1)) attributes.publishedFromSubstation = p.SUB_1;
    if (present(p.SUB_2)) attributes.publishedToSubstation = p.SUB_2;
  } else {
    name = `${present(p.operator) ? p.operator : "Natural gas pipeline"} · ${identity}`;
    if (present(p.operator)) attributes.operator = p.operator;
    if (present(p.typepipe)) attributes.pipelineType = p.typepipe;
  }
  return {
    id: `${layer.id}:${identity}`,
    workspaceId: PUBLIC_WORKSPACE_ID,
    datasetId: layer.id,
    externalId: String(identity),
    utilityType: layer.utilityType,
    assetType: layer.assetType,
    name: String(name),
    geometry,
    status: operatingStatus(p.STATUS ?? p.status),
    attributes,
  };
}

/** Read-only public APIs. Each area load is complete and ordered, never a silent first page. */
export class PublicLayerProvider {
  constructor(
    fetcher = (...args) => globalThis.fetch(...args),
    { maxFeatures = MAX_AREA_FEATURES } = {},
  ) {
    this.fetcher = fetcher;
    this.maxFeatures = maxFeatures;
    this.metadata = new Map();
  }
  async json(url, signal) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
      : AbortSignal.timeout(25000);
    const response = await this.fetcher(url, { signal: requestSignal });
    if (!response.ok)
      throw new Error(
        `Source request failed (${response.status}). Retry this layer.`,
      );
    const json = await response.json();
    if (!json || typeof json !== "object")
      throw new Error("Source returned an invalid JSON response.");
    if (json.error || json.error_code)
      throw new Error(
        json.error?.message || json.message || "Source query failed.",
      );
    return json;
  }
  async getMetadata(layer, signal) {
    if (this.metadata.has(layer.id)) return this.metadata.get(layer.id);
    const data = await this.json(
      layer.adapter === "arcgis" ? `${layer.endpoint}?f=json` : layer.endpoint,
      signal,
    );
    this.metadata.set(layer.id, data);
    return data;
  }
  async loadAsset(layer, objectId, { signal } = {}) {
    if (layer.adapter !== "arcgis" || !/^\d+$/.test(String(objectId))) throw new Error("Invalid source record identifier.");
    const metadata = await this.getMetadata(layer, signal);
    const page = await this.json(`${layer.endpoint}/query?${new URLSearchParams({
      f: "json", objectIds: String(objectId), outFields: "*", outSR: "4326", returnGeometry: "true",
    })}`, signal);
    if (page.spatialReference?.wkid !== 4326 || page.features?.length !== 1
      || String(page.features[0].attributes?.[metadata.objectIdField]) !== String(objectId))
      throw new Error("The selected transmission source record is unavailable.");
    const asset = normalizePublicAsset(layer, page.features[0], metadata.objectIdField);
    asset.attributes.sourceFetchedAt = new Date().toISOString();
    return asset;
  }
  async loadLayer(layer, bounds, { signal, onProgress = () => {} } = {}) {
    if (!validBounds(bounds)) throw new Error("A valid map area is required.");
    const metadata = await this.getMetadata(layer, signal);
    let records = [],
      total = 0,
      objectIdField;
    if (layer.adapter === "arcgis") {
      objectIdField =
        metadata.objectIdField ??
        metadata.fields?.find((field) => field.type === "esriFieldTypeOID")
          ?.name;
      if (!objectIdField)
        throw new Error("ArcGIS layer has no object identifier.");
      const area = {
        xmin: bounds[0],
        ymin: bounds[1],
        xmax: bounds[2],
        ymax: bounds[3],
        spatialReference: { wkid: 4326 },
      };
      const params = new URLSearchParams({
        f: "json",
        where: "1=1",
        geometry: JSON.stringify(area),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
      });
      const countParams = new URLSearchParams(params);
      countParams.set("returnCountOnly", "true");
      const count = await this.json(
        `${layer.endpoint}/query?${countParams}`,
        signal,
      );
      total = count.count;
      if (!Number.isInteger(total) || total < 0)
        throw new Error("Source did not return a valid feature count.");
      if (total > this.maxFeatures) throw new AreaTooLargeError(total);
      params.set("outFields", "*");
      params.set("outSR", "4326");
      params.set("returnGeometry", "true");
      params.set("orderByFields", `${objectIdField} ASC`);
      params.set(
        "resultRecordCount",
        String(Math.min(metadata.maxRecordCount || 1000, 2000)),
      );
      while (records.length < total) {
        params.set("resultOffset", String(records.length));
        const page = await this.json(
          `${layer.endpoint}/query?${params}`,
          signal,
        );
        if (!Array.isArray(page.features) || !page.features.length)
          throw new Error(
            "Source paging stopped before the complete area was returned. Retry this layer.",
          );
        if (
          page.spatialReference?.wkid !== 4326 &&
          page.spatialReference?.latestWkid !== 4326
        )
          throw new Error("Source did not return WGS84 geometry.");
        records.push(...page.features);
        if (records.length > this.maxFeatures)
          throw new AreaTooLargeError(records.length);
        onProgress(records.length, total);
      }
    } else {
      const [w, s, e, n] = bounds;
      const where = `intersects(geo_shape, geom'POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))')`;
      const params = new URLSearchParams({
        where,
        limit: "100",
        order_by: "fid",
      });
      const first = await this.json(
        `${layer.endpoint}/records?${params}`,
        signal,
      );
      total = first.total_count;
      if (
        !Number.isInteger(total) ||
        total < 0 ||
        !Array.isArray(first.results)
      )
        throw new Error("Gas source returned an invalid record page.");
      if (total > this.maxFeatures) throw new AreaTooLargeError(total);
      records = first.results;
      // Exports avoid the records API's offset ceiling and excessive small-page requests.
      if (total > 1000) {
        const exported = await this.json(
          `${layer.endpoint}/exports/geojson?${new URLSearchParams({ where })}`,
          signal,
        );
        if (
          exported.type !== "FeatureCollection" ||
          !Array.isArray(exported.features)
        )
          throw new Error("Gas source returned an invalid GeoJSON export.");
        records = exported.features.map((feature) => ({
          ...feature.properties,
          geo_shape: feature,
        }));
      } else
        while (records.length < total) {
          params.set("offset", String(records.length));
          const page = await this.json(
            `${layer.endpoint}/records?${params}`,
            signal,
          );
          if (!Array.isArray(page.results) || !page.results.length)
            throw new Error(
              "Gas source paging stopped early. Retry this layer.",
            );
          records.push(...page.results);
          onProgress(records.length, total);
        }
      if (records.length > this.maxFeatures)
        throw new AreaTooLargeError(records.length);
    }
    const ids = new Set(),
      assets = [],
      rejected = [];
    const acquiredAt = new Date().toISOString();
    for (const record of records) {
      const identity =
        layer.adapter === "arcgis"
          ? record.attributes?.[objectIdField]
          : record.fid;
      if (identity != null && ids.has(String(identity)))
        throw new Error(
          "Source returned duplicate identities. Retry this layer.",
        );
      if (identity != null) ids.add(String(identity));
      try {
        const asset = normalizePublicAsset(layer, record, objectIdField);
        asset.attributes.sourceFetchedAt = acquiredAt;
        assets.push(asset);
      } catch (error) {
        rejected.push(error.message);
      }
    }
    const updatedAt =
      layer.adapter === "arcgis"
        ? utc(
            metadata.editingInfo?.dataLastEditDate ??
              metadata.editingInfo?.lastEditDate,
          )
        : utc(metadata.metas?.default?.modified);
    const dataset = {
      id: layer.id,
      workspaceId: PUBLIC_WORKSPACE_ID,
      sourceId: layer.id,
      name: layer.name,
      version: updatedAt || "published",
      acquiredAt,
      isSynthetic: false,
      isRemote: true,
      queryBounds: [...bounds],
      bounds: assets.length ? boundsOf(assets) : [...bounds],
      crs: "EPSG:4326",
      schemaVersion: 1,
      ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
    };
    return { layer, dataset, assets, total, rejected };
  }
}

/** Replace only successful source snapshots; retain imports and a selected asset outside the new area. */
export function mergePublicLayers(bundle, results, selectedId) {
  const next = structuredClone(bundle);
  const protectedAssets = new Set([
    selectedId,
    ...bundle.series.map((series) => series.assetId),
    ...bundle.terminals.map((terminal) => terminal.assetId),
    ...bundle.eventAssets.map((event) => event.assetId),
    ...bundle.networkMemberships.map((membership) => membership.assetId),
  ]);
  for (const result of results) {
    const pinned = next.assets.filter(
      (asset) =>
        protectedAssets.has(asset.id) && asset.datasetId === result.layer.id,
    );
    const assets = [...result.assets];
    for (const asset of pinned)
      if (!assets.some((current) => current.id === asset.id))
        assets.push(asset);
    next.assets = [
      ...next.assets.filter((asset) => asset.datasetId !== result.layer.id),
      ...assets,
    ];
    next.datasets = [
      ...next.datasets.filter((dataset) => dataset.id !== result.layer.id),
      {
        ...result.dataset,
        bounds: assets.length ? boundsOf(assets) : result.dataset.bounds,
      },
    ];
  }
  return assertBundle(next);
}
