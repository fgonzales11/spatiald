import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { publicMap, ready } from "./helpers/public-map.js";
import { mockSpatialProviders } from "./helpers/spatial-providers.js";
import { HIGHWAY_CAMERAS } from "../../src/data/highway-cameras.js";
import { offsetMeters } from "../../src/spatial/pole-placement.js";

const feature = HIGHWAY_CAMERAS.features.find((f) => f.properties.id === "2235");

async function brokenFeed(page) {
  const requests = [];
  await page.route("**/api/highway-cameras/**", (route) => {
    requests.push(route.request().url());
    if (route.request().url().includes("/snapshot")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=", "base64") });
    return route.fulfill({ contentType: "application/vnd.apple.mpegurl", body: "Feed temporarily unavailable" });
  });
  return requests;
}

async function click2dCamera(page) {
  await page.evaluate((coordinates) => window.__testMap.jumpTo({ center: coordinates, zoom: 20 }), feature.geometry.coordinates);
  await page.waitForFunction(() => window.__testMap.loaded());
  const position = await page.evaluate((coordinates) => {
    const p = window.__testMap.project(coordinates);
    return { x: p.x, y: p.y };
  }, feature.geometry.coordinates);
  await page.locator('[data-testid="map-canvas"]').click({ position });
}

test("2D camera symbols open HLS popups, retry, dispose and persist layer visibility", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await publicMap(page);
  const requests = await brokenFeed(page);
  await page.goto("/");
  await ready(page);
  await expect(page.getByLabel("Highway cameras")).toBeChecked();
  const catalog = await page.evaluate(async () => ({
    count: (await window.__testMap.getSource("tb-highway-cameras").getData()).features.length,
    type: window.__testMap.getLayer("tb-highway-cameras").type,
  }));
  expect(catalog).toEqual({ count: 366, type: "symbol" });
  await click2dCamera(page);
  const popup = page.getByRole("dialog", { name: /Live highway camera/ });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(feature.properties.location);
  await expect(popup.locator("video")).toHaveAttribute("controls", "");
  await expect(popup.locator(".camera-feed-status")).toContainText("Live video unavailable");
  await expect(popup.locator(".camera-snapshot")).toBeVisible();
  await expect.poll(() => popup.locator(".camera-snapshot").evaluate((img) => img.naturalWidth)).toBe(1);
  await expect(popup.locator("video")).toBeHidden();
  expect(requests.some((url) => url.includes(`/api/highway-cameras/${feature.id}/snapshot`))).toBe(true);
  const box = await popup.boundingBox();
  const mapBox = await page.locator("#map-host").boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(mapBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(mapBox.y + mapBox.height);
  expect(requests[0]).toContain(`/api/highway-cameras/${feature.id}/stream`);
  const previousCount = requests.length;
  await popup.getByRole("button", { name: "Retry feed" }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(previousCount);
  await popup.getByRole("button", { name: "Try video" }).click();
  await expect(popup.locator(".camera-feed-status")).toContainText("Live video unavailable");
  await page.evaluate(() => { window.__cameraVideo = document.querySelector(".highway-camera-popup video"); window.__cameraImage = document.querySelector(".camera-snapshot"); });
  await page.getByRole("button", { name: "Close live camera" }).click();
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => window.__cameraVideo.paused && !window.__cameraVideo.hasAttribute("src"))).toBe(true);
  expect(await page.evaluate(() => !window.__cameraImage.hasAttribute("src"))).toBe(true);
  await click2dCamera(page);
  await expect(popup).toBeVisible();
  await openMapLayers(page);
  await page.getByLabel("Highway cameras").uncheck();
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => window.__testMap.getLayoutProperty("tb-highway-cameras", "visibility"))).toBe("none");
  await page.reload();
  await ready(page);
  await expect(page.getByLabel("Highway cameras")).not.toBeChecked();
  await openMapLayers(page);
  await page.getByLabel("Highway cameras").check();
  await click2dCamera(page);
  await expect(popup).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(popup).toBeVisible();
  await expect.poll(async () => {
    const box = await popup.boundingBox();
    const map = await page.locator("#map-host").boundingBox();
    return box.x >= map.x && box.x + box.width <= map.x + map.width && box.y >= map.y && box.y + box.height <= map.y + map.height;
  }).toBe(true);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("2D cameras appear below the 10,000-foot view extent and stop feeds when zoomed out or panned out of view", async ({ page }) => {
  await publicMap(page);
  const requests = await brokenFeed(page);
  await page.goto("/");
  await ready(page);
  const setExtent = (feet) => page.evaluate(({ center, feet }) => {
    const halfLongitude = feet * 0.3048 / (2 * 6371008.8 * Math.PI / 180 * Math.cos(center[1] * Math.PI / 180));
    window.__testMap.fitBounds([[center[0] - halfLongitude, center[1] - 0.00001], [center[0] + halfLongitude, center[1] + 0.00001]], { padding: 0, duration: 0 });
  }, { center: feature.geometry.coordinates, feet });
  const visibleIds = () => page.evaluate(() => window.__testMap.getFilter("tb-highway-cameras")[2][1]);
  await setExtent(9900);
  expect(await visibleIds()).toContain(feature.id);
  await setExtent(10100);
  expect(await visibleIds()).not.toContain(feature.id);
  expect(requests).toHaveLength(0);
  await click2dCamera(page);
  const popup = page.getByRole("dialog", { name: /Live highway camera/ });
  await expect(popup).toBeVisible();
  await page.evaluate(() => { window.__cameraVideo = document.querySelector(".highway-camera-popup video"); });
  await setExtent(10100);
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => window.__cameraVideo.paused && !window.__cameraVideo.hasAttribute("src"))).toBe(true);
  await click2dCamera(page);
  await expect(popup).toBeVisible();
  await page.evaluate((center) => window.__testMap.jumpTo({ center, zoom: 20 }), offsetMeters(feature.geometry.coordinates, 350, 0));
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.__testMap.getSource("tb-highway-cameras").getData()).features.length)).toBe(366);
});

