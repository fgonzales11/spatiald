import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { mockSpatialProviders, ready } from "./helpers/spatial-providers.js";

// A small unlit, colored terrain tile exercises the real Three.js/cloud pipeline
// without depending on Google credentials, provider availability, or imagery.

test("3D environment renders, toggles cloud work, persists choices, and preserves inspection", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockSpatialProviders(page);
  await page.goto("/");
  await ready(page);
  await expect(page.getByLabel("Clouds", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Cloud coverage")).toHaveValue("0.2");
  await expect(page.locator("#environment-options")).toContainText(
    "Low quality",
  );
  await page.waitForFunction(
    () => window.__testAerial.overlay?.map?.image?.width > 1,
  );
  await page.getByLabel("Search all assets").fill("DT-1008");
  await page.locator('[data-search-select="f1-tx7"]').click();
  await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
  await openMapLayers(page);
  await page.getByLabel("Clouds", { exact: true }).uncheck();
  await expect(page.getByLabel("Cloud coverage")).toBeDisabled();
  await page.waitForFunction(() => window.__testAerial.overlay === null);
  const frame = await page.evaluate(() => window.__testClouds.frame);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__testClouds.frame)).toBe(frame);
  await page.reload();
  await ready(page);
  await expect(page.getByLabel("Clouds", { exact: true })).not.toBeChecked();
  await openMapLayers(page);
  await page.getByLabel("Clouds", { exact: true }).check();
  await page.waitForFunction(
    () =>
      window.__testClouds.frame > 0 &&
      window.__testAerial.overlay?.map?.image?.width > 1,
  );
  await openMapLayers(page);
  await page.getByLabel("Cloud coverage").fill("0.1");
  await openMapLayers(page);
  await page.getByLabel("Cloud coverage").dispatchEvent("change");
  await expect(page.locator("#cloud-coverage-value")).toHaveText("10%");
  await page.getByLabel("Search all assets").fill("DT-1008");
  await page.locator('[data-search-select="f1-tx7"]').click();
  await page.getByLabel("Use 2D map").click();
  await page.waitForFunction(() =>
    window.__testRenderers[0].getContext().isContextLost(),
  );
  await page.getByLabel("Use 3D map").click();
  await ready(page);
  await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
  await expect(page.getByLabel("Cloud coverage")).toHaveValue("0.1");
  await expect(page.locator(".google-attribution")).toBeVisible();
  await page.getByLabel("Close asset inspector").click();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openMapLayers(page);
    const layers = await page.locator("#map-layers").boundingBox();
    const footer = await page.locator(".statusbar").boundingBox();
    expect(layers.y + layers.height).toBeLessThan(footer.y);
    expect(layers.x + layers.width).toBeLessThanOrEqual(width);
  }
  expect(errors).toEqual([]);
});

test("failed cloud textures retain the 3D map and dispose safely while warming up", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockSpatialProviders(page);
  await page.route("**/environment/shape.bin", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#toast")).toContainText(
    "Sky and clouds could not load",
    { timeout: 30000 },
  );
  await expect(page.locator('[data-map-mode="3d"]')).toHaveClass(/active/);
  await expect(page.locator(".google-attribution")).toBeVisible();
  await page.getByLabel("Use 2D map").click();
  await page.waitForFunction(
    () => window.__testRenderers[0].getContext().isContextLost(),
    null,
    { timeout: 60000 },
  );
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test("batched OSM point selection takes priority over nearby lines in 3D and persists in 2D", async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockSpatialProviders(page);
  await page.route("**/environment/shape.bin", (route) => route.abort());
  const bounds = [-82.51, 27.89, -82.49, 27.91];
  const properties = (id, group, name, tags) => ({
    id,
    group,
    name,
    tags,
    osmType: id.split(":")[1],
    osmId: id.split(":")[2],
    version: 1,
    timestamp: "2026-10-01T00:00:00Z",
    sourceFiles: ["map1.osm"],
  });
  const roads = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: properties("osm:way:1", "roads", "Nearby road", {
          highway: "residential",
        }),
        geometry: {
          type: "LineString",
          coordinates: [
            [-82.501, 27.89991],
            [-82.499, 27.89991],
          ],
        },
      },
    ],
  };
  const utilities = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: properties("osm:node:2", "utilities", "Mapped pole", {
          power: "pole",
        }),
        geometry: { type: "Point", coordinates: [-82.5, 27.9] },
      },
    ],
  };
  await page.route("**/data/osm/tampa-bay/**", (route) => {
    const file = route.request().url().split("/").at(-1);
    const data =
      file === "manifest.json"
        ? {
            schemaVersion: 1,
            layers: [
              {
                id: "roads",
                name: "Roads",
                color: "#91b5c6",
                defaultVisible: true,
                count: 1,
                file: "roads.geojson",
              },
              {
                id: "utilities",
                name: "OSM utility features",
                color: "#ffb66e",
                defaultVisible: true,
                count: 1,
                file: "utilities.geojson",
              },
            ],
            bounds,
            files: [],
            omissions: {},
            featureCount: 2,
            name: "Test source coverage",
          }
        : file === "roads.geojson"
          ? roads
          : utilities;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/");
  await page.waitForFunction(() =>
    window.__testSpatial?.contextOverlay.children.some(
      (object) => object.isPoints,
    ),
  );
  await openMapLayers(page);
  await page.getByRole("button", { name: "Local OSM layers" }).click();
  await openMapLayers(page);
  await page.getByRole("button", { name: "Go to downloaded area" }).click();
  const position = await page.evaluate(() => {
    const { camera, contextOverlay, renderer } = window.__testSpatial;
    contextOverlay.updateMatrixWorld(true);
    const points = contextOverlay.children.find((object) => object.isPoints);
    const attribute = points.geometry.attributes.position;
    const projected = camera.position
      .clone()
      .set(attribute.getX(0), attribute.getY(0), attribute.getZ(0))
      .applyMatrix4(points.matrixWorld)
      .project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  });
  await page.locator("#map-host canvas").click({ position });
  await expect(page.locator("#map-inspector h2")).toHaveText("Mapped pole");
  await expect(page.locator("#map-inspector")).toContainText("node/2");
  await page.getByLabel("Use 2D map").click();
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#map-inspector h2")).toHaveText("Mapped pole");
  expect(errors).toEqual([]);
});
