import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { publicMap } from "./helpers/public-map.js";
import { PUBLIC_LAYERS } from "../../src/data/public-layers.js";

// The national network exercises the desktop browser's accelerated renderer.
test.use({ channel: "chromium" });

test("real nationwide tiles render without a bulk source query, remain cached on pan, and open a full source record", async ({ page }) => {
  test.setTimeout(60000);
  const errors = [], tileResponses = [], sourceLookups = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (/us-transmission\/tiles\/.*\.pbf/.test(response.url())) tileResponses.push({ url: response.url(), status: response.status(),
      encoding: response.headers()["content-encoding"], cache: response.headers()["cache-control"] });
  });
  const mock = await publicMap(page);
  await page.route("**/data/us-transmission/manifest.json", async (route) => route.fulfill({ response: await route.fetch() }));
  await page.route(/\/src\/spatial\/transmission-additive\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("const overlay = new MapLibreOverlay(", "const overlay = window.__testTransmission = new MapLibreOverlay(") });
  });
  const layer = PUBLIC_LAYERS.find((source) => source.id === "public-transmission");
  await page.route(`${layer.endpoint}/query**`, (route) => {
    const id = new URL(route.request().url()).searchParams.get("objectIds");
    if (!id) return route.fallback();
    sourceLookups.push(id);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ spatialReference: { wkid: 4326 },
      features: [{ attributes: { OBJECTID_1: Number(id), ID: `selected-${id}`, OWNER: "Full source record", VOLTAGE: 230 },
        geometry: { paths: [[[-95.652864, 37.502299], [-95.25, 37.368]]] } }],
    }) });
  });
  await page.goto("/");
  await waitTiles(page);
  await expect(page.locator('[data-public-count="public-transmission"]')).toHaveText("94,619");
  await openMapLayers(page);
  await expect(page.getByRole("button", { name: "View entire U.S." })).toBeVisible();
  expect(mock.areas).toHaveLength(0);
  expect(tileResponses.length).toBeGreaterThan(0);
  expect(tileResponses.every((response) => response.status === 200)).toBe(true);
  expect(tileResponses.every((response) => response.encoding === "gzip" && response.cache.includes("immutable"))).toBe(true);
  expect(await page.evaluate(() => window.__testMap.getLayoutProperty("tb-substations", "visibility"))).toBe("none");
  const originalRequests = tileResponses.length;
  await page.evaluate(() => window.__testMap.panBy([40, 0], { duration: 0 }));
  await waitTiles(page);
  expect(tileResponses.length).toBeLessThanOrEqual(originalRequests + 2);
  const picked = await page.evaluate(() => {
    const p = window.__testMap.project([-95.525626, 37.46503]);
    const hit = window.__testTransmission.pickObject({ x: p.x, y: p.y, radius: 4, layerIds: ["tb-national-transmission"] });
    return { point: { x: p.x, y: p.y }, id: hit?.object.properties.externalId };
  });
  expect(picked.id).toBeTruthy();
  await page.locator('[data-testid="map-canvas"]').click({ position: picked.point });
  await expect(page.locator("#map-inspector h2")).toContainText("Full source record");
  expect(sourceLookups).toEqual([String(picked.id)]);
  await page.getByRole("button", { name: "Close asset inspector" }).click();
  await openMapLayers(page);
  await page.locator('[data-layer="transmission_line"]').uncheck();
  expect(await page.evaluate(() => window.__testTransmission._deck.props.layers.filter(Boolean).some((layer) => layer.id === "tb-national-transmission"))).toBe(false);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Alaska", exact: true }).click();
  await waitTiles(page);
  expect(await page.evaluate(() => window.__testMap.getCenter().lat)).toBeGreaterThan(55);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Hawaii", exact: true }).click();
  await waitTiles(page);
  expect(await page.evaluate(() => window.__testMap.getCenter().lng)).toBeLessThan(-154);
  await openMapLayers(page);
  await page.getByRole("button", { name: "View entire U.S." }).click();
  await waitTiles(page);
  await page.screenshot({ path: "/tmp/tidebound-national-transmission.png" });
  expect(errors).toEqual([]);
  expect(tileResponses.every((response) => response.status === 200)).toBe(true);
});

async function waitTiles(page) {
  await page.waitForFunction(() => {
    const layer = window.__testTransmission?._deck?.props.layers.find((layer) => layer?.id === "tb-national-transmission");
    return window.__testMap?.loaded() && !window.__testMap.isMoving() && layer?.isLoaded
      && layer.state.tileset.tiles.some((tile) => tile.content);
  });
}
