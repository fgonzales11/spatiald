import { test } from "node:test";
import assert from "node:assert/strict";
import { Box3, Color, Matrix4, Raycaster, Vector3 } from "three";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { prepareSteelPoleModel } from "../src/spatial/pole-model.js";
import poleDefinition from "../src/assets/transmission-pole.json" with { type: "json" };
import {
  offsetMeters,
  distanceMeters,
  sampleRoute,
  routeTurns,
  PolePlacementIndex,
  planTransmissionPoles,
  insidePolygon,
} from "../src/spatial/pole-placement.js";
import {
  poleConductorSeats,
  createTransformerBankTemplate,
  createUtilityEquipment,
  EQUIPMENT_SETTINGS,
} from "../src/spatial/utility-equipment.js";

const origin = [-82.5, 27.9];
const point = (east, north) => offsetMeters(origin, east, north);
const polygon = (west, south, east, north) => ({
  type: "Polygon",
  coordinates: [
    [
      point(west, south),
      point(east, south),
      point(east, north),
      point(west, north),
      point(west, south),
    ],
  ],
});
const feature = (geometry, tags = {}) => ({
  type: "Feature",
  geometry,
  properties: { tags },
});
const collection = (features = []) => ({ type: "FeatureCollection", features });
function screeningData(extra = {}) {
  const b = polygon(-1000, -1000, 1000, 1000).coordinates[0];
  return {
    manifest: {
      bounds: [b[0][0], b[0][1], b[2][0], b[2][1]],
      files: [{ bounds: [b[0][0], b[0][1], b[2][0], b[2][1]] }],
    },
    collections: {
      landcover: collection([
        feature(polygon(-1000, -1000, 1000, 1000), { landuse: "grass" }),
      ]),
      roads: collection(),
      water: collection(),
      buildings: collection(),
      ...extra,
    },
  };
}
function screening(extra = {}) { return new PolePlacementIndex(screeningData(extra)); }

test("route sampling retains chainage and keeps unknown elevations unknown", () => {
  const samples = [...sampleRoute([point(0, 0), point(0, 150)])];
  assert.equal(samples.length, 5);
  for (let i = 1; i < samples.length; i++) {
    assert.equal(samples[i].chainage, 30.48 * i);
    assert.ok(
      Math.abs(
        distanceMeters(samples[i - 1].coordinates, samples[i].coordinates) -
          30.48,
      ) < 0.00001,
    );
    assert.equal(samples[i].coordinates.length, 2);
  }
  assert.deepEqual([...sampleRoute([origin, origin])], []);
  assert.throws(() => [...sampleRoute([origin, point(0, 150)], 0)], /positive/);
});

test("poles occur at every bend angle, with no endpoint or straight-span supports", () => {
  const coordinates = [point(-100, 0), origin, origin, point(0, 100), point(100, 100), point(200, 100)];
  const anchors = [...routeTurns(coordinates)];
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map((a) => a.coordinates), [origin, point(0, 100)]);
  assert.ok(anchors.every((a) => Math.abs(a.turnDegrees - 90) < 0.001));
  assert.ok(anchors.every((a) => a.coordinates.length === 2));
  assert.ok(Math.abs(anchors[0].chainage - 100) < 0.001);
  assert.ok(Math.abs(anchors[0].direction[0] - Math.SQRT1_2) < 0.001);
  assert.ok(Math.abs(anchors[0].direction[1] - Math.SQRT1_2) < 0.001);
  assert.deepEqual([...routeTurns([origin, origin, point(0, 200)])], []);
  assert.equal([...routeTurns([point(-100, 0), origin, point(-100, 0)])].length, 1);
  for (const angle of [1, 30, 45, 84, 90, 96, 135, 180, -90]) {
    const route = [point(-100, 0), origin, point(100 * Math.cos(angle * Math.PI / 180), 100 * Math.sin(angle * Math.PI / 180))];
    assert.equal([...routeTurns(route)].length, 1);
  }
  const elevated = [...routeTurns([[-82.501, 27.9, 12], [-82.5, 27.9, 14], [-82.5, 27.901, 16]])];
  assert.equal(elevated[0].coordinates[2], 14);
  const plan = planTransmissionPoles([{ id: "corners", assetType: "transmission_line", geometry: { type: "LineString", coordinates } }], screening());
  assert.equal(plan.placements.length, 2);
});

