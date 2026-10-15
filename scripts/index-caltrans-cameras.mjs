import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone reference catalog. The app never imports these files.
const root = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = resolve(root, "data/camera-catalogs");
const args = process.argv.slice(2);
if (args.some((arg) => !["--verify", "--source-dir"].includes(arg) && args[args.indexOf(arg) - 1] !== "--source-dir"))
  throw new Error("Usage: npm run index:caltrans-cameras -- [--verify] [--source-dir DIRECTORY]");
const verify = args.includes("--verify");
const sourceArg = args.indexOf("--source-dir");
if (sourceArg >= 0 && (!args[sourceArg + 1] || args[sourceArg + 1].startsWith("--")))
  throw new Error("--source-dir requires a directory containing d1.json through d12.json");
const sourceDirectory = sourceArg >= 0 ? resolve(args[sourceArg + 1]) : null;
const indexedAt = new Date().toISOString();
const districtUrl = (district) => `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, "0")}.json`;

async function parallel(items, concurrency, action) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await action(items[index], index);
    }
  }));
  return results;
}

function number(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function officialUrl(value, normalize = false) {
  if (typeof value !== "string" || !value.trim() || value === "Not Reported") return null;
  let text = value.trim();
  // Two publisher anomalies: HTTP and a missing leading "h". Preserve the original too.
  if (normalize) text = text.replace(/^ttps:\/\//, "https://").replace(/^http:\/\//, "https://");
  const url = new URL(text);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".dot.ca.gov") || url.username || url.password)
    throw new Error(`Unexpected Caltrans URL: ${value}`);
  return text;
}

