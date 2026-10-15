import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { PUBLIC_LAYERS, arcgisGeometry } from "../src/data/public-layers.js";

const source = PUBLIC_LAYERS.find((layer) => layer.id === "public-transmission");
const output = resolve("public/data/us-transmission");
const staging = `${output}.building`;
const cache = resolve("/tmp/tidebound-us-transmission-source.json");
async function json(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
}
let snapshot;
try { snapshot = JSON.parse(await readFile(cache, "utf8")); } catch {}
if (!snapshot || process.argv.includes("--refresh")) {
  const metadata = await json(`${source.endpoint}?f=json`);
  const oid = metadata.objectIdField;
  const { count } = await json(`${source.endpoint}/query?f=json&where=1%3D1&returnCountOnly=true`);
  if (!oid || !Number.isInteger(count) || count < 1) throw new Error("Invalid source metadata/count");
  const pages = new Array(Math.ceil(count / 2000));
  let next = 0, completed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < pages.length) {
      const index = next++;
      const params = new URLSearchParams({ f: "json", where: "1=1", outFields: oid,
        outSR: "4326", returnGeometry: "true", orderByFields: `${oid} ASC`,
        resultRecordCount: "2000", resultOffset: String(index * 2000),
        maxAllowableOffset: "0.00005", geometryPrecision: "6" });
      const page = await json(`${source.endpoint}/query?${params}`);
      if (page.spatialReference?.wkid !== 4326 || !Array.isArray(page.features)
        || page.features.length !== Math.min(2000, count - index * 2000))
        throw new Error(`Incomplete source page ${index}`);
      pages[index] = page.features;
      completed += page.features.length;
      console.log(`Downloaded ${completed.toLocaleString()} / ${count.toLocaleString()} records`);
    }
  }));
  const verification = await json(`${source.endpoint}/query?f=json&where=1%3D1&returnCountOnly=true`);
  if (verification.count !== count) throw new Error("Source changed during download; retry");
  snapshot = { metadata, count, records: pages.flat(), fetchedAt: new Date().toISOString() };
  await writeFile(cache, JSON.stringify(snapshot));
}
const ids = new Set(), rejected = [];
const features = snapshot.records.flatMap((record) => {
  const oid = record.attributes[snapshot.metadata.objectIdField];
  if (!Number.isInteger(oid) || ids.has(oid)) throw new Error("Invalid or duplicate source identity");
  ids.add(oid);
  const geometry = arcgisGeometry(record.geometry);
  const paths = geometry?.type === "LineString" ? [geometry.coordinates] : geometry?.coordinates;
  if (!paths?.length || paths.some((path) => path.length < 2 || path.some(([x, y]) =>
    !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 85.051129))) {
    rejected.push(oid); return [];
  }
  return [{ type: "Feature", id: oid, geometry, properties: { id: `${source.id}:${oid}`, externalId: oid } }];
});
if (ids.size !== snapshot.count) throw new Error("Incomplete source snapshot");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const maxZoom = 8;
const index = new geojsonvt({ type: "FeatureCollection", features }, {
  maxZoom, indexMaxZoom: 5, indexMaxPoints: 50000, tolerance: 2, extent: 4096, buffer: 64,
});
let tileCount = 0, bytes = 0;
const tiles = {};
// Record populated tiles so the client can return empty data without requesting missing files.
for (let z = 0; z <= maxZoom; z++) {
  const populated = [];
  for (let x = 0; x < 2 ** z; x++) {
    let madeDirectory = false;
    for (let y = 0; y < 2 ** z; y++) {
      const tile = index.getTile(z, x, y);
      if (!tile?.features.length) continue;
      if (!madeDirectory) { await mkdir(`${staging}/tiles/${z}/${x}`, { recursive: true }); madeDirectory = true; }
      const buffer = vtpbf.fromGeojsonVt({ transmission: tile });
      await writeFile(`${staging}/tiles/${z}/${x}/${y}.pbf`, buffer);
      await writeFile(`${staging}/tiles/${z}/${x}/${y}.pbf.gz`, gzipSync(buffer));
      populated.push(`${x}/${y}`); tileCount++; bytes += buffer.length;
    }
  }
  tiles[z] = populated;
  console.log(`Zoom ${z}: ${populated.length} tiles`);
}
const manifest = {
  version: 1, featureCount: features.length, sourceCount: snapshot.count, rejectedIds: rejected,
  source: source.endpoint, fetchedAt: snapshot.fetchedAt,
  sourceUpdatedAt: new Date(snapshot.metadata.editingInfo?.dataLastEditDate ?? snapshot.metadata.editingInfo?.lastEditDate).toISOString(),
  minZoom: 0, maxZoom, tileCount, bytes, tiles,
  tileTemplate: "tiles/{z}/{x}/{y}.pbf",
  attribution: "US Government / Esri · US Electric Power Transmission Lines",
};
await writeFile(`${staging}/manifest.json`, `${JSON.stringify(manifest)}\n`);
await rm(`${output}.previous`, { recursive: true, force: true });
try { await rename(output, `${output}.previous`); } catch (error) { if (error.code !== "ENOENT") throw error; }
await rename(staging, output);
await rm(`${output}.previous`, { recursive: true, force: true });
console.log(`Published ${features.length.toLocaleString()} records, ${tileCount} tiles, ${(bytes / 1048576).toFixed(1)} MiB`);
