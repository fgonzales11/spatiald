import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { publicMap, ready } from "./helpers/public-map.js";

test("default public layers render, inspect, paginate, toggle, export, and follow the map area", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mock = await publicMap(page);
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#section-name > span")).toHaveText("United States");
  await expect(page.locator("#workspace-badge")).toHaveText("Public");
  await expect(page.locator("[data-layer]")).toHaveCount(3);
  await expect(page.locator(".public-attribution")).toBeVisible();
  await openMapLayers(page);
  await page.getByLabel("Highway cameras").uncheck();
  await page.evaluate(() => window.__testMap.jumpTo({ center: [-82.458, 27.948], zoom: 20 }));
  await page.waitForFunction(() => window.__testMap.loaded());
  const p = await page.evaluate(() => {
    const p = window.__testMap.project([-82.458, 27.948]);
    return { x: p.x, y: p.y };
  });
  await page.locator('[data-testid="map-canvas"]').click({ position: p });
  await expect(page.locator("#map-inspector h2")).toHaveText(
    "Published substation 1",
  );
  await expect(page.locator("#map-inspector")).toContainText(
    "Connectivity unavailable",
  );
  await expect(page.locator("#map-inspector .asset-status")).toContainText(
    "Public source",
  );
  await openMapLayers(page);
  await page.locator('[data-layer="gas_main"]').uncheck();
  await expect(page.locator("#status-count")).toContainText("105 displayed");
  await page.locator('[data-nav="assets"]').click();
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.locator('[data-nav="sources"]').click();
  await expect(page.locator(".dataset-list")).toContainText("Public source");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const downloaded = await downloadPromise;
  const exported = JSON.parse(await readFile(await downloaded.path(), "utf8"));
  expect(exported.assets).toHaveLength(107);
  expect(exported.networks).toEqual([]);
  expect(exported.observations).toEqual([]);
  expect(exported.assets.every((asset) => asset.id.startsWith("public-"))).toBe(
    true,
  );
  await page.reload();
  await expect(page.locator("#status-count")).toContainText("105 displayed");
  await page.locator('[data-nav="spatial"]').click();
  await expect(page.locator('[data-layer="gas_main"]')).not.toBeChecked();
  await page.waitForFunction(() => window.__testMap?.loaded());
  await page.evaluate(() =>
    window.__testMap.jumpTo({ center: [-80.2, 25.78], zoom: 10.6 }),
  );
  await expect
    .poll(() => mock.areas.some((area) => area.xmin > -81))
    .toBe(true);
  await page.getByLabel("Search all assets").fill("Miami substation 1");
  await expect(page.locator("#search-results")).toContainText(
    "Miami substation 1",
  );
  expect(errors).toEqual([]);
});

test("a public API failure retains cached records and offers a working retry", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mock = await publicMap(page);
  await page.goto("/");
  await ready(page);
  mock.failGas = true;
  await openMapLayers(page);
  await page.locator('#layer-list [data-action="refresh-public"]').click();
  await expect(
    page.locator("#layer-list .public-layer-status").filter({ hasText: "503" }),
  ).toHaveCount(1);
  await expect(page.locator("#status-count")).toContainText("107 assets");
  mock.failGas = false;
  await openMapLayers(page);
  await page.locator('[data-refresh-layer="public-gas-pipelines"]').click();
  await expect(page.locator("#layer-list .public-layer-status")).toHaveCount(0);
  await expect(
    page.locator('[data-public-count="public-gas-pipelines"]'),
  ).toHaveText("2");
  await page.locator('[data-nav="measurements"]').click();
  await expect(page.locator(".measured-assets")).toContainText(
    "Import observation CSV",
  );
  expect(errors).toEqual([]);
});
