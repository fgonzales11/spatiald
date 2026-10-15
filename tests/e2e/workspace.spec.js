import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function mapKey(page, value = "") {
  await page.route('**/api/map-config', route => route.fulfill({
    json: { googleMapsApiKey: value },
  }));
}
async function localMap(page) {
  await page.route("**/data/workspace.json", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: await readFile(
        "tests/fixtures/tampa-electric/workspace.json",
        "utf8",
      ),
    }),
  );
  await mapKey(page);
  await page.route(/\/src\/spatial\/map2d\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: body.replace(
        "const map = new Map(",
        "const map = window.__testMap = new Map(",
      ),
    });
  });
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#102332" },
          },
        ],
      }),
    }),
  );
}
async function start(page) {
  await localMap(page);
  await page.goto("/");
  await expect(page.locator("#status-count")).toContainText("165 assets");
  await expect(page.locator("#status-map")).not.toContainText("Loading");
  await page.waitForFunction(() => window.__testMap?.loaded());
}
async function choose(page, section) {
  await page.locator(`[data-nav="${section}"]`).click();
}
const assetFile = {
  name: "user-assets.geojson",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-82.459, 27.94] },
          properties: {
            id: "user-meter-01",
            name: "Imported meter",
            utilityType: "electric",
            assetType: "meter",
          },
        },
      ],
    }),
  ),
};

test("shell, real map overlays, search, selection, layers, and page state", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page);
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toBeVisible();
  const box = await page.locator('[data-testid="map-canvas"]').boundingBox();
  expect(box.width).toBeGreaterThan(1000);
  expect(box.height).toBeGreaterThan(700);
  await page.waitForFunction(
    () =>
      window.__testMap?.isStyleLoaded() &&
      window.__testMap.queryRenderedFeatures({
        layers: ["tb-points", "tb-lines"],
      }).length > 0,
  );
  const bundle = JSON.parse(
    await readFile("tests/fixtures/tampa-electric/workspace.json", "utf8"),
  );
  const tx = bundle.assets.find((a) => a.id === "f1-tx7");
  const position = await page.evaluate((coords) => {
    const p = window.__testMap.project(coords);
    return { x: p.x, y: p.y };
  }, tx.geometry.coordinates);
  await page.locator('[data-testid="map-canvas"]').click({ position });
  await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
  await page.getByRole("button", { name: "Close asset inspector" }).click();
  await page.getByLabel("Expand sidebar", { exact: true }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/expanded/);
  await page.getByLabel("Search all assets").fill("DT-1008");
  await page.locator('[data-search-select="f1-tx7"]').click();
  await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
  await expect(page.locator("#map-inspector")).toContainText("f1-lv7");
  await openMapLayers(page);
  await page.locator('[data-layer="meter"]').uncheck();
  await expect(page.locator("#status-count")).toContainText("51 displayed");
  await choose(page, "assets");
  await expect(page.locator(".inventory-inspector")).toContainText("DT-1008");
  await page.getByLabel("Filter asset inventory").fill("DT-");
  await expect(page.locator(".table-caption")).toContainText("24 assets");
  await choose(page, "measurements");
  await expect(page.locator(".chart-metrics")).toContainText("Missing values");
  await expect(page.locator(".chart-metrics")).toContainText("4");
  await expect(
    page.getByRole("img", { name: /Active power historical chart/ }),
  ).toBeVisible();
  await choose(page, "assets");
  await expect(page.getByLabel("Filter asset inventory")).toHaveValue("DT-");
  await choose(page, "spatial");
  await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
  await expect(page.locator('[data-layer="meter"]')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("asset imports preview, persist after reload, export, and remove transactionally", async ({
  page,
}) => {
  await start(page);
  await choose(page, "sources");
  await page.locator("#import-file").setInputFiles(assetFile);
  await expect(page.locator(".import-preview")).toContainText("Assets to add");
  await expect(page.locator("#status-count")).toContainText("165 assets");
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.locator("#status-count")).toContainText("166 assets");
  await page.reload();
  await expect(page.locator("#status-count")).toContainText("166 assets");
  await expect(page.locator(".dataset-list")).toContainText(
    "user-assets.geojson",
  );
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace", exact: true })
    .click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported.assets).toHaveLength(166);
  expect(exported.terminals.length).toBeGreaterThan(0);
  await page
    .locator(".dataset")
    .filter({ hasText: "user-assets.geojson" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Remove dataset", exact: true })
    .click();
  await expect(page.locator("#status-count")).toContainText("165 assets");
});

test("invalid imports report errors without changing records", async ({
  page,
}) => {
  await start(page);
  await choose(page, "sources");
  const bad = {
    ...assetFile,
    name: "invalid.geojson",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [999, 28] },
            properties: {
              id: "bad",
              name: "Bad",
              utilityType: "electric",
              assetType: "meter",
            },
          },
        ],
      }),
    ),
  };
  await page.locator("#import-file").setInputFiles(bad);
  await expect(page.locator(".validation-errors")).toContainText(
    "Invalid WGS84",
  );
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.locator("#status-count")).toContainText("165 assets");
});