test("3D camera sprites remain visible in neighborhood views and release feeds beyond 10,000 feet or when switching views", async ({ page }) => {
  test.setTimeout(60000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockSpatialProviders(page);
  await page.route("**/environment/shape.bin", (route) => route.abort());
  await page.route(/\/src\/spatial\/map3d\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      "function clearOverlay() {",
      "window.__cameraView = { cameraOverlay, camera, renderer, viewAt, groundViewExtentMeters }; function clearOverlay() {",
    ) });
  });
  const requests = await brokenFeed(page);
  await page.goto("/");
  await page.waitForFunction(() => window.__cameraView);
  await page.evaluate((coordinates) => window.__cameraView.viewAt(coordinates, 3000), feature.geometry.coordinates);
  await page.waitForFunction((id) => !window.__cameraView.cameraOverlay.children.find((s) => s.userData.cameraFeature.id === id).visible, feature.id);
  expect(requests).toHaveLength(0);
  const position = await page.evaluate(({ id, coordinates }) => {
    const { cameraOverlay, camera, renderer, viewAt } = window.__cameraView;
    viewAt(coordinates, 100);
    camera.updateMatrixWorld();
    const sprite = cameraOverlay.children.find((s) => s.userData.cameraFeature.id === id);
    cameraOverlay.updateMatrixWorld(true);
    const p = sprite.getWorldPosition(camera.position.clone()).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.x + (p.x + 1) / 2 * rect.width, y: rect.y + (1 - p.y) / 2 * rect.height, count: cameraOverlay.children.length };
  }, { id: feature.id, coordinates: feature.geometry.coordinates });
  expect(position.count).toBe(366);
  await page.waitForFunction((id) => window.__cameraView.cameraOverlay.children.find((s) => s.userData.cameraFeature.id === id).visible, feature.id);
  expect(await page.evaluate(() => window.__cameraView.groundViewExtentMeters())).toBeLessThanOrEqual(3048);
  await page.mouse.click(position.x, position.y);
  const popup = page.getByRole("dialog", { name: /Live highway camera/ });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(feature.properties.location);
  await page.evaluate(() => { window.__cameraVideo = document.querySelector(".highway-camera-popup video"); });
  await page.evaluate((coordinates) => window.__cameraView.viewAt(coordinates, 2000), feature.geometry.coordinates);
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => window.__cameraVideo.paused && !window.__cameraVideo.hasAttribute("src"))).toBe(true);
  await page.evaluate((coordinates) => window.__cameraView.viewAt(coordinates, 100), feature.geometry.coordinates);
  await page.waitForFunction((id) => window.__cameraView.cameraOverlay.children.find((s) => s.userData.cameraFeature.id === id).visible, feature.id);
  await page.mouse.click(position.x, position.y);
  await expect(popup).toBeVisible();
  await openMapLayers(page);
  await page.getByLabel("Highway cameras").uncheck();
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => window.__cameraView.cameraOverlay.visible)).toBe(false);
  await openMapLayers(page);
  await page.getByLabel("Highway cameras").check();
  await page.mouse.click(position.x, position.y);
  await expect(popup).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  await page.evaluate((coordinates) => window.__cameraView.viewAt(coordinates, 1000), feature.geometry.coordinates);
  await page.waitForFunction((id) => window.__cameraView.cameraOverlay.children.find((sprite) => sprite.userData.cameraFeature.id === id).visible, feature.id);
  expect(await page.evaluate(() => window.__cameraView.groundViewExtentMeters())).toBeLessThanOrEqual(3048);
  expect(await page.evaluate(() => window.__cameraView.groundViewExtentMeters())).toBeGreaterThan(304.8);
  expect(await page.evaluate((id) => {
    const { cameraOverlay, camera } = window.__cameraView;
    return cameraOverlay.children.find((sprite) => sprite.userData.cameraFeature.id === id).getWorldPosition(camera.position.clone()).distanceTo(camera.position);
  }, feature.id)).toBeGreaterThan(304.8);
  await expect(popup).toBeVisible();
  await page.getByLabel("Use 2D map").click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});
