import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Vector3 } from "three";
import { readFile } from "node:fs/promises";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createUtilityEquipment, EQUIPMENT_SETTINGS, poleConductorSeats } from "../src/spatial/utility-equipment.js";
import { planTransmissionPoles, distanceMeters } from "../src/spatial/pole-placement.js";

const origin = [-82.5, 27.9];
const coordinate = (x, z) => [origin[0] + x / 100000, origin[1] + z / 111000];
const project = (c, lift) => new Vector3((c[0] - origin[0]) * 100000, (c[2] ?? 0) + lift, (c[1] - origin[1]) * 111000);
const basisAt = (_c, direction = [1, 0]) => new Matrix4().makeBasis(new Vector3(direction[0], 0, direction[1]),
  new Vector3(0, 1, 0), new Vector3(-direction[1], 0, direction[0]));

test("missing terrain at a bend does not spike to ellipsoid height; shared poles and wires retain one continuous height", async () => {
  const first = coordinate(100, 0), missing = coordinate(100, 100), last = coordinate(200, 100);
  const assets = [
    { id: "shared", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [coordinate(0, 100), missing, coordinate(100, 200)] } },
    { id: "profile", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [coordinate(0, 0), first, missing, last, coordinate(200, 200)] } },
    { id: "long-tail", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [coordinate(100, -100), first, coordinate(3500, 0)] } },
  ];
  const before = JSON.stringify(assets);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const bytes = await readFile(new URL("../src/assets/transmission-pole.glb", import.meta.url));
  const model = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "")).scene;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const equipment = createUtilityEquipment({ project, basisAt, getCameraPosition: () => new Vector3(100, 100, 100),
    sampleGroundHeight: (c) => same(c, first) ? -35 : same(c, last) ? -25 : null,
    loadPoleModel: async () => model,
    onStatus: (status) => { if (status.modelReady) resolveReady(); },
  });
  equipment.update({ assets });
  await ready;
  const lines = equipment.group.children[0].children;
  assert.equal(lines.length, 3);
  const shared = planTransmissionPoles(assets).placements.find((pole) => same(pole.coordinates, missing));
  const expectedGround = -35 + 10 * distanceMeters(first, missing) / (distanceMeters(first, missing) + distanceMeters(missing, last));
  for (const line of lines) {
    const vertices = ["instanceStart", "instanceEnd"].flatMap((name) => {
      const a = line.geometry.attributes[name];
      return Array.from({ length: a.count }, (_, i) => new Vector3().fromBufferAttribute(a, i));
    });
    assert.ok(vertices.every((p) => p.y < 0), "Unsampled bends must not rise back to the zero-height ellipsoid");
    assert.ok(vertices.every((p) => p.y >= -35 + EQUIPMENT_SETTINGS.attachmentHeight + EQUIPMENT_SETTINGS.poleGroundLift - EQUIPMENT_SETTINGS.conductorSag - 0.01));
    if (line.userData.assetId === "long-tail") continue;
    for (let phase = 0; phase < 3; phase++)
      for (const seat of poleConductorSeats(shared, phase, project, basisAt, expectedGround))
        assert.ok(vertices.some((p) => p.distanceTo(seat) < 0.01), "Both routes must meet the same interpolated insulator seats");
  }
  let supportHeight;
  equipment.group.traverse((object) => {
    if (!object.userData.sourceParts?.includes("Cylinder")) return;
    const matrix = new Matrix4(), expected = project(missing, 0);
    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      const base = new Vector3().setFromMatrixPosition(matrix);
      if (Math.hypot(base.x - expected.x, base.z - expected.z) < 0.01) supportHeight = base.y;
    }
  });
  assert.ok(Math.abs(supportHeight - expectedGround - EQUIPMENT_SETTINGS.poleGroundLift) < 0.01, "The shared pole model must use the same interpolated ground as both wires");
  assert.equal(JSON.stringify(assets), before);
  equipment.dispose();
});