test("illustrative poles sit exactly on shared bends outside local screening coverage and never change source geometry", () => {
  const coordinates = [point(3000, 3000), point(3100, 3000), point(3100, 3100)];
  const assets = ["route-a", "route-b"].map((id) => ({ id, assetType: "transmission_line",
    geometry: { type: "LineString", coordinates: structuredClone(coordinates) } }));
  const before = JSON.stringify(assets);
  assert.equal(planTransmissionPoles(assets, screening()).placements.length, 0);
  const plan = planTransmissionPoles(assets);
  assert.equal(plan.placements.length, 1);
  assert.equal(plan.statistics.accepted, 1);
  assert.deepEqual(plan.placements[0].coordinates, coordinates[1]);
  assert.deepEqual(plan.placements[0].assetIds, ["route-a", "route-b"]);
  assert.deepEqual(plan.byAsset.get("route-a")[0].coordinates, plan.byAsset.get("route-b")[0].coordinates);
  assert.equal(JSON.stringify(assets), before);
});

test("screening rejects water, buffered road centers and buildings, restricted uses, and unknown coverage or land", () => {
  const index = screening({
    water: collection([
      feature(polygon(100, 100, 200, 200), { natural: "water" }),
    ]),
    buildings: collection([
      feature(polygon(-200, 100, -100, 200), { building: "yes" }),
    ]),
    roads: collection([
      feature(
        { type: "LineString", coordinates: [point(-300, 0), point(300, 0)] },
        { highway: "residential", width: "8" },
      ),
    ]),
    landcover: collection([
      feature(polygon(-500, -500, 500, 500), { landuse: "grass" }),
      feature(polygon(-50, 300, 50, 400), { leisure: "pitch" }),
    ]),
  });
  assert.equal(index.classify(point(150, 150)), "water");
  assert.equal(index.classify(point(-150, 150)), "buildings");
  assert.equal(index.classify(point(-99, 150)), "buildings");
  assert.equal(index.classify(point(0, 4)), "roads");
  assert.equal(index.classify(point(0, 7)), "valid");
  assert.equal(index.classify(point(0, 350)), "restricted_land");
  assert.equal(index.classify(point(800, 800)), "unknown_land");
  assert.equal(index.classify(point(1100, 0)), "unknown_coverage");
});

test("corner poles move to valid roadside positions and omit blocked corners without changing source geometry", () => {
  const index = screening({
    roads: collection([
      feature(
        { type: "LineString", coordinates: [point(-200, 0), point(200, 0)] },
        { highway: "residential", width: "10" },
      ),
    ]),
    water: collection([
      feature(polygon(-40, -50, 40, 50), { natural: "water" }),
    ]),
  });
  const assets = [
    {
      id: "line-1",
      assetType: "transmission_line",
      geometry: {
        type: "LineString",
        coordinates: [point(-150, -100), point(-150, 0), origin, point(0, 100)],
      },
    },
  ];
  const before = JSON.stringify(assets),
    plan = planTransmissionPoles(assets, index);
  assert.ok(plan.placements.length > 0);
  assert.ok(plan.statistics.skipped > 0);
  for (const placement of plan.placements) {
    assert.equal(index.classify(placement.coordinates), "valid");
    assert.ok(
      distanceMeters(placement.coordinates, placement.routeCoordinates) > 7,
    );
    assert.ok(
      distanceMeters(placement.coordinates, placement.routeCoordinates) <=
        22.01,
    );
  }
  assert.equal(JSON.stringify(assets), before);
});

test("multipart corners stay independent and missing constraint layers fail closed", () => {
  const asset = {
    id: "multipart",
    assetType: "transmission_line",
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [point(-150, -100), point(-140, -100), point(-140, -90)],
        [point(150, 100), point(160, 100), point(160, 110)],
      ],
    },
  };
  const plan = planTransmissionPoles([asset], screening());
  assert.equal(plan.placements.length, 2);
  assert.deepEqual(
    plan.placements.map((placement) => placement.pathIndex),
    [0, 1],
  );
  assert.ok(plan.placements.every((placement) => placement.chainage > 9.9 && placement.chainage < 10.1));
  const straightParts = { ...asset, geometry: { type: "MultiLineString", coordinates: [[point(-100, 0), origin], [origin, point(0, 100)]] } };
  assert.equal(planTransmissionPoles([straightParts], screening()).placements.length, 0);
  assert.throws(
    () =>
      new PolePlacementIndex({
        manifest: { files: [], bounds: [0, 0, 1, 1] },
        collections: {},
      }),
    /requires/,
  );
  const geometry = polygon(-100, -100, 100, 100);
  geometry.coordinates.push(polygon(-10, -10, 10, 10).coordinates[0]);
  assert.equal(insidePolygon(point(50, 50), geometry), true);
  assert.equal(insidePolygon(origin, geometry), false);
});