const districts = await parallel(Array.from({ length: 12 }, (_, index) => index + 1), 3, async (district) => {
  let data;
  if (sourceDirectory) data = JSON.parse(await readFile(resolve(sourceDirectory, `d${district}.json`), "utf8"));
  else {
    const response = await fetch(districtUrl(district), { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`District ${district}: HTTP ${response.status}`);
    data = await response.json();
  }
  if (!Array.isArray(data.data) || !data.data.length) throw new Error(`District ${district}: missing camera records`);
  return { district, sourceUrl: districtUrl(district), rows: data.data.map((row) => row.cctv) };
});

const cameras = [], ids = new Set();
for (const { district, sourceUrl, rows } of districts) {
  for (const camera of rows) {
    if (!camera || Number(camera.location?.district) !== district || !camera.index)
      throw new Error(`District ${district}: invalid camera identity`);
    const id = `caltrans-d${district}-${camera.index}`;
    if (ids.has(id)) throw new Error(`Duplicate camera identity: ${id}`);
    ids.add(id);
    const publishedVideoUrl = camera.imageData?.streamingVideoURL;
    const videoUrl = officialUrl(publishedVideoUrl, true);
    if (!videoUrl) continue;
    const location = camera.location;
    const longitude = number(location.longitude), latitude = number(location.latitude);
    if (longitude === null || latitude === null || Math.abs(longitude) > 180 || Math.abs(latitude) > 90)
      throw new Error(`${id}: invalid WGS84 coordinates`);
    const service = String(camera.inService).toLowerCase();
    cameras.push({
      id, sourceIndex: String(camera.index), district, provider: "Caltrans", state: "CA",
      name: location.locationName, roadway: location.route, location: location.locationName,
      nearbyPlace: location.nearbyPlace, county: location.county, direction: location.direction,
      longitude, latitude, coordinatesWkt: `POINT (${longitude} ${latitude})`, elevationFeet: number(location.elevation),
      inService: service === "true" ? true : service === "false" ? false : null,
      videoUrl, publishedVideoUrl,
      urlNormalization: videoUrl !== publishedVideoUrl ? "Corrected HTTPS scheme; original retained" : null,
      format: /\.m3u8(?:\?|$)/i.test(videoUrl) ? "hls" : "unknown",
      snapshotUrl: officialUrl(camera.imageData?.static?.currentImageURL, true),
      sourceUpdatedAt: { ...camera.recordTimestamp, timeZone: "America/Los_Angeles" }, sourceUrl,
      quickmapUrl: `https://quickmap.dot.ca.gov/?view=${encodeURIComponent(`${latitude},${longitude},15`)}&layers=cameras`,
    });
  }
}
cameras.sort((a, b) => a.district - b.district || a.sourceIndex.localeCompare(b.sourceIndex, "en", { numeric: true }));
const urls = [...new Set(cameras.map((camera) => camera.videoUrl))];
const checks = new Map();
if (verify) {
  let completed = 0;
  await parallel(urls, 6, async (url) => {
    const check = { checkedAt: new Date().toISOString(), status: "unreachable", httpStatus: null };
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
      check.httpStatus = response.status;
      check.contentType = response.headers.get("content-type");
      const body = await response.text();
      const lines = body.trim().split(/\r?\n/);
      check.status = !response.ok ? "http-error" : lines[0] === "#EXTM3U" && lines.some((line) => line && !line.startsWith("#"))
        ? "playlist-ok" : "not-hls";
    } catch (error) { check.status = ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "unreachable"; }
    checks.set(url, check);
    completed++;
    if (completed % 100 === 0 || completed === urls.length) console.log(`Checked ${completed}/${urls.length} unique playlist URLs`);
  });
}
for (const camera of cameras) camera.verification = checks.get(camera.videoUrl) || { status: "not-checked", checkedAt: null, httpStatus: null };
const summary = {
  sourceCameraCount: districts.reduce((sum, district) => sum + district.rows.length, 0),
  indexedVideoCameraCount: cameras.length,
  withoutVideoUrlCount: ids.size - cameras.length,
  inServiceVideoCameraCount: cameras.filter((camera) => camera.inService === true).length,
  hlsUrlCameraCount: cameras.filter((camera) => camera.format === "hls").length,
  uniqueVideoUrlCount: urls.length,
  normalizedUrlCameraCount: cameras.filter((camera) => camera.urlNormalization).length,
  verificationByUniqueUrl: Object.fromEntries([...new Set(urls.map((url) => checks.get(url)?.status || "not-checked"))]
    .map((status) => [status, urls.filter((url) => (checks.get(url)?.status || "not-checked") === status).length])),
};
const catalog = {
  schemaVersion: 1, provider: "Caltrans", state: "CA", indexedAt,
  purpose: "Reference catalog for future California cameras; not loaded into any map layer",
  sources: {
    quickmap: "https://quickmap.dot.ca.gov/", quickmapCameraKml: "https://quickmap.dot.ca.gov/data/v2_cctv.kml",
    documentation: "https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm",
    fieldDescriptions: "https://cwwp2.dot.ca.gov/documentation/cctv/cctv-field-description.htm",
    districtFeeds: districts.map(({ district, sourceUrl }) => ({ district, url: sourceUrl })),
  },
  verificationScope: "playlist-ok means an HTTP 200 HLS playlist with media references was returned at checkedAt. Video segments, playback and continued availability are not certified. No footage or images are stored.",
  summary,
  districts: districts.map(({ district, rows }) => ({ district, sourceCameraCount: rows.length,
    indexedVideoCameraCount: cameras.filter((camera) => camera.district === district).length })),
  cameras,
};
const columns = ["id", "district", "name", "roadway", "county", "nearbyPlace", "direction", "longitude", "latitude",
  "inService", "videoUrl", "publishedVideoUrl", "format", "snapshotUrl", "quickmapUrl", "playlistStatus", "httpStatus", "checkedAt"];
const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const csv = [columns.join(","), ...cameras.map((camera) => columns.map((column) => csvValue({ ...camera,
  playlistStatus: camera.verification.status, httpStatus: camera.verification.httpStatus,
  checkedAt: camera.verification.checkedAt }[column])).join(","))].join("\n") + "\n";
await mkdir(outputDirectory, { recursive: true });
for (const [filename, body] of [["caltrans-camera-feeds.json", JSON.stringify(catalog, null, 2) + "\n"], ["caltrans-camera-feeds.csv", csv]]) {
  const path = resolve(outputDirectory, filename);
  await writeFile(`${path}.tmp`, body);
  await rename(`${path}.tmp`, path);
}
console.log(JSON.stringify(summary, null, 2));
