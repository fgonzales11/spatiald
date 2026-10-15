import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  PublicLayerProvider,
  PUBLIC_LAYERS,
  TAMPA_BOUNDS,
  createPublicWorkspace,
  mergePublicLayers,
  normalizePublicAsset,
  AreaTooLargeError,
} from "../src/data/public-layers.js";
import { BrowserDataProvider } from "../src/data/provider.js";
import { previewImport } from "../src/data/imports.js";
import { validateBundle } from "../src/domain/model.js";
import { createDemo } from "../scripts/generate-demo.mjs";

const arcFeature = (id) => ({
  attributes: {
    OBJECTID_1: id,
    ID: `source-${id}`,
    OWNER: "Utility",
    STATUS: "IN SERVICE",
    VOLTAGE: 230,
  },
  geometry: {
    paths: [
      [
        [-82.45, 27.94],
        [-82.46, 27.95],
      ],
      [
        [-82.44, 27.96],
        [-82.43, 27.97],
      ],
    ],
  },
});
const gasRecord = (fid) => ({
  fid,
  operator: "Pipeline operator",
  typepipe: "Interstate",
  status: "Operating",
  geo_shape: {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [-82.4, 27.9],
        [-82.5, 28],
      ],
    },
    properties: {},
  },
});
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

test("national tile selection fetches and validates the full original ArcGIS record by identity", async () => {
  const layer = PUBLIC_LAYERS.find((source) => source.id === "public-transmission");
  let response = { spatialReference: { wkid: 4326 }, features: [arcFeature(42)] };
  const provider = new PublicLayerProvider(async (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith("query")) return json({ objectIdField: "OBJECTID_1" });
    assert.equal(u.searchParams.get("objectIds"), "42");
    assert.equal(u.searchParams.get("outFields"), "*");
    assert.equal(u.searchParams.get("outSR"), "4326");
    assert.equal(u.searchParams.has("geometry"), false);
    return json(response);
  });
  const asset = await provider.loadAsset(layer, 42);
  assert.equal(asset.id, "public-transmission:42");
  assert.equal(asset.attributes.nominalVoltageV, 230000);
  assert.equal(asset.geometry.type, "MultiLineString");
  assert.equal(asset.geometry.coordinates.length, 2);
  response = { ...response, features: [arcFeature(43)] };
  await assert.rejects(provider.loadAsset(layer, 42), /unavailable/);
  response = { spatialReference: { wkid: 3857 }, features: [arcFeature(42)] };
  await assert.rejects(provider.loadAsset(layer, 42), /unavailable/);
  await assert.rejects(provider.loadAsset(layer, "42 OR 1=1"), /Invalid source/);
});

test("public start has three implemented sources and no synthetic network or measurements", () => {
  const workspace = createPublicWorkspace();
  assert.equal(validateBundle(workspace).valid, true);
  assert.equal(
    workspace.assets.length +
      workspace.networks.length +
      workspace.terminals.length +
      workspace.observations.length,
    0,
  );
  for (const layer of PUBLIC_LAYERS)
    assert.equal(
      workspace.sources.find((source) => source.id === layer.id)?.adapterStatus,
      "implemented",
    );
  assert(!workspace.sources.some((source) => source.id === "tampa-demo"));
});

test("ArcGIS uses the advertised OID, WGS84 area query, and all result pages", async () => {
  const calls = [];
  const records = Array.from({ length: 5 }, (_, i) => arcFeature(i + 1));
  const provider = new PublicLayerProvider(async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (!u.pathname.endsWith("query"))
      return json({
        objectIdField: "OBJECTID_1",
        maxRecordCount: 2,
        editingInfo: { dataLastEditDate: 1644800158067 },
      });
    assert.equal(u.searchParams.get("inSR"), "4326");
    assert.equal(u.searchParams.get("geometryType"), "esriGeometryEnvelope");
    if (u.searchParams.has("returnCountOnly"))
      return json({ count: records.length });
    assert.equal(u.searchParams.get("outSR"), "4326");
    assert.equal(u.searchParams.get("orderByFields"), "OBJECTID_1 ASC");
    const offset = Number(u.searchParams.get("resultOffset"));
    return json({
      spatialReference: { wkid: 4326 },
      features: records.slice(offset, offset + 2),
    });
  });
  const result = await provider.loadLayer(PUBLIC_LAYERS[1], TAMPA_BOUNDS);
  assert.equal(result.assets.length, 5);
  assert.equal(
    calls.filter((url) => url.searchParams.has("resultOffset")).length,
    3,
  );
  assert.equal(result.assets[0].geometry.type, "MultiLineString");
  assert.equal(result.assets[0].geometry.coordinates.length, 2);
  assert.equal(result.assets[0].attributes.nominalVoltageV, 230000);
  assert.equal(result.assets[0].externalId, "1");
  assert.equal(result.assets[0].attributes.sourceAttributes.ID, "source-1");
  assert.equal(
    validateBundle(mergePublicLayers(createPublicWorkspace(), [result])).valid,
    true,
  );
});

test("gas paging respects the 100-record limit and filters by intersecting geometry", async () => {
  const offsets = [];
  const provider = new PublicLayerProvider(async (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith("records"))
      return json({ metas: { default: { modified: "2025-12-09T03:27:24Z" } } });
    assert.equal(u.searchParams.get("limit"), "100");
    assert.match(
      u.searchParams.get("where"),
      /^intersects\(geo_shape, geom'POLYGON/,
    );
    const offset = Number(u.searchParams.get("offset") || 0);
    offsets.push(offset);
    return json({
      total_count: 205,
      results: Array.from({ length: Math.min(100, 205 - offset) }, (_, i) =>
        gasRecord(offset + i),
      ),
    });
  });
  const result = await provider.loadLayer(PUBLIC_LAYERS[2], TAMPA_BOUNDS);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(result.assets.length, 205);
  assert.equal(result.assets[0].utilityType, "gas");
  assert.equal(result.dataset.sourceUpdatedAt, "2025-12-09T03:27:24.000Z");
});