test("shared bend supports retain conductor alignment references for each source line", () => {
  const asset = (id, coordinates) => ({ id, assetType: "transmission_line", geometry: { type: "LineString", coordinates } });
  const plan = planTransmissionPoles([
    asset("one", [point(-100, 0), origin, point(0, 100)]),
    asset("two", [point(0, -100), origin, point(100, 0)]),
  ], screening());
  assert.equal(plan.placements.length, 1);
  assert.deepEqual(plan.placements[0].assetIds, ["one", "two"]);
  assert.equal(plan.byAsset.get("two").length, 1);
  assert.deepEqual(plan.byAsset.get("two")[0].direction, plan.byAsset.get("one")[0].direction);
});

test("substation template contains three phases, nine winding assemblies and radiator banks", () => {
  const bank = createTransformerBankTemplate();
  const phases = bank.children.filter((child) => child.userData.phase);
  assert.deepEqual(
    phases.map((phase) => phase.userData.phase),
    ["A", "B", "C"],
  );
  let windings = 0,
    fins = 0;
  const resources = new Set();
  bank.traverse((object) => {
    if (object.userData.winding) windings++;
    if (object.name === "Radiator fin") fins++;
    if (object.isMesh) {
      resources.add(object.geometry);
      resources.add(object.material);
    }
  });
  assert.equal(windings, 9);
  assert.equal(fins, 72);
  for (const resource of resources) resource.dispose();
});

test("gas uses translucent underground tube geometry; equipment remains selectable and releases resources", () => {
  const layer = createUtilityEquipment({
    project: (coordinates, lift) =>
      new Vector3(
        (coordinates[0] - origin[0]) * 100000,
        lift,
        (coordinates[1] - origin[1]) * 111000,
      ),
    basisAt: () => new Matrix4(),
    getCameraPosition: () => new Vector3(0, 100, 100),
  });
  const assets = [
    {
      id: "gas",
      assetType: "gas_main",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [origin, point(50, 50)],
          [point(100, 100), point(150, 150)],
        ],
      },
    },
    {
      id: "station",
      assetType: "substation",
      geometry: { type: "Point", coordinates: origin },
    },
  ];
  layer.update({ assets, selectedId: null });
  const pipes = [];
  layer.group.traverse((object) => {
    if (object.name === "Translucent underground gas pipe") pipes.push(object);
  });
  assert.equal(pipes.length, 2);
  assert.ok(
    pipes.every(
      (pipe) =>
        pipe.geometry.type === "TubeGeometry" &&
        pipe.material.transparent &&
        !pipe.material.depthWrite &&
        pipe.userData.assetId === "gas",
    ),
  );
  assert.equal(pipes[0].material.opacity, EQUIPMENT_SETTINGS.pipeOpacity);
  for (const pipe of pipes) {
    const curve = pipe.geometry.parameters.path;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(curve.getPoint(t).y, -EQUIPMENT_SETTINGS.pipeDepth);
      assert.ok(curve.getPoint(t).y + EQUIPMENT_SETTINGS.pipeRadius < 0);
    }
  }
  let disposed = false;
  pipes[0].geometry.addEventListener("dispose", () => {
    disposed = true;
  });
  layer.update({ assets, selectedId: "gas" });
  assert.equal(pipes[0].material.color.getHexString(), "ffffff");
  assert.equal(disposed, false);
  layer.dispose();
  assert.equal(disposed, true);
});

async function runtimePole() {
  const bytes = await readFile(new URL("../src/assets/transmission-pole.glb", import.meta.url));
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "")).scene;
}

