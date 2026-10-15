import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { OsmLayerProvider } from "../src/data/osm-layers.js";
import { geometryErrors } from "../src/domain/model.js";

test("OSM conversion merges source identities, assembles reversed multipolygon members and holes, and omits incomplete geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "geobound-osm-"));
  try {
    const points = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 1],
    ];
    const nodes = points
      .map(([x, y], i) => `<node id="${i + 1}" lon="${x}" lat="${y}"/>`)
      .join("");
    const way = (id, refs, tags = "") =>
      `<way id="${id}">${refs.map((id) => `<nd ref="${id}"/>`).join("")}${tags}</way>`;
    const xml = `<osm version="0.6"><bounds minlon="0" minlat="0" maxlon="4" maxlat="4"/>${nodes}
      <node id="9" lon="3" lat="3" version="1"><tag k="power" v="pole"/></node>
      ${way(20, [1, 2, 3])}${way(21, [1, 4, 3])}${way(22, [5, 6, 7, 8, 5])}
      ${way(23, [1, 100], '<tag k="highway" v="service"/>')}
      <relation id="30"><member type="way" ref="20" role="outer"/><member type="way" ref="21" role="outer"/><member type="way" ref="22" role="inner"/><tag k="type" v="multipolygon"/><tag k="natural" v="water"/><tag k="name" v="Pond &amp; wetland"/></relation></osm>`;
    await writeFile(join(root, "map1.osm"), xml);
    await writeFile(
      join(root, "map2.osm"),
      '<osm version="0.6"><bounds minlon="0" minlat="0" maxlon="4" maxlat="4"/><node id="9" lon="3.5" lat="3" version="2"><tag k="power" v="pole"/></node></osm>',
    );
    execFileSync("python3", [
      "scripts/convert-osm.py",
      "--input",
      root,
      "--output",
      join(root, "result"),
    ]);
    const manifest = JSON.parse(
      await readFile(join(root, "result/manifest.json")),
    );
    assert.equal(manifest.duplicatesRemoved, 1);
    assert.equal(manifest.omissions["missing node reference"], 1);
    const water = JSON.parse(
      await readFile(join(root, "result/water.geojson")),
    );
    assert.equal(water.features.length, 1);
    assert.equal(water.features[0].geometry.type, "Polygon");
    assert.equal(water.features[0].geometry.coordinates.length, 2);
    assert.equal(water.features[0].properties.name, "Pond & wetland");
    assert.deepEqual(geometryErrors(water.features[0].geometry), []);
    const utilities = JSON.parse(
      await readFile(join(root, "result/utilities.geojson")),
    );
    assert.equal(utilities.features.length, 1);
    assert.equal(utilities.features[0].properties.version, 2);
    assert.deepEqual(utilities.features[0].geometry.coordinates, [3.5, 3]);
    assert.deepEqual(utilities.features[0].properties.sourceFiles, [
      "map1.osm",
      "map2.osm",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all bundled OSM layers have valid, unique source geometry and retain attribution", async () => {
  const provider = new OsmLayerProvider({
    baseUrl: "public/",
    fetcher: async (path) => ({
      ok: true,
      json: async () => JSON.parse(await readFile(path, "utf8")),
    }),
  });
  const manifest = await provider.manifest();
  const ids = new Set();
  for (const layer of manifest.layers) {
    const data = await provider.loadLayer(layer);
    assert.equal(data.features.length, layer.count);
    for (const feature of data.features) {
      assert.ok(!ids.has(feature.properties.id));
      ids.add(feature.properties.id);
    }
    assert.equal(await provider.loadLayer(layer), data);
  }
  assert.equal(ids.size, manifest.featureCount);
  assert.equal(manifest.license, "ODbL-1.0");
  assert.ok(manifest.copyrightUrl.startsWith("https://www.openstreetmap.org/"));
});

test("OSM adapter reports missing files and rejects duplicate identities", async () => {
  const missing = new OsmLayerProvider({
    fetcher: async () => ({ ok: false, status: 404 }),
  });
  await assert.rejects(missing.manifest(), /404/);
  const feature = {
    type: "Feature",
    properties: { id: "osm:node:1", group: "utilities" },
    geometry: { type: "Point", coordinates: [0, 0] },
  };
  const duplicate = new OsmLayerProvider({
    fetcher: async () => ({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [feature, feature],
      }),
    }),
  });
  await assert.rejects(
    duplicate.loadLayer({
      id: "utilities",
      file: "utilities.geojson",
      count: 2,
    }),
    /duplicate/,
  );
});
