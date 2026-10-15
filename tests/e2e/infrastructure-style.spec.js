import { openMapLayers } from './helpers/map-controls.js';
import { test, expect } from "@playwright/test";
import { publicMap } from "./helpers/public-map.js";
import { PUBLIC_LAYERS } from "../../src/data/public-layers.js";

for (const pixelRatio of [1, 2]) {
  test.describe(`infrastructure rendering at pixel ratio ${pixelRatio}`, () => {
    test.use({ deviceScaleFactor: pixelRatio });
    test("small black diamonds and additive transmission overlaps render and remain selectable after style reload", async ({ page }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await publicMap(page);
      for (const layer of PUBLIC_LAYERS.filter((layer) => layer.adapter === "arcgis"))
        await page.route(`${layer.endpoint}/query**`, (route) => {
          const url = new URL(route.request().url());
          const stations = layer.assetType === "substation";
          const records = stations
            ? [230, 115, -999999].map((voltage, i) => ({
                attributes: { OBJECTID: i + 1, NAME: `Station ${voltage > 0 ? voltage : "unknown"}`, MAX_VOLT: voltage },
                geometry: { x: -82.458 + i * 0.06, y: 27.948 - i * 0.06 },
              }))
            : [230, 500].map((voltage, i) => ({
                attributes: { OBJECTID_1: i + 1, ID: `line-${i}`, VOLTAGE: voltage },
                geometry: { paths: [[[i === 0 ? -82.52 : -82.47, 27.90], [-82.42, 27.90]]] },
              }));
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(
            url.searchParams.has("returnCountOnly") ? { count: records.length } : { spatialReference: { wkid: 4326 }, features: records },
          ) });
        });
      await page.goto("/");
      await expect(page.locator("#status-count")).toContainText("7 assets");
      await page.waitForFunction(() => window.__testMap?.loaded());
      await openMapLayers(page);
      await page.getByLabel("Highway cameras").uncheck();
      await expect(page.getByLabel("Substation voltage legend")).toHaveCount(0);
      await openMapLayers(page);
      await page.getByRole("button", { name: /Local OSM layers/ }).click();
      const enabled = await page.locator('[data-osm-layer]:checked').evaluateAll((inputs) => inputs.map((input) => input.dataset.osmLayer));
      for (const id of enabled) await page.locator(`[data-osm-layer="${id}"]`).uncheck();
      const style = await page.evaluate(async () => {
        const map = window.__testMap;
        const features = (await map.getSource("tb-assets").getData()).features;
        return {
          stations: features.filter((feature) => feature.properties.assetType === "substation").map((feature) => feature.properties),
          transmission: features.filter((feature) => feature.properties.assetType === "transmission_line").map((feature) => feature.properties.displayColor),
          stationType: map.getLayer("tb-substations").type,
          stationImage: map.getLayoutProperty("tb-substations", "icon-image"),
          lineOpacity: map.getPaintProperty("tb-lines", "line-opacity"),
          rotation: map.getLayoutProperty("tb-substations", "icon-rotate"),
          additive: map.getLayer("deck-maplibre-layer-group-before:tb-substations").type,
        };
      });
      expect(style.stationType).toBe("symbol");
      expect(style.stationImage).toBe("substation-diamond");
      expect(style.rotation).toBe(45);
      expect(style.additive).toBe("custom");
      expect(style.stations.every((station) => station.displayColor === "#000000")).toBe(true);
      expect(style.transmission).toEqual(["#5387b9", "#5387b9"]);
      expect(style.lineOpacity).toContain(0);
      const brightness = await sampleTransmission(page);
      expect(brightness.single).toBeGreaterThan(70);
      expect(brightness.overlap).toBeGreaterThan(brightness.single + 35);
      expect(await page.evaluate(() => window.__testMap.getLayoutProperty("tb-substations", "visibility"))).toBe("none");
      await page.evaluate(() => window.__testMap.jumpTo({ center: [-82.458, 27.948], zoom: 20 }));
      await page.waitForFunction(() => window.__testMap.loaded());
      expect(await page.evaluate(() => window.__testMap.getLayoutProperty("tb-substations", "visibility"))).toBe("visible");
      const point = await page.evaluate(() => {
        const p = window.__testMap.project([-82.458, 27.948]); return { x: p.x, y: p.y };
      });
      await page.locator('[data-testid="map-canvas"]').click({ position: point });
      await expect(page.locator("#map-inspector h2")).toHaveText("Station 230");
      expect(await page.evaluate(() => window.__testMap.getPaintProperty("tb-substations", "icon-color"))).toEqual(["get", "displayColor"]);
      await page.evaluate(() => window.__testMap.setStyle({ version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#102332" } }] }));
      await page.waitForFunction(() => window.__testMap.loaded() && window.__testMap.hasImage("substation-diamond"));
      await expect(page.locator("#map-inspector h2")).toHaveText("Station 230");
      await page.evaluate(() => window.__testMap.jumpTo({ center: [-82.475, 27.90], zoom: 14, bearing: 30 }));
      await page.waitForFunction(() => window.__testMap.loaded());
      const restored = await sampleTransmission(page);
      expect(restored.single).toBeGreaterThan(70);
      expect(restored.overlap).toBeGreaterThan(restored.single + 35);
      await openMapLayers(page);
      await page.locator('[data-layer="substation"]').uncheck();
      await expect(page.getByLabel("Substation voltage legend")).toHaveCount(0);
      await page.getByRole("button", { name: "Close asset inspector" }).click();
      const linePoint = await page.evaluate(() => { const p = window.__testMap.project([-82.50, 27.90]); return { x: p.x, y: p.y }; });
      await page.locator('[data-testid="map-canvas"]').click({ position: linePoint });
      await expect(page.locator("#map-inspector h2")).toContainText("line-0");
      await openMapLayers(page);
      await page.locator('[data-layer="transmission_line"]').uncheck();
      const hidden = await sampleTransmission(page);
      expect(hidden.single).toBe(50);
      expect(hidden.overlap).toBe(50);
      expect(errors).toEqual([]);
    });

  });
}

async function sampleTransmission(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const map = window.__testMap;
    map.once("render", () => {
      const gl = map.getCanvas().getContext("webgl2");
      const sample = (coordinates) => {
        const p = map.project(coordinates), ratio = map.getPixelRatio();
        const pixel = new Uint8Array(4);
        let maxBlue = 0;
        for (let y = -2; y <= 2; y++) {
          gl.readPixels(Math.round(p.x * ratio), gl.drawingBufferHeight - Math.round(p.y * ratio) - 1 + y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          maxBlue = Math.max(maxBlue, pixel[2]);
        }
        return maxBlue;
      };
      resolve({ single: sample([-82.50, 27.90]), overlap: sample([-82.45, 27.90]) });
    });
    map.triggerRepaint();
  }));
}
