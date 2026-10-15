import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sources from "../config/sources.json" with { type: "json" };
import { assertBundle, boundsOf } from "../src/domain/model.js";

const directory = fileURLToPath(
  new URL("../tests/fixtures/tampa-electric/", import.meta.url),
);
const datasetId = "tampa-electric-v1";
const workspaceId = "tampa-electric";
const point = (coordinates) => ({ type: "Point", coordinates });
const rounded = (v, p = 6) => Number(v.toFixed(p));

export function createDemo() {
  const bundle = {
    schemaVersion: 1,
    workspace: {
      id: workspaceId,
      name: "Tampa Bay · Electric",
      timezone: "America/New_York",
      serviceArea: {
        type: "Polygon",
        coordinates: [
          [
            [-82.476, 27.922],
            [-82.447, 27.922],
            [-82.447, 27.953],
            [-82.476, 27.953],
            [-82.476, 27.922],
          ],
        ],
      },
    },
    sources: [
      {
        id: "tampa-demo",
        name: "Synthetic test fixture",
        custodian: "Geobound tests",
        categories: [
          "Foundational Geospatial Data",
          "Time-Series & Historical Data",
          "Infrastructure & Operational Data",
        ],
        location: "tests/fixtures/tampa-electric/",
        format: "Twin JSON",
        attribution: "Geobound test fixture",
        licenseUrl: "",
        authentication: "none",
        configurationState: "bundled",
        adapterStatus: "implemented",
      },
      ...structuredClone(sources),
    ],
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
  };
  function node(id, coordinates, voltage = 12470) {
    bundle.nodes.push({
      id,
      workspaceId,
      datasetId,
      utilityType: "electric",
      geometry: point(coordinates),
      attributes: { nominalVoltageV: voltage },
    });
    return id;
  }
  function asset(
    id,
    assetType,
    name,
    geometry,
    networkId,
    nodeIds = [],
    attributes = {},
  ) {
    const record = {
      id,
      workspaceId,
      datasetId,
      externalId: id.toUpperCase(),
      utilityType: "electric",
      assetType,
      name,
      geometry,
      status: "normal",
      attributes: {
        phases: ["A", "B", "C", "N"],
        nominalVoltageV: 12470,
        ...attributes,
      },
    };
    bundle.assets.push(record);
    bundle.networkMemberships.push({ networkId, assetId: id });
    nodeIds.forEach((nodeId, i) =>
      bundle.terminals.push({
        id: `${id}:t${i + 1}`,
        assetId: id,
        nodeId,
        label: nodeIds.length === 2 ? (i ? "Output" : "Input") : "Connection",
        phases: record.attributes.phases,
      }),
    );
    return record;
  }
  const origin = [-82.4642, 27.9391];
  node("ss-bus", origin);
  for (let f = 0; f < 2; f++) {
    const networkId = `feeder-${f + 1}`;
    bundle.networks.push({
      id: networkId,
      workspaceId,
      utilityType: "electric",
      name: f ? "Davis · F-02" : "Bayshore · F-01",
      kind: "feeder",
    });
    if (!f)
      asset(
        "substation-01",
        "substation",
        "Bayshore Substation",
        point(origin),
        networkId,
        ["ss-bus"],
        { ratingKva: 20000 },
      );
    else
      bundle.networkMemberships.push({ networkId, assetId: "substation-01" });
    let previousNode = "ss-bus",
      previousPoint = origin;
    for (let i = 0; i < 12; i++) {
      const sign = f ? 1 : -1;
      const coordinates = [
        rounded(
          origin[0] +
            sign * (0.00055 + i * 0.00042) +
            Math.sin(i * 0.9) * 0.00016,
        ),
        rounded(origin[1] + (f ? -1 : 1) * (0.0007 + i * 0.00061)),
      ];
      const primary = node(`f${f + 1}-n${i}`, coordinates);
      const secondary = node(
        `f${f + 1}-lv${i}`,
        [coordinates[0] + 0.00011, coordinates[1] + 0.00004],
        240,
      );
      const cable = i % 4 === 3;
      asset(
        `f${f + 1}-line${i}`,
        cable ? "underground_cable" : "overhead_line",
        `${cable ? "Cable" : "Overhead"} ${f + 1}.${String(i + 1).padStart(2, "0")}`,
        { type: "LineString", coordinates: [previousPoint, coordinates] },
        networkId,
        [previousNode, primary],
        { mounting: cable ? "underground" : "overhead" },
      );
      if (!cable)
        asset(
          `f${f + 1}-pole${i}`,
          "pole",
          `Pole ${f + 1}.${String(i + 1).padStart(2, "0")}`,
          point(coordinates),
          networkId,
          [],
          { mounting: "overhead", illustrativeHeightM: 11 },
        );
      const tx = asset(
        `f${f + 1}-tx${i}`,
        "transformer",
        `DT-${f + 1}${String(i + 1).padStart(3, "0")}`,
        point(coordinates),
        networkId,
        [primary, secondary],
        {
          ratingKva: i % 3 === 0 ? 100 : 50,
          mounting: cable ? "padmount" : "pole-mounted",
          secondaryVoltageV: 240,
        },
      );
      if (i === 7 && !f) tx.status = "attention";
      if (i === 4) {
        const afterSwitch = node(`f${f + 1}-sw-node`, [
          coordinates[0] + sign * 0.00018,
          coordinates[1] + (f ? -0.00014 : 0.00014),
        ]);
        const sw = asset(
          `f${f + 1}-switch`,
          "switch",
          `Sectionalizer SW-0${f + 1}`,
          point(coordinates),
          networkId,
          [primary, afterSwitch],
          { switchPosition: "closed" },
        );
        previousNode = afterSwitch;
        previousPoint = bundle.nodes.find((n) => n.id === afterSwitch).geometry
          .coordinates;
        sw.status = "normal";
      } else {
        previousNode = primary;
        previousPoint = coordinates;
      }
      for (let m = 0; m < 4; m++) {
        const pos = [
          rounded(coordinates[0] + (m % 2 ? 1 : -1) * 0.00027),
          rounded(coordinates[1] + (m < 2 ? 1 : -1) * 0.00014),
        ];
        asset(
          `f${f + 1}-m${i}-${m}`,
          "meter",
          `M-${f + 1}${String(i * 4 + m + 1).padStart(4, "0")}`,
          point(pos),
          networkId,
          [secondary],
          { nominalVoltageV: 240, phases: [m % 2 ? "B" : "A", "N"] },
        );
      }
      const seriesId = `${tx.id}:load`;
      bundle.series.push({
        id: seriesId,
        assetId: tx.id,
        terminalId: `${tx.id}:t2`,
        datasetId,
        quantity: "Active power",
        unit: "kW",
        phase: "ABC",
        sampleIntervalSeconds: 900,
      });
      for (let t = 0; t < 96; t++) {
        const hour = t / 4;
        const value = rounded(
          16 +
            i * 0.6 +
            8 * Math.exp(-(((hour - 18) / 3) ** 2)) +
            3 * Math.sin((t + i * 5) / 8),
          2,
        );
        const missing = i === 7 && !f && t >= 48 && t <= 51;
        bundle.observations.push({
          seriesId,
          observedAt: new Date(
            Date.parse("2026-09-19T04:00:00Z") + t * 900000,
          ).toISOString(),
          value: missing ? null : value,
          quality: missing ? "missing" : "synthetic",
          datasetId,
        });
      }
      if (i < 3) {
        const voltageId = `${tx.id}:voltage`;
        bundle.series.push({
          id: voltageId,
          assetId: tx.id,
          datasetId,
          quantity: "Voltage",
          unit: "V",
          phase: "A",
          sampleIntervalSeconds: 900,
        });
        for (let t = 0; t < 96; t++)
          bundle.observations.push({
            seriesId: voltageId,
            observedAt: new Date(
              Date.parse("2026-09-19T04:00:00Z") + t * 900000,
            ).toISOString(),
            value: rounded(239 + 2.4 * Math.sin((t + i * 11) / 13), 2),
            quality: "synthetic",
            datasetId,
          });
      }
    }
  }
  bundle.events = [
    {
      id: "evt-01",
      workspaceId,
      datasetId,
      type: "Data gap",
      severity: "warning",
      status: "resolved",
      startedAt: "2026-09-19T16:00:00Z",
      endedAt: "2026-09-19T17:00:00Z",
      description:
        "Illustrative missing readings. The gap is retained in the historical chart.",
    },
    {
      id: "evt-02",
      workspaceId,
      datasetId,
      type: "Asset review",
      severity: "warning",
      status: "open",
      startedAt: "2026-09-19T21:15:00Z",
      endedAt: null,
      description:
        "Synthetic review flag for DT-1008. This is an illustrative asset state, not a field alert.",
    },
    {
      id: "evt-03",
      workspaceId,
      datasetId,
      type: "Inspection",
      severity: "info",
      status: "resolved",
      startedAt: "2026-09-19T13:00:00Z",
      endedAt: "2026-09-19T13:30:00Z",
      description: "Illustrative sectionalizer inspection completed.",
    },
  ];
  bundle.eventAssets = [
    { eventId: "evt-01", assetId: "f1-tx7" },
    { eventId: "evt-02", assetId: "f1-tx7" },
    { eventId: "evt-03", assetId: "f2-switch" },
  ];
  bundle.datasets.push({
    id: datasetId,
    workspaceId,
    sourceId: "tampa-demo",
    name: "Tampa electric · synthetic",
    version: "1.0.0",
    acquiredAt: "2026-09-20T04:00:00Z",
    isSynthetic: true,
    bounds: boundsOf(bundle.assets),
    crs: "EPSG:4326",
    schemaVersion: 1,
  });
  return assertBundle(bundle);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = createDemo();
  await mkdir(directory, { recursive: true });
  const files = {
    "workspace.json": bundle,
    "assets.geojson": {
      type: "FeatureCollection",
      features: bundle.assets.map(({ geometry, ...properties }) => ({
        type: "Feature",
        id: properties.id,
        geometry,
        properties,
      })),
    },
    "connectivity.json": {
      networks: bundle.networks,
      nodes: bundle.nodes,
      terminals: bundle.terminals,
      networkMemberships: bundle.networkMemberships,
    },
    "series.json": bundle.series,
    "events.json": { events: bundle.events, eventAssets: bundle.eventAssets },
    "manifest.json": {
      schemaVersion: 1,
      workspace: "workspace.json",
      assets: "assets.geojson",
      connectivity: "connectivity.json",
      series: "series.json",
      observations: "observations.csv",
      events: "events.json",
      isSynthetic: true,
      description:
        "Tidebound-generated illustrative network; no utility inventory, customer information, or Google content.",
    },
  };
  for (const [name, data] of Object.entries(files))
    await writeFile(
      `${directory}${name}`,
      `${JSON.stringify(data, null, name === "workspace.json" ? 0 : 2)}\n`,
    );
  await writeFile(
    `${directory}observations.csv`,
    "series_id,observed_at,value,quality,dataset_id\n" +
      bundle.observations
        .map(
          (o) =>
            `${o.seriesId},${o.observedAt},${o.value ?? ""},${o.quality},${o.datasetId}`,
        )
        .join("\n") +
      "\n",
  );
  console.log(
    `Generated ${bundle.assets.length} assets, ${bundle.nodes.length} nodes, ${bundle.observations.length} observations.`,
  );
}
