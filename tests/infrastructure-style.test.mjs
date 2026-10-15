import test from "node:test";
import assert from "node:assert/strict";
import { Color, CustomBlending, SrcAlphaFactor, DstAlphaFactor, AddEquation, Matrix4, Vector3 } from "three";
import { CARTO_TRANSMISSION_COLOR, CARTO_TRANSMISSION_OPACITY, infrastructureColor } from "../src/spatial/infrastructure-style.js";
import { transmissionPaths } from "../src/spatial/transmission-additive.js";
import { createUtilityEquipment } from "../src/spatial/utility-equipment.js";

const station = (id, attributes = {}) => ({ id, assetType: "substation", attributes, geometry: { type: "Point", coordinates: [-82.5, 27.9] } });

test("substations are black diamonds regardless of published or missing voltage", () => {
  for (const voltage of [undefined, 0, -999999, 69, 115, 230, 500])
    assert.equal(infrastructureColor(station("station", { maximumVoltageKv: voltage })), "#000000");
});

test("transmission paths keep bends joined, preserve overlaps and multipart boundaries without changing asset data", () => {
  const asset = { id: "line", assetType: "transmission_line", geometry: { type: "MultiLineString", coordinates: [
    [[-82.5, 27.9], [-82.5, 27.9], [-82.45, 27.9], [-82.45, 27.95], [-82.4, 27.95]], [[-82.3, 27.9], [-82.2, 27.9]],
  ] } };
  const assets = [asset, { ...asset, id: "overlap" }, station("station")];
  const before = JSON.stringify(assets);
  const paths = transmissionPaths(assets);
  assert.equal(paths.length, 4);
  assert.equal(paths[0].path.length, 4);
  assert.deepEqual(paths[0].path[2], [-82.45, 27.95]);
  assert.deepEqual(paths.map((line) => line.assetId), ["line", "line", "overlap", "overlap"]);
  assert.deepEqual(paths[0].path, paths[2].path);
  assert.notDeepEqual(paths[0].path.at(-1), paths[1].path[0]);
  assert.equal(JSON.stringify(assets), before);
  assert.equal(transmissionPaths([]).length, 0);
});

test("transmission lines use CARTO page-two RGBA at every voltage", () => {
  assert.equal(CARTO_TRANSMISSION_COLOR, "#5387b9");
  assert.equal(CARTO_TRANSMISSION_OPACITY, 180 / 255);
  for (const voltage of [null, 69, 115, 230, 500])
    assert.equal(infrastructureColor({ assetType: "transmission_line", attributes: { nominalVoltageV: voltage * 1000 } }), CARTO_TRANSMISSION_COLOR);
});

test("3D black diamond markers and transmission materials use CARTO's exact additive blend factors", () => {
  let viewExtent = 200;
  const equipment = createUtilityEquipment({
    project: (_c, lift) => new Vector3(0, lift, 0), basisAt: () => new Matrix4(),
    getCameraPosition: () => new Vector3(0, 50000, 0),
    getViewExtentMeters: () => viewExtent,
    loadPlacementData: async () => { throw new Error("No placement data"); },
  });
  const assets = [station("station-115", { maximumVoltageKv: 115 }), station("station-230", { maximumVoltageKv: 230 }),
    { id: "line", assetType: "transmission_line", geometry: { type: "LineString", coordinates: [[-82.5, 27.9], [-82.501, 27.901]] } },
  ];
  equipment.update({ assets });
  let markers, line;
  equipment.group.traverse((object) => {
    if (object.name === "Substation · distant marker") markers = object;
    if (object.name === "Three phase A/B/C conductors") line = object;
  });
  assert.equal(markers.geometry.type, "BoxGeometry");
  assert.equal(markers.geometry.parameters.width, 5);
  assert.equal(markers.geometry.parameters.depth, 5);
  equipment.tick();
  assert.equal(markers.visible, true);
  viewExtent = 304.801;
  equipment.tick();
  assert.equal(markers.visible, false);
  viewExtent = 304.8;
  equipment.tick();
  assert.equal(markers.visible, true);
  const transform = new Matrix4(); markers.getMatrixAt(0, transform);
  assert.ok(Math.abs(transform.elements[0] - Math.SQRT1_2) < 0.00001);
  for (let i = 0; i < 2; i++) {
    const color = new Color(); markers.getColorAt(i, color);
    assert.equal(color.getHexString(), "000000");
  }
  assert.equal(`#${line.material.color.getHexString()}`, CARTO_TRANSMISSION_COLOR);
  assert.equal(line.material.opacity, CARTO_TRANSMISSION_OPACITY);
  assert.equal(line.material.blending, CustomBlending);
  assert.equal(line.material.blendSrc, SrcAlphaFactor);
  assert.equal(line.material.blendDst, DstAlphaFactor);
  assert.equal(line.material.blendEquation, AddEquation);
  equipment.update({ assets, selectedId: "line" });
  assert.equal(line.material.color.getHexString(), "ffffff");
  equipment.update({ assets, selectedId: null });
  assert.equal(`#${line.material.color.getHexString()}`, CARTO_TRANSMISSION_COLOR);
  equipment.dispose();
});