test("the runtime GLB uses the supplied model, omits lower equipment, and seats wires on actual insulator surfaces", async () => {
  const [obj, mtl] = await Promise.all([
    readFile(new URL("../src/assets/POSTE 05.obj", import.meta.url), "utf8"),
    readFile(new URL("../src/assets/POSTE 05.mtl", import.meta.url), "utf8"),
  ]);
  assert.equal(poleDefinition.sourceHash, createHash("sha256").update(obj).update(mtl).digest("hex"));
  const source = new OBJLoader().setMaterials(new MTLLoader().parse(mtl, "")).parse(obj);
  const originalBounds = new Box3().setFromObject(source);
  const prepared = prepareSteelPoleModel(source);
  assert.ok(new Box3().setFromObject(source).equals(originalBounds));
  assert.deepEqual(prepared.definition.attachments, poleDefinition.attachments);
  const pole = await runtimePole();
  const parts = [];
  pole.traverse((part) => { if (part.isMesh) parts.push(part); });
  assert.equal(parts.length, 7);
  assert.equal(pole.children[0].userData.source, "POSTE 05.obj");
  assert.equal(pole.children[0].userData.sourceHash, poleDefinition.sourceHash);
  assert.equal(new Box3().setFromObject(pole).getSize(new Vector3()).y, 24);
  const shaft = parts.find((part) => part.userData.sourcePart === "Cylinder");
  const rgb = shaft.material.color;
  assert.ok(Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 0.03, "Pole shaft must have a neutral gray finish");
  assert.equal(shaft.material.metalness, 0, "Matte shaft must not darken through metallic reflections");
  assert.ok(shaft.material.roughness >= 0.8);
  for (const part of parts) {
    const original = prepared.root.children.find((p) => p.userData.sourcePart === part.userData.sourcePart);
    assert.ok(original, `Unexpected retained geometry: ${part.name}`);
    assert.equal(part.geometry.attributes.position.count, original.geometry.attributes.position.count);
    assert.deepEqual(part.geometry.attributes.position.array, original.geometry.attributes.position.array);
    if (part.name !== "Pole_shaft") assert.ok(new Box3().setFromObject(part).min.y > 22.9, part.name);
  }
  const insulators = parts.find((part) => part.userData.sourcePart === "Cube.007_Cube.008");
  assert.equal(poleDefinition.insulatorTops.length, 8);
  for (const top of poleDefinition.insulatorTops) {
    const ray = new Raycaster(new Vector3().fromArray(top).add(new Vector3(0, 1, 0)), new Vector3(0, -1, 0));
    const hit = ray.intersectObject(insulators)[0];
    assert.ok(hit, "Seat must be over a real insulator cap");
    assert.ok(hit.point.distanceTo(new Vector3().fromArray(top)) < 0.0001);
  }
});

test("every rendered bend pole uses the supplied GLB and all three wires meet both insulator rows", { timeout: 5000 }, async () => {
  const project = (c, lift) => new Vector3((c[0] - origin[0]) * 100000, (c[2] ?? 0) + lift, (c[1] - origin[1]) * 111000);
  const basisAt = (_c, direction = [1, 0]) => new Matrix4().makeBasis(new Vector3(direction[0], 0, direction[1]), new Vector3(0, 1, 0), new Vector3(-direction[1], 0, direction[0]));
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const layer = createUtilityEquipment({ project, basisAt, getCameraPosition: () => new Vector3(0, 60, 100), loadPlacementData: async () => screeningData(), loadPoleModel: runtimePole, onStatus: (status) => { if (status.modelReady) resolveReady(); }, onError: rejectReady });
  const assets = [{ id: "arcgis-line", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [point(-100, 0), origin, point(80, 80), point(80, 160), point(-20, 160)].map((c) => [...c, 13]) } }];
  const before = JSON.stringify(assets);
  layer.update({ assets });
  await ready;
  const plan = planTransmissionPoles(assets, screening());
  assert.equal(plan.placements.length, 3);
  const shafts = layer.group.children[1].children.filter((part) => part.userData.sourceParts?.includes("Cylinder"));
  assert.equal(shafts.length, 1);
  assert.equal(shafts[0].count, 3);
  const line = layer.group.children[0].children[0];
  const vertices = ["instanceStart", "instanceEnd"].flatMap((name) => {
    const a = line.geometry.attributes[name];
    return Array.from({ length: a.count }, (_, i) => new Vector3().fromBufferAttribute(a, i));
  });
  for (const placement of plan.placements) {
    for (let phase = 0; phase < 3; phase++) {
      for (const seat of poleConductorSeats(placement, phase, project, basisAt)) {
        assert.ok(vertices.some((p) => p.distanceTo(seat) < 0.001), "Wire must meet the actual insulator top");
        assert.ok(seat.y > 36.9, "Wire height is raised above the previous 18 m display default");
      }
    }
  }
  assert.equal(JSON.stringify(assets), before);
  layer.update({ assets, selectedId: "arcgis-line" });
  const tint = new Color();
  shafts[0].getColorAt(0, tint);
  assert.equal(tint.getHexString(), "ffffff", "Selection must retain the pole's neutral material finish");
  layer.dispose();
});

