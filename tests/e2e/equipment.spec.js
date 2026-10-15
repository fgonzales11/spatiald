import { test, expect } from "@playwright/test";
import { createPublicWorkspace } from "../../src/data/public-layers.js";
import { mockSpatialProviders } from "./helpers/spatial-providers.js";

async function equipmentMap(page, { failScreening = false } = {}) {
  await mockSpatialProviders(page);
  const bundle = createPublicWorkspace();
  bundle.workspace.id = "equipment-preview";
  bundle.workspace.name = "Equipment rendering fixture";
  const center = [-82.5135071323, 27.9230079698];
  const datasetId = "equipment-fixture";
  bundle.datasets = [
    {
      id: datasetId,
      workspaceId: bundle.workspace.id,
      sourceId: "public-transmission",
      name: "Rendering fixture",
      version: "1",
      acquiredAt: "2026-10-01T00:00:00Z",
      isSynthetic: false,
      bounds: [-82.52, 27.92, -82.51, 27.93],
      crs: "EPSG:4326",
      schemaVersion: 1,
    },
  ];
  const asset = (id, assetType, geometry) => ({
    id,
    externalId: id,
    workspaceId: bundle.workspace.id,
    datasetId,
    utilityType: assetType === "gas_main" ? "gas" : "electric",
    assetType,
    geometry,
    name: id,
    status: "unknown",
    attributes: {},
  });
  bundle.assets = [
    asset("Transmission fixture", "transmission_line", {
      type: "LineString",
      coordinates: [
        [center[0] - 0.0015, center[1]],
        center,
        [center[0] + 0.0015, center[1] + 0.0015],
      ],
    }),
    asset("Substation fixture", "substation", {
      type: "Point",
      coordinates: [center[0] + 0.0003, center[1] + 0.0003],
    }),
    asset("Gas fixture", "gas_main", {
      type: "LineString",
      coordinates: [
        [center[0] - 0.001, center[1] - 0.0006],
        [center[0], center[1] - 0.0003],
        [center[0] + 0.001, center[1] - 0.0006],
      ],
    }),
  ];
  await page.route("**/data/workspace.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(bundle),
    }),
  );
  await page.route("**/environment/shape.bin", (route) => route.abort());
  if (failScreening)
    await page.route("**/data/osm/tampa-bay/buildings.geojson", (route) =>
      route.fulfill({ status: 503, body: "Unavailable" }),
    );
  await page.route(/\/src\/spatial\/map3d\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(
        "scene.add(equipment.group);",
        "scene.add(equipment.group); window.__equipmentView = {equipment, camera, viewAt, environment};",
      )
      .replace(
        "onStatus: onEquipmentStatus,",
        "onStatus: (status) => { window.__equipmentStatus = status; onEquipmentStatus?.(status); },",
      );
    await route.fulfill({ response, body });
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__equipmentView);
  await page.evaluate(
    (center) => window.__equipmentView.viewAt(center, 220),
    center,
  );
  return { bundle, center };
}

