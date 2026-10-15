import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

export async function mockSpatialProviders(page) {
  const bundle = JSON.parse(
    await readFile("tests/fixtures/tampa-electric/workspace.json", "utf8"),
  );
  await page.route("**/data/workspace.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(bundle),
    }),
  );
  const [lon, lat] = bundle.assets.find(
    (asset) => asset.assetType === "substation",
  ).geometry.coordinates;
  const lambda = (lon * Math.PI) / 180,
    phi = (lat * Math.PI) / 180;
  const sin = Math.sin(phi),
    cos = Math.cos(phi);
  const a = 6378137,
    e2 = 0.0066943799901413165;
  const n = a / Math.sqrt(1 - e2 * sin * sin);
  const x = (n - 25) * cos * Math.cos(lambda),
    y = (n - 25) * cos * Math.sin(lambda),
    z = (n * (1 - e2) - 25) * sin;
  const data = Buffer.concat([
    Buffer.from(
      new Float32Array([
        -8000, -8000, 0, 8000, -8000, 0, 8000, 8000, 0, -8000, 8000, 0,
      ]).buffer,
    ),
    Buffer.from(
      new Float32Array([
        0.12, 0.4, 0.2, 0.25, 0.15, 0.08, 0.45, 0.4, 0.2, 0.2, 0.3, 0.4,
      ]).buffer,
    ),
    Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer),
  ]);
  const model = {
    asset: { version: "2.0", copyright: "Synthetic environment test terrain" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    buffers: [
      {
        byteLength: data.length,
        uri: `data:application/octet-stream;base64,${data.toString("base64")}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 12 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: "VEC3",
        min: [-8000, -8000, 0],
        max: [8000, 8000, 0],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
        extensions: { KHR_materials_unlit: {} },
        doubleSided: true,
      },
    ],
    extensionsUsed: ["KHR_materials_unlit"],
  };
  const tileset = {
    asset: { version: "1.0", gltfUpAxis: "Z" },
    geometricError: 0,
    root: {
      boundingVolume: { sphere: [0, 0, 0, 12000] },
      geometricError: 0,
      transform: [
        -Math.sin(lambda),
        Math.cos(lambda),
        0,
        0,
        -sin * Math.cos(lambda),
        -sin * Math.sin(lambda),
        cos,
        0,
        cos * Math.cos(lambda),
        cos * Math.sin(lambda),
        sin,
        0,
        x,
        y,
        z,
        1,
      ],
      content: {
        uri: "https://tile.googleapis.com/environment-test.gltf?session=test-environment",
      },
    },
  };
  // These suites exercise the retained legacy equipment/atmosphere renderer.
  await page.route('**/api/map-config', route => route.fulfill({ json: { googleMapsApiKey: 'environment-test-key' } }));
  await page.route(/\/src\/main\.js(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replaceAll('google-map-view.js', 'map3d.js') });
  });
  await page.route("https://tile.googleapis.com/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        route.request().url().includes("environment-test.gltf")
          ? model
          : tileset,
      ),
    }),
  );
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
  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.route(/\/src\/spatial\/map3d\.js(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "function clearOverlay() {",
      "window.__testEnvironment = environment; window.__testSpatial = {camera, contextOverlay, renderer}; (window.__testRenderers ??= []).push(renderer); function clearOverlay() {",
    );
    await route.fulfill({ response, body });
  });
  await page.route(
    /\/src\/spatial\/environment\.js(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "clouds.sunDirection.copy(sun);",
        "clouds.sunDirection.copy(sun); window.__testClouds = clouds; window.__testAerial = aerial;",
      );
      await route.fulfill({ response, body });
    },
  );
}

export async function ready(page) {
  await page.waitForFunction(() => window.__testEnvironment?.ready, null, {
    timeout: 60000,
  });
}