test("underground pipes follow sloping ground without changing source coordinates or joining separate paths", () => {
  const project = (c, lift) => new Vector3((c[0] - origin[0]) * 100000, (c[2] ?? 0) + lift, (c[1] - origin[1]) * 111000);
  const ground = (c) => 35 + (c[0] - origin[0]) * 10000;
  const layer = createUtilityEquipment({ project, basisAt: () => new Matrix4(), getCameraPosition: () => new Vector3(0, 100, 100), sampleGroundHeight: ground });
  const assets = [{ id: "gas", assetType: "gas_main", geometry: { type: "MultiLineString", coordinates: [[origin, point(100, 0)], [point(150, 0), point(200, 0)]] } }];
  const before = JSON.stringify(assets);
  layer.update({ assets });
  const pipes = layer.group.children[0].children;
  assert.equal(pipes.length, 2);
  for (const pipe of pipes) {
    const curve = pipe.geometry.parameters.path;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = curve.getPoint(t);
      assert.ok(Math.abs(p.y - (35 + p.x / 10 - EQUIPMENT_SETTINGS.pipeDepth)) < 0.001);
      assert.ok(p.y + EQUIPMENT_SETTINGS.pipeRadius < 35 + p.x / 10);
    }
  }
  assert.ok(pipes[0].geometry.parameters.path.getPoint(1).x < pipes[1].geometry.parameters.path.getPoint(0).x);
  assert.equal(JSON.stringify(assets), before);
  layer.dispose();
});

test("three phase conductors use actual wide-line geometry and keep their identity when selected", () => {
  const layer = createUtilityEquipment({ project: (c, lift) => new Vector3((c[0] - origin[0]) * 100000, lift, (c[1] - origin[1]) * 111000), basisAt: () => new Matrix4(), getCameraPosition: () => new Vector3(0, 100, 100), loadPlacementData: async () => { throw new Error("Unavailable"); } });
  const assets = [{ id: "line", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [origin, point(100, 0)] } }];
  layer.update({ assets });
  const line = layer.group.children[0].children[0];
  assert.equal(line.isLineSegments2, true);
  assert.equal(line.userData.phaseCount, 3);
  assert.equal(line.material.linewidth, EQUIPMENT_SETTINGS.conductorWidth);
  assert.ok(line.material.linewidth > 1);
  const starts = line.geometry.getAttribute("instanceStart");
  const heights = Array.from({ length: starts.count }, (_, i) => starts.getY(i));
  assert.ok(heights.every((y) => y >= EQUIPMENT_SETTINGS.attachmentHeight + EQUIPMENT_SETTINGS.poleGroundLift - EQUIPMENT_SETTINGS.conductorSag - 0.001));
  layer.update({ assets, selectedId: "line" });
  assert.equal(layer.group.children[0].children[0], line);
  assert.equal(line.material.linewidth, EQUIPMENT_SETTINGS.selectedConductorWidth);
  assert.equal(line.userData.assetId, "line");
  layer.dispose();
});

test("terrain grounding affects display transforms only and preserves supplied source elevations", () => {
  const layer = createUtilityEquipment({
    project: (c, lift) => new Vector3(0, (c[2] || 0) + lift, 0),
    basisAt: () => new Matrix4(),
    getCameraPosition: () => new Vector3(0, 100, 100),
    sampleGroundHeight: () => 42,
  });
  const assets = [
    {
      id: "grounded",
      assetType: "substation",
      geometry: { type: "Point", coordinates: [...origin] },
    },
  ];
  const before = JSON.stringify(assets);
  layer.update({ assets, selectedId: null });
  let bank;
  layer.group.traverse((object) => {
    if (!bank && object.name === "Three phase three winding transformer bank")
      bank = object;
  });
  const matrix = new Matrix4();
  bank.getMatrixAt(0, matrix);
  assert.ok(Math.abs(matrix.elements[13] - 44.2) < 0.001);
  assert.equal(JSON.stringify(assets), before);
  const explicit = [
    { ...assets[0], geometry: { type: "Point", coordinates: [...origin, 5] } },
  ];
  layer.update({ assets: explicit, selectedId: null });
  bank = null;
  layer.group.traverse((object) => {
    if (!bank && object.name === "Three phase three winding transformer bank")
      bank = object;
  });
  bank.getMatrixAt(0, matrix);
  assert.ok(Math.abs(matrix.elements[13] - 7.2) < 0.001);
  assert.equal(explicit[0].geometry.coordinates[2], 5);
  layer.dispose();
});