test("CSV measurements, missing values, and canonical workspace round trip", async ({
  page,
}) => {
  await start(page);
  await choose(page, "sources");
  await page.locator("#import-file").setInputFiles({
    name: "temperatures.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "asset_id,quantity,unit,observed_at,value,quality\nf1-tx0,Temperature,C,2026-10-11T12:00:00Z,30,good\nf1-tx0,Temperature,C,2026-10-11T12:15:00Z,,missing\n",
    ),
  });
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.locator(".dataset-list")).toContainText("temperatures.csv");
  await page.getByLabel("Search all assets").fill("DT-1001");
  await page.locator('[data-search-select="f1-tx0"]').click();
  await page.locator('[data-measure="f1-tx0"]').click();
  await page
    .getByLabel("Measurement series")
    .selectOption({ label: "Temperature (C)" });
  await expect(page.locator(".chart-metrics")).toContainText("Missing values");
  await expect(page.locator("tbody")).toContainText("missing");
  await choose(page, "sources");
  const demo = await readFile(
    "tests/fixtures/tampa-electric/workspace.json",
    "utf8",
  );
  await page.locator("#import-file").setInputFiles({
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(demo),
  });
  await expect(page.locator(".import-preview")).toContainText(
    "New browser workspace",
  );
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.locator("#workspace-selector")).toContainText("imported");
  await page.reload();
  await expect(
    page.locator("#workspace-selector option:checked"),
  ).toContainText("imported");
  await expect(page.locator("#status-count")).toContainText("165 assets");
});

test("map provider failure retains a rendered network and missing key opens settings", async ({
  page,
}) => {
  await localMap(page);
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#status-count")).toContainText("165 assets");
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible();
  await expect(page.locator("#status-map")).toContainText(
    "Context unavailable",
  );
  await page.getByLabel("Use 3D map").click();
  await expect(page.locator("#map-notice")).toContainText(
    "needs a Google Maps JavaScript API key",
  );
  await page
    .locator("#map-notice")
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.locator("#content-page")).toContainText(
    "VITE_GOOGLE_MAPS_API_KEY",
  );
});

test("configured 3D credential failure falls back to a usable 2D view", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await localMap(page);
  await mapKey(page, "test-key");
  await page.route("https://maps.googleapis.com/maps/api/js?**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/javascript",
      body: "",
    }),
  );
  await page.goto("/");
  await expect(page.locator('[data-testid="map-canvas"]')).toBeVisible();
  await expect(page.locator("#map-notice")).toContainText(
    "Google Maps could not connect",
  );
  await expect(page.locator("#map-notice")).toContainText("Retry 3D");
  expect(errors).toEqual([]);
});

test("unavailable rendering keeps the asset workflow accessible", async ({
  page,
}) => {
  await localMap(page);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type.startsWith("webgl")) return null;
      return getContext.call(this, type, ...args);
    };
  });
  await page.goto("/");
  await expect(page.locator("#map-empty")).toBeVisible();
  await page
    .locator("#map-empty")
    .getByRole("button", { name: "Browse assets" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Asset inventory" }),
  ).toBeVisible();
  await expect(page.locator(".table-caption")).toContainText("165 assets");
});

test("browser storage failure reports save errors and preserves the current workspace", async ({
  page,
}) => {
  await localMap(page);
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", { get: () => null }),
  );
  await page.goto("/");
  await expect(page.locator("#status-count")).toContainText("165 assets");
  await choose(page, "sources");
  await page.locator("#import-file").setInputFiles(assetFile);
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(page.locator("#toast")).toContainText("could not be saved");
  await expect(page.locator("#status-count")).toContainText("165 assets");
});

test("settings, themes, and workspace metadata", async ({ page }) => {
  await start(page);
  await choose(page, "settings");
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("My utility workspace");
  await page
    .getByLabel("Workspace timezone", { exact: true })
    .fill("America/Los_Angeles");
  await page
    .getByRole("button", { name: "Save workspace preferences" })
    .click();
  await expect(page.locator("#workspace-selector")).toContainText(
    "My utility workspace",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Workspace timezone")).toHaveValue(
    "America/Los_Angeles",
  );
  await expect(
    page.getByRole("button", { name: "Reset demo", exact: true }),
  ).toHaveCount(0);
});

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [768, 1024],
  [390, 844],
]) {
  test(`layout stays inside the viewport at ${width}×${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    const measurements = await page.evaluate(() => {
      const rect = (s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      };
      return {
        header: rect(".topbar"),
        footer: rect(".statusbar"),
        map: rect("#map-host"),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(measurements.overflow).toBe(false);
    expect(measurements.header.bottom).toBe(60);
    expect(measurements.footer.bottom).toBe(height);
    expect(measurements.map.bottom).toBeLessThanOrEqual(
      measurements.footer.top,
    );
    if (width < 761) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.locator('[data-nav="assets"]').click();
      await expect(page.locator(".app-shell")).not.toHaveClass(/drawer-open/);
    } else await choose(page, "assets");
    await expect(
      page.getByRole("heading", { name: "Asset inventory" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({ path: `test-results/layout-${width}.png` });
    if (width === 390) {
      await page.getByLabel("Search all assets").fill("DT-1008");
      await page.locator('[data-search-select="f1-tx7"]').click();
      await expect(page.locator("#map-inspector h2")).toHaveText("DT-1008");
      const inspector = await page.locator("#map-inspector").boundingBox();
      const attribution = await page
        .locator(".maplibregl-ctrl-attrib")
        .boundingBox();
      const footer = await page.locator(".statusbar").boundingBox();
      const tools = await page.locator(".map-tools").boundingBox();
      expect(tools.y + tools.height).toBeLessThan(attribution.y);
      expect(attribution.y + attribution.height).toBeLessThan(inspector.y);
      expect(inspector.y + inspector.height).toBeLessThan(footer.y);
      await page.screenshot({ path: "test-results/mobile-inspector.png" });
    }
  });
}
