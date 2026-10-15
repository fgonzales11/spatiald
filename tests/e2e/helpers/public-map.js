import { expect } from "@playwright/test";
import { PUBLIC_LAYERS } from "../../../src/data/public-layers.js";

export async function publicMap(page) {
  const state = { failGas: false, areas: [] };
  await page.route("**/data/us-transmission/manifest.json", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ version: 1, featureCount: 0, minZoom: 0,
      maxZoom: 8, tiles: {}, tileTemplate: "tiles/{z}/{x}/{y}.pbf" }),
  }));
  await page.route(/\/src\/main\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /const key\s*=\s*import\.meta\.env\.VITE_GOOGLE_MAPS_API_KEY\?\.trim\(\)\s*\|\|\s*["']{2};/,
      'const key = "";',
    );
    await route.fulfill({ response, body });
  });
  await page.route(/\/src\/spatial\/map2d\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
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
  for (const layer of PUBLIC_LAYERS)
    await page.route(`${layer.endpoint}**`, async (route) => {
      const url = new URL(route.request().url());
      const respond = (body) =>
        route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(body),
        });
      if (layer.adapter === "ods") {
        if (state.failGas)
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ message: "Temporarily unavailable" }),
          });
        if (!url.pathname.endsWith("records"))
          return respond({
            metas: { default: { modified: "2025-12-09T03:27:24Z" } },
          });
        return respond({
          total_count: 2,
          results: [1, 2].map((fid) => ({
            fid,
            operator: "Published pipeline operator",
            status: "Operating",
            typepipe: "Interstate",
            geo_shape: {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: [
                  [-82.52 + fid * 0.01, 27.91],
                  [-82.45, 27.98],
                ],
              },
              properties: {},
            },
          })),
        });
      }
      const oid = layer.assetType === "substation" ? "OBJECTID" : "OBJECTID_1";
      if (!url.pathname.endsWith("query"))
        return respond({
          objectIdField: oid,
          maxRecordCount: 50,
          editingInfo: { dataLastEditDate: 1644800158067 },
        });
      const area = JSON.parse(url.searchParams.get("geometry"));
      state.areas.push(area);
      const shifted = area.xmin > -81;
      const lon = shifted ? -80.2 : -82.458,
        lat = shifted ? 25.78 : 27.948;
      const records =
        layer.assetType === "substation"
          ? Array.from({ length: 103 }, (_, i) => ({
              attributes: {
                OBJECTID: i + 1 + (shifted ? 1000 : 0),
                ID: `station-${i + 1}`,
                NAME: `${shifted ? "Miami" : "Published"} substation ${i + 1}`,
                MAX_VOLT: 230,
                STATUS: "IN SERVICE",
                CITY: shifted ? "Miami" : "Tampa",
              },
              geometry: {
                x: i === 0 ? lon : lon - 0.2 + (i % 12) * 0.03,
                y: i === 0 ? lat : lat - 0.12 + Math.floor(i / 12) * 0.03,
              },
            }))
          : [1, 2].map((id) => ({
              attributes: {
                OBJECTID_1: id,
                ID: `line-${id}`,
                OWNER: "Published electric utility",
                VOLTAGE: 230,
                STATUS: "IN SERVICE",
              },
              geometry: {
                paths: [
                  [
                    [lon - 0.2, lat - 0.1],
                    [lon + 0.2, lat + 0.1],
                  ],
                ],
              },
            }));
      if (url.searchParams.has("returnCountOnly"))
        return respond({ count: records.length });
      const offset = Number(url.searchParams.get("resultOffset") || 0);
      return respond({
        spatialReference: { wkid: 4326 },
        features: records.slice(offset, offset + 50),
      });
    });
  return state;
}

export async function ready(page) {
  await expect(page.locator("#status-count")).toContainText("107 assets");
  await expect(page.locator("#layer-list .public-layer-status")).toHaveCount(0);
  await expect(page.locator('#status-map')).not.toContainText('Loading');
  await page.waitForFunction(() => window.__testMap?.isStyleLoaded() && window.__testMap.getLayer('tb-highway-cameras'));
}
