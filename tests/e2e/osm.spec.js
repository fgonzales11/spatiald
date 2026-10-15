import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { publicMap, ready } from "./helpers/public-map.js";

test("local OSM layers render, inspect source tags, toggle, and preserve preferences without becoming utility assets", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await publicMap(page);
  await page.goto("/");
  await ready(page);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Local OSM layers" }).click();
  await expect(page.locator("[data-osm-layer]")).toHaveCount(6);
  await expect(page.locator('[data-osm-layer="roads"]')).toBeChecked();
  await expect(page.locator('[data-osm-layer="buildings"]')).not.toBeChecked();
  await expect(page.locator(".osm-attribution")).toBeVisible();
  await openMapLayers(page);
  await page.getByRole("button", { name: "Go to downloaded area" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__testMap.getCenter().lat))
    .toBeLessThan(27.94);
  await openMapLayers(page);
  await page.locator('[data-osm-layer="buildings"]').check();
  await page.waitForFunction(() =>
    window.__testMap.getLayer("osm-buildings-fill"),
  );
  await openMapLayers(page);
  await page.locator('[data-osm-layer="utilities"]').uncheck();
  await openMapLayers(page);
  await page.locator('[data-osm-layer="utilities"]').check();
  const data = JSON.parse(
    await readFile("public/data/osm/tampa-bay/utilities.geojson", "utf8"),
  );
  const pole = data.features.find(
    (feature) =>
      feature.geometry.type === "Point" &&
      feature.properties.tags.power === "pole",
  );
  await page.evaluate(
    (coordinates) => window.__testMap.jumpTo({ center: coordinates, zoom: 18 }),
    pole.geometry.coordinates,
  );
  await page.waitForFunction(() => window.__testMap.loaded());
  const point = await page.evaluate((coordinates) => {
    const p = window.__testMap.project(coordinates);
    return { x: p.x, y: p.y };
  }, pole.geometry.coordinates);
  await page.locator('[data-testid="map-canvas"]').click({ position: point });
  await expect(page.locator("#map-inspector")).toContainText(
    "Local OSM feature",
  );
  await expect(page.locator("#map-inspector")).toContainText(
    pole.properties.osmId,
  );
  await expect(page.locator("#map-inspector")).toContainText("OSM tags");
  await page.getByLabel("Close map feature inspector").click();
  await openMapLayers(page);
  await page.locator('[data-osm-layer="roads"]').uncheck();
  await page.reload();
  await ready(page);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Local OSM layers" }).click();
  await expect(page.locator('[data-osm-layer="roads"]')).not.toBeChecked();
  await expect(page.locator('[data-osm-layer="buildings"]')).toBeChecked();
  await page.waitForFunction(() =>
    window.__testMap.getLayer("osm-buildings-fill"),
  );
  await page.locator('[data-nav="sources"]').click();
  await expect(page.locator(".osm-source")).toContainText("32,202 features");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const exported = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  expect(exported.assets.every((asset) => !asset.id.startsWith("osm:"))).toBe(
    true,
  );
  expect(exported.networks).toEqual([]);
  expect(errors).toEqual([]);
});

test("missing local data offers retry while public utility records remain usable", async ({
  page,
}) => {
  await publicMap(page);
  let fail = true;
  await page.route("**/data/osm/tampa-bay/roads.geojson", (route) =>
    fail
      ? route.fulfill({ status: 503, body: "Unavailable" })
      : route.continue(),
  );
  await page.goto("/");
  await ready(page);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Local OSM layers" }).click();
  await expect(page.locator("#osm-layer-list")).toContainText("503");
  await expect(page.locator("#status-count")).toContainText("107 assets");
  fail = false;
  await openMapLayers(page);
  await page.locator('[data-osm-retry="roads"]').click();
  await page.waitForFunction(() => window.__testMap.getSource("osm-roads"));
  await expect(page.locator("#osm-layer-list")).not.toContainText("503");
});

test("expanded local layer controls stay scrollable and clear of the footer on small screens", async ({
  page,
}) => {
  await publicMap(page);
  await page.goto("/");
  await ready(page);
  await openMapLayers(page);
  await page.getByRole("button", { name: "Local OSM layers" }).click();
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .getByRole("button", { name: "Go to downloaded area" })
      .scrollIntoViewIfNeeded();
    const panel = await page.locator("#map-layers").boundingBox();
    const footer = await page.locator(".statusbar").boundingBox();
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
    expect(panel.y + panel.height).toBeLessThan(footer.y);
    await expect(page.locator(".osm-attribution")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
  }
});