test("3D uses steel supports, wider three-phase conductors, underground translucent pipes and detailed banks without creating source records", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors = [];
  const oldPoleRequests = [];
  const newPoleRequests = [];
  page.on("request", (request) => { if (request.url().includes("transmission-pole.glb")) newPoleRequests.push(request.url()); });
  page.on("request", (request) => { if (request.url().includes("electricity_pole")) oldPoleRequests.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await equipmentMap(page);
  await page.waitForFunction(
    () =>
      window.__equipmentStatus?.modelReady &&
      window.__equipmentStatus.poles > 0,
  );
  expect(await page.evaluate(() => window.__equipmentStatus.poles)).toBe(1);
  await page.waitForFunction(() => {
    let ready = false;
    window.__equipmentView.equipment.group.traverse((object) => {
      if (object.name === "Three phase three winding transformer bank" && object.count > 0) ready = true;
    });
    return ready;
  });
  const details = await page.evaluate(() => {
    const group = window.__equipmentView.equipment.group;
    const parts = [];
    group.traverse((object) => {
      if (object.name.startsWith("Steel pole"))
        parts.push({
          name: object.name,
          count: object.count,
          assets: object.userData.assetIds.flat(),
        });
      if (object.name === "Three phase A/B/C conductors")
        parts.push({ name: object.name, phases: object.userData.phaseCount, linewidth: object.material.linewidth, wide: object.isLineSegments2 });
      if (object.name === "Translucent underground gas pipe")
        parts.push({
          name: object.name,
          geometry: object.geometry.type,
          opacity: object.material.opacity,
          transparent: object.material.transparent,
          depth: object.userData.displayDepth,
        });
      if (object.name === "Three phase three winding transformer bank")
        parts.push({ name: object.name, count: object.count });
    });
    return parts;
  });
  expect(
    details.some(
      (part) =>
        part.name.startsWith("Steel pole") &&
        part.count > 0 &&
        part.assets.includes("Transmission fixture"),
    ),
  ).toBe(true);
  expect(details.find((part) => part.phases)?.phases).toBe(3);
  expect(details.find((part) => part.phases)?.wide).toBe(true);
  expect(details.find((part) => part.phases)?.linewidth).toBe(3);
  expect(details.find((part) => part.geometry)?.geometry).toBe("TubeGeometry");
  expect(details.find((part) => part.geometry)?.opacity).toBeCloseTo(0.38);
  expect(details.find((part) => part.geometry)?.depth).toBe(2.2);
  expect(oldPoleRequests).toEqual([]);
  expect(newPoleRequests).toHaveLength(1);
  await page.screenshot({ path: "test-results/steel-poles-underground-pipes.png" });
  await page.evaluate(() => {
    const { equipment, camera } = window.__equipmentView;
    equipment.group.updateMatrixWorld(true);
    let shaft;
    equipment.group.traverse((object) => {
      if (object.userData.sourceParts?.includes("Cylinder") && object.count > 0) shaft = object;
    });
    const instance = shaft.matrixWorld.clone();
    shaft.getMatrixAt(0, instance);
    const world = shaft.matrixWorld.clone().multiply(instance);
    const target = camera.position.clone().set(0, 23.25, 0).applyMatrix4(world);
    camera.position.set(6, 27.25, 9).applyMatrix4(world);
    camera.up.setFromMatrixColumn(world, 1);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    window.__polePreviewTarget = target;
  });
  await page.waitForTimeout(500);
  const framing = await page.evaluate(() => {
    const { camera } = window.__equipmentView;
    return window.__polePreviewTarget.clone().project(camera).toArray();
  });
  expect(Math.abs(framing[0])).toBeLessThan(0.01);
  expect(Math.abs(framing[1])).toBeLessThan(0.01);
  expect(framing[2]).toBeGreaterThan(0);
  expect(framing[2]).toBeLessThan(1);
  await page.screenshot({ path: "test-results/pole-model-insulator-alignment.png", clip: { x: 400, y: 190, width: 640, height: 520 } });
  expect(
    details.some(
      (part) =>
        part.name === "Three phase three winding transformer bank" &&
        part.count > 0,
    ),
  ).toBe(true);
  await page.getByLabel("Search all assets").fill("Substation fixture");
  await page.locator('[data-search-select="Substation fixture"]').click();
  await expect(page.locator("#map-inspector h2")).toHaveText(
    "Substation fixture",
  );
  await expect(page.locator("#status-count")).toContainText("3 assets");
  await page.getByLabel("Use 2D map").click();
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#map-inspector h2")).toHaveText(
    "Substation fixture",
  );
  expect(errors).toEqual([]);
});

test("one pole remains on the route bend when local obstacle data is unavailable", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await equipmentMap(page, { failScreening: true });
  await page.waitForFunction(
    () => window.__equipmentStatus?.modelReady,
  );
  expect(
    await page.evaluate(() => {
      let count = 0;
      window.__equipmentView.equipment.group.traverse((object) => {
        if (
          object.userData.sourceParts?.includes("Cylinder")
        )
          count = Math.max(count, object.count);
      });
      return count;
    }),
  ).toBe(1);
  expect(await page.evaluate(() => window.__equipmentStatus.poles)).toBe(1);
  await page.getByLabel("Search all assets").fill("Gas fixture");
  await page.locator('[data-search-select="Gas fixture"]').click();
  await expect(page.locator("#map-inspector h2")).toHaveText("Gas fixture");
  await expect(page.locator("#status-count")).toContainText("3 assets");
  expect(errors).toEqual([]);
});