test("larger gas areas use unrestricted GeoJSON exports without an offset ceiling", async () => {
  let exported = false;
  const provider = new PublicLayerProvider(async (url) => {
    if (url.includes("/records?"))
      return json({ total_count: 1001, results: [gasRecord(0)] });
    if (url.includes("/exports/geojson?")) {
      exported = true;
      return json({
        type: "FeatureCollection",
        features: Array.from({ length: 1001 }, (_, fid) => ({
          type: "Feature",
          geometry: gasRecord(fid).geo_shape.geometry,
          properties: { fid, operator: "Operator", status: "Operating" },
        })),
      });
    }
    return json({});
  });
  const result = await provider.loadLayer(PUBLIC_LAYERS[2], TAMPA_BOUNDS);
  assert(exported);
  assert.equal(result.assets.length, 1001);
});

test("large areas, source errors, duplicate pages, and unsupported CRS fail explicitly", async () => {
  for (const kind of ["large", "source-error", "duplicate", "crs"]) {
    const provider = new PublicLayerProvider(async (url) => {
      const u = new URL(url);
      if (!u.pathname.endsWith("query"))
        return json({ objectIdField: "OBJECTID_1", maxRecordCount: 1 });
      if (kind === "source-error")
        return json({ error: { message: "Access denied" } });
      if (u.searchParams.has("returnCountOnly"))
        return json({ count: kind === "large" ? 100000 : 2 });
      return json({
        spatialReference: { wkid: kind === "crs" ? 3857 : 4326 },
        features: [arcFeature(1)],
      });
    });
    await assert.rejects(
      provider.loadLayer(PUBLIC_LAYERS[1], TAMPA_BOUNDS),
      kind === "large"
        ? AreaTooLargeError
        : kind === "source-error"
          ? /Access denied/
          : kind === "duplicate"
            ? /duplicate identities/
            : /WGS84/,
    );
  }
});

test("unknown voltage sentinels and incomplete geometry do not invent engineering data", async () => {
  const feature = arcFeature(1);
  feature.attributes.VOLTAGE = -999999;
  const asset = normalizePublicAsset(PUBLIC_LAYERS[1], feature, "OBJECTID_1");
  assert.equal(asset.attributes.nominalVoltageV, undefined);
  assert.equal(asset.attributes.sourceAttributes.VOLTAGE, -999999);
  const provider = new PublicLayerProvider(async (url) =>
    url.includes("/records?")
      ? json({
          total_count: 2,
          results: [gasRecord(1), { ...gasRecord(2), geo_shape: null }],
        })
      : json({}),
  );
  const result = await provider.loadLayer(PUBLIC_LAYERS[2], TAMPA_BOUNDS);
  assert.equal(result.assets.length, 1);
  assert.equal(result.rejected.length, 1);
  const bundle = mergePublicLayers(createPublicWorkspace(), [result]);
  assert.equal(bundle.terminals.length + bundle.networkMemberships.length, 0);
});

test("refresh preserves imported measurements, their asset references, and selected records", () => {
  const asset = normalizePublicAsset(PUBLIC_LAYERS[2], gasRecord(1));
  const dataset = {
    id: PUBLIC_LAYERS[2].id,
    workspaceId: asset.workspaceId,
    sourceId: PUBLIC_LAYERS[2].id,
    name: "Gas",
    version: "1",
    acquiredAt: "2026-10-11T00:00:00Z",
    isSynthetic: false,
    isRemote: true,
    bounds: [...TAMPA_BOUNDS],
    queryBounds: [...TAMPA_BOUNDS],
    crs: "EPSG:4326",
    schemaVersion: 1,
  };
  const base = mergePublicLayers(createPublicWorkspace(), [
    { layer: PUBLIC_LAYERS[2], dataset, assets: [asset] },
  ]);
  const preview = previewImport({
    filename: "pressure.csv",
    current: base,
    text: `asset_id,quantity,unit,observed_at,value\n${asset.id},Pressure,kPa,2026-10-11T00:00:00Z,300\n`,
  });
  assert.deepEqual(preview.errors, []);
  const refreshed = mergePublicLayers(preview.candidate, [
    { layer: PUBLIC_LAYERS[2], dataset, assets: [] },
  ]);
  assert.equal(refreshed.assets[0].id, asset.id);
  assert.equal(refreshed.observations.length, 1);
  assert.equal(validateBundle(refreshed).valid, true);
});

test("migration removes the cached fake network while preserving separately imported assets", async () => {
  const provider = new BrowserDataProvider(new IDBFactory());
  await provider.initialize(createDemo());
  const preview = previewImport({
    filename: "real.geojson",
    current: await provider.loadWorkspace("tampa-electric"),
    text: JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-82.4, 27.9] },
          properties: {
            id: "my-real-asset",
            name: "My imported asset",
            utilityType: "electric",
            assetType: "substation",
          },
        },
      ],
    }),
  });
  await provider.importDataset(preview);
  await provider.initialize(createPublicWorkspace());
  await provider.retireSyntheticDemo();
  const remaining = await provider.loadWorkspace("tampa-electric");
  assert.deepEqual(
    remaining.assets.map((asset) => asset.id),
    ["my-real-asset"],
  );
  assert.equal(
    remaining.networks.length +
      remaining.nodes.length +
      remaining.terminals.length +
      remaining.observations.length,
    0,
  );
  assert(!remaining.datasets.some((dataset) => dataset.isSynthetic));
  provider.dispose();
});
