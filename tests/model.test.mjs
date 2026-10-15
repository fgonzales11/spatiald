import test from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../scripts/generate-demo.mjs";
import {
  validateBundle,
  connectedAssets,
  assetNetworks,
  geometryErrors,
  geometryPaths,
} from "../src/domain/model.js";
import { CATEGORIES } from "../src/domain/types.js";

test("demo is deterministic, relationally valid, and covers the source categories", () => {
  const demo = createDemo();
  assert.deepEqual(createDemo(), demo);
  assert.equal(validateBundle(demo).valid, true);
  assert.equal(demo.networks.length, 2);
  assert(demo.assets.length < 500);
  assert.equal(demo.observations.length, 2880);
  assert.deepEqual(
    new Set(demo.sources.flatMap((s) => s.categories)),
    new Set(CATEGORIES),
  );
});

test("shared assets and multi-terminal transformers retain explicit connectivity", () => {
  const b = createDemo();
  assert.equal(assetNetworks(b, "substation-01").length, 2);
  assert.equal(b.terminals.filter((t) => t.assetId === "f1-tx0").length, 2);
  assert(connectedAssets(b, "f1-tx0").some((a) => a.id === "f1-m0-0"));
  const pole = b.assets.find((a) => a.id === "f1-pole0");
  assert.deepEqual(
    pole.geometry,
    b.assets.find((a) => a.id === "f1-tx0").geometry,
  );
  assert.deepEqual(
    connectedAssets(b, pole.id),
    [],
    "colocation does not imply topology",
  );
});

test("invalid identities, foreign keys, and utility compatibility are rejected", () => {
  const b = createDemo();
  b.assets.push(structuredClone(b.assets[0]));
  assert(
    validateBundle(b).errors.some((e) => e.includes("duplicate identity")),
  );
  const b2 = createDemo();
  b2.terminals[0].nodeId = "absent";
  assert(validateBundle(b2).errors.some((e) => e.includes("unresolved nodes")));
  const b3 = createDemo();
  b3.nodes[0].utilityType = "gas";
  assert(
    validateBundle(b3).errors.some((e) => e.includes("utility types differ")),
  );
  const b4 = createDemo();
  b4.series[0].terminalId = "f2-tx0:t1";
  assert(validateBundle(b4).errors.some((e) => e.includes("another asset")));
});

test("geometry validates structure, coordinates, and polygon closure", () => {
  assert.equal(
    geometryErrors({ type: "Point", coordinates: [-82, 28] }).length,
    0,
  );
  for (const geometry of [
    { type: "Point", coordinates: [-200, 28] },
    { type: "LineString", coordinates: [[-82, 28]] },
    {
      type: "Polygon",
      coordinates: [
        [
          [-82, 28],
          [-81, 28],
          [-81, 29],
          [-82, 29],
        ],
      ],
    },
    { type: "Point", coordinates: [NaN, 28] },
  ])
    assert(geometryErrors(geometry).length);
});

test("multipart display paths retain separate lines and polygon rings", () => {
  const lines = [
    [
      [-82, 28],
      [-81, 28],
    ],
    [
      [-80, 29],
      [-79, 29],
    ],
  ];
  assert.deepEqual(
    geometryPaths({ type: "MultiLineString", coordinates: lines }),
    lines,
  );
  const rings = [
    [
      [-82, 28],
      [-81, 28],
      [-81, 29],
      [-82, 28],
    ],
    [
      [-80, 29],
      [-79, 29],
      [-79, 30],
      [-80, 29],
    ],
  ];
  assert.deepEqual(
    geometryPaths({ type: "MultiPolygon", coordinates: rings.map((r) => [r]) }),
    rings,
  );
});

test("timestamps, unknown heights, missing observations, and units remain explicit", () => {
  const b = createDemo();
  assert(
    b.assets.every(
      (a) => a.geometry.coordinates.length !== 3 || a.geometry.type !== "Point",
    ),
  );
  assert(
    b.observations.some((o) => o.value === null && o.quality === "missing"),
  );
  assert(
    b.series.some((s) => s.unit === "kW") &&
      b.series.some((s) => s.unit === "V"),
  );
  b.observations[0].observedAt = "2026-02-30T12:00:00Z";
  assert.equal(validateBundle(b).valid, false);
});

for (const [utilityType, assetType, quantity, unit] of [
  ["water", "valve", "Flow", "m3/h"],
  ["gas", "regulator", "Pressure", "kPa"],
]) {
  test(`${utilityType} supports the same model without electrical phase assumptions`, () => {
    const b = createDemo();
    for (const field of [
      "assets",
      "nodes",
      "terminals",
      "networkMemberships",
      "series",
      "observations",
      "events",
      "eventAssets",
    ])
      b[field] = [];
    b.networks = [
      {
        id: "network",
        workspaceId: b.workspace.id,
        utilityType,
        name: "District",
        kind: "district",
      },
    ];
    const common = {
      workspaceId: b.workspace.id,
      datasetId: b.datasets[0].id,
      utilityType,
    };
    b.assets = [
      {
        id: "asset",
        ...common,
        externalId: "external",
        assetType,
        name: "Sample device",
        geometry: { type: "Point", coordinates: [-82.46, 27.94] },
        status: "unknown",
        attributes: { pressureKpa: 200, diameterMm: 100, material: "Steel" },
      },
    ];
    b.nodes = [
      { id: "node", ...common, geometry: b.assets[0].geometry, attributes: {} },
    ];
    b.terminals = [
      { id: "terminal", assetId: "asset", nodeId: "node", label: "Inlet" },
    ];
    b.networkMemberships = [{ assetId: "asset", networkId: "network" }];
    b.series = [
      {
        id: "series",
        assetId: "asset",
        datasetId: b.datasets[0].id,
        quantity,
        unit,
      },
    ];
    b.observations = [
      {
        seriesId: "series",
        datasetId: b.datasets[0].id,
        observedAt: "2026-09-19T12:00:00Z",
        value: 20,
        quality: "synthetic",
      },
    ];
    assert.deepEqual(validateBundle(b), { valid: true, errors: [] });
  });
}
