import test from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../scripts/generate-demo.mjs";
import {
  parseCSV,
  previewImport,
  withoutDataset,
} from "../src/data/imports.js";
import { validateBundle } from "../src/domain/model.js";

const geo = (properties) =>
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-82.46, 27.94] },
        properties: {
          id: "import-device",
          name: "Imported meter",
          utilityType: "electric",
          assetType: "meter",
          ...properties,
        },
      },
    ],
  });
const preview = (text, filename, current = createDemo()) =>
  previewImport({
    text,
    filename,
    current,
    id: "new-data",
    now: "2026-10-11T00:00:00Z",
  });

test("GeoJSON preview is pure; geometry-only assets are accepted", () => {
  const b = createDemo(),
    before = structuredClone(b),
    p = preview(geo({}), "assets.geojson", b);
  assert.deepEqual(b, before);
  assert.deepEqual(p.errors, []);
  assert.equal(p.summary.assets, 1);
  assert.equal(p.candidate.assets.at(-1).status, "unknown");
  assert.equal(p.candidate.terminals.length, b.terminals.length);
  assert.equal(validateBundle(p.candidate).valid, true);
});
test("GeoJSON rejects collisions, unknown types, invalid coordinates, and legacy CRS", () => {
  assert(
    preview(geo({ id: "substation-01" }), "a.geojson").errors.some((e) =>
      e.includes("duplicate identity"),
    ),
  );
  assert(preview(geo({ assetType: "magic" }), "a.geojson").errors.length);
  assert(
    preview(geo({ utilityType: "water", assetType: "meter" }), "a.geojson")
      .errors.length,
  );
  const bad = JSON.parse(geo({}));
  bad.features[0].geometry.coordinates = [0, 100];
  assert(preview(JSON.stringify(bad), "a.geojson").errors.length);
  bad.crs = { type: "name", properties: { name: "EPSG:3857" } };
  assert(
    preview(JSON.stringify(bad), "a.geojson").errors.some((e) =>
      e.includes("legacy CRS"),
    ),
  );
});
test("CSV handles quotes, CRLF, missing values, phases, and timezone conversion", () => {
  const csv =
    'asset_id,quantity,unit,observed_at,value,phase,quality\r\n"f1-tx0","Power, reactive",kvar,2026-10-11T00:00:00-04:00,10,A,good\r\nf1-tx0,"Power, reactive",kvar,2026-10-11T00:15:00-04:00,,A,missing\r\n';
  assert.equal(parseCSV(csv)[0].quantity, "Power, reactive");
  const p = preview(csv, "readings.csv");
  assert.deepEqual(p.errors, []);
  const observations = p.candidate.observations.slice(-2);
  assert.equal(observations[0].observedAt, "2026-10-11T04:00:00.000Z");
  assert.equal(observations[1].value, null);
  assert.equal(observations[1].quality, "missing");
});
test("CSV rejects unknown assets, bad values, invalid dates, and duplicate observations", () => {
  const header = "asset_id,quantity,unit,observed_at,value\n";
  for (const row of [
    "absent,Voltage,V,2026-10-11T00:00:00Z,5",
    "f1-tx0,Voltage,V,2026-02-30T00:00:00Z,5",
    "f1-tx0,Voltage,V,2026-10-11T00:00:00,5",
    "f1-tx0,Voltage,V,2026-10-11T00:00:00Z,abc",
  ])
    assert(preview(header + row, "a.csv").errors.length);
  const row = "f1-tx0,Temperature,C,2026-10-11T00:00:00Z,5";
  assert(
    preview(header + row + "\n" + row, "a.csv").errors.some((e) =>
      e.includes("duplicate identity"),
    ),
  );
});
test("workspace JSON round trip preserves record identities and relationships in a separate workspace", () => {
  const b = createDemo(),
    p = preview(JSON.stringify(b), "workspace.json");
  assert.deepEqual(p.errors, []);
  assert(p.newWorkspace);
  assert.notEqual(p.candidate.workspace.id, b.workspace.id);
  assert.deepEqual(p.candidate.terminals, b.terminals);
  assert.deepEqual(p.candidate.observations, b.observations);
  assert.deepEqual(
    p.candidate.assets.map((a) => a.id),
    b.assets.map((a) => a.id),
  );
});
test("dataset removal cascades dependent records and leaves the bundle valid", () => {
  const b = createDemo(),
    removed = withoutDataset(b, b.datasets[0].id);
  assert.equal(removed.assets.length, 0);
  assert.equal(removed.observations.length, 0);
  assert.equal(removed.terminals.length, 0);
  assert.equal(removed.eventAssets.length, 0);
  assert.equal(validateBundle(removed).valid, true);
  const added = preview(geo({}), "a.geojson").candidate;
  assert.equal(
    withoutDataset(added, "new-data").assets.length,
    b.assets.length,
  );
});
