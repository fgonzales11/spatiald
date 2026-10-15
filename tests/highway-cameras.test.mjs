import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cameraFeatures, HIGHWAY_CAMERAS, TAMPA_CAMERA_IDS, officialSnapshotUrl } from "../src/data/highway-cameras.js";
import { createCameraMiddleware } from "../server/highway-cameras.js";
import { CAMERA_VIEW_EXTENT_METERS, withinCameraViewExtent, visibleCameraIds } from "../src/spatial/camera-symbol-range.js";
import { offsetMeters } from "../src/spatial/pole-placement.js";

test("camera symbols appear at 10,000 feet of view extent or below and remain limited to the viewport", () => {
  assert.equal(CAMERA_VIEW_EXTENT_METERS, 3048);
  for (const extent of [0, 152, 304.8, 1000, 3048]) assert.equal(withinCameraViewExtent(extent), true);
  for (const extent of [3048.001, 5000, -1, NaN, Infinity, undefined]) assert.equal(withinCameraViewExtent(extent), false);
  const center = [-82.5, 27.9];
  const features = [0, 80, 110, 500].map((distance) => ({
    properties: { id: String(distance) },
    geometry: { type: "Point", coordinates: offsetMeters(center, distance, 0) },
  }));
  const west = offsetMeters(center, -100, 0)[0], east = offsetMeters(center, 100, 0)[0];
  const south = offsetMeters(center, 0, -50)[1], north = offsetMeters(center, 0, 50)[1];
  assert.deepEqual(visibleCameraIds(features, [west, south, east, north]), ["0", "80"]);
  assert.deepEqual(visibleCameraIds(features, [west, south, offsetMeters(center, 4000, 0)[0], north]), []);
  assert.deepEqual(visibleCameraIds(features, null), []);
  assert.equal(features.length, 4, "Range filtering must retain the camera catalog");
});

test("camera catalog includes only usable live-video points", () => {
  assert.equal(HIGHWAY_CAMERAS.features.length, 366);
  assert.ok(HIGHWAY_CAMERAS.features.every((f) => TAMPA_CAMERA_IDS.has(f.id) && f.properties.videoAvailable));
  assert.ok(!HIGHWAY_CAMERAS.features.some((f) => f.id === "5573"), "Image-only cameras stay excluded");
  const camera = { id: 1, videoUrl: "https://example.com/live.m3u8", coordinatesWkt: "POINT (-82.5 27.9)" };
  const result = cameraFeatures([
    camera, { ...camera, videoUrl: null }, { ...camera, videoDisabled: true },
    { ...camera, disabled: true }, { ...camera, blocked: true },
    { ...camera, videoUrl: "javascript:alert(1)" }, { ...camera, coordinatesWkt: "POINT (181 20)" },
    { ...camera, coordinatesWkt: "POINT (oops 20)" },
  ]);
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [-82.5, 27.9]);
  assert.equal(new Set(HIGHWAY_CAMERAS.features.map((f) => f.id)).size, 366);
});

async function proxy(t, fetchImpl) {
  const handler = createCameraMiddleware({ fetchImpl });
  const server = createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("FDOT snapshots use image IDs rather than camera IDs and reject unrelated image URLs", () => {
  const camera = HIGHWAY_CAMERAS.features.find((f) => f.id === "5610").properties;
  assert.equal(officialSnapshotUrl(camera), "https://fl511.com/map/Cctv/5609");
  for (const imageUrl of ["https://example.com/map/Cctv/5609", "https://fl511.com/map/Cctv/5610",
    "https://user:pass@fl511.com/map/Cctv/5609", "https://fl511.com/map/Cctv/5609?url=other", null])
    assert.equal(officialSnapshotUrl({ ...camera, imageUrl }), null);
});

test("snapshot proxy relays official images without exchanging video tokens", async (t) => {
  const calls = [];
  const bytes = new Uint8Array([255, 216, 255, 217]);
  const base = await proxy(t, async (url, options) => {
    calls.push(String(url));
    assert.equal(new URL(url).origin, "https://fl511.com");
    assert.equal(new URL(url).pathname, "/map/Cctv/5609");
    assert.ok(new URL(url).searchParams.has("_"));
    assert.equal(options.headers.Referer, "https://fl511.com/");
    assert.equal(options.redirect, "error");
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
  });
  const response = await fetch(`${base}/api/highway-cameras/5610/snapshot`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${base}/api/highway-cameras/5610/snapshot?path=https://example.com`)).status, 400);
  assert.equal((await fetch(`${base}/api/highway-cameras/5573/snapshot`)).status, 404);
  assert.equal((await fetch(`${base}/api/highway-cameras/87/stream`)).status, 404);
  assert.equal(calls.length, 1, "Excluded cameras and arbitrary paths must not reach upstream");
});

test("snapshot failures and non-image responses return a retryable error", async (t) => {
  for (const response of [new Response("<html>Unavailable</html>", { headers: { "Content-Type": "text/html" } }),
    new Response(null, { status: 503 }), new Response("", { headers: { "Content-Type": "image/jpeg" } })]) {
    const base = await proxy(t, async () => response);
    const result = await fetch(`${base}/api/highway-cameras/5610/snapshot`);
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /retry/i);
  }
});

test("camera proxy exchanges authorization, rewrites playlists and relays media with provider headers", async (t) => {
  const calls = [];
  const base = await proxy(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("GetVideoUrl")) return Response.json({ token: "ticket", sourceId: "754" });
    if (String(url).includes("GetSecureTokenUri")) {
      assert.equal(JSON.parse(options.body).token, "ticket");
      return Response.json("?token=fresh");
    }
    assert.equal(new URL(url).searchParams.get("token"), "fresh");
    assert.equal(options.headers.Referer, "https://fl511.com/");
    assert.equal(options.headers.Origin, "https://fl511.com");
    if (String(url).includes("index.m3u8")) return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?token=old"\nxflow.m3u8?token=old\n');
    if (String(url).includes("xflow.m3u8")) return new Response("#EXTM3U\n#EXTINF:4,\nsegment.ts?token=old\n");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "video/mp2t" } });
  });
  const response = await fetch(`${base}/api/highway-cameras/89/stream`);
  assert.equal(response.status, 200);
  const manifest = await response.text();
  assert.ok(manifest.includes('URI="/api/highway-cameras/89/stream?path='));
  assert.ok(!manifest.includes("token="));
  const childUrl = manifest.split("\n").find((line) => line.startsWith("/api"));
  const child = await (await fetch(base + childUrl)).text();
  const segment = child.split("\n").find((line) => line.startsWith("/api"));
  assert.deepEqual(new Uint8Array(await (await fetch(base + segment)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(calls.filter((call) => call.url.includes("GetVideoUrl")).length, 1);
});

test("camera proxy rejects unlisted cameras, other hosts and paths outside the camera channel", async (t) => {
  const base = await proxy(t, () => { throw new Error("Upstream must not be reached"); });
  for (const [path, status] of [
    ["/api/highway-cameras/335/stream", 404],
    ["/api/highway-cameras/9999999/stream", 404],
    ["/api/highway-cameras/89/stream?path=https://example.com/a", 400],
    ["/api/highway-cameras/89/stream?path=../other/index.m3u8", 400],
    ["/api/highway-cameras/89/stream?path=http://", 400],
  ]) assert.equal((await fetch(base + path)).status, status);
  assert.equal((await fetch(`${base}/api/highway-cameras/89/stream`, { method: "POST" })).status, 405);
});

test("expired stream authorization is refreshed and provider failures are reported", async (t) => {
  let exchanges = 0;
  const base = await proxy(t, async (url) => {
    if (String(url).includes("GetVideoUrl")) return Response.json({ token: "ticket" });
    if (String(url).includes("GetSecureTokenUri")) return Response.json(`?token=${++exchanges}`);
    if (new URL(url).searchParams.get("token") === "1") return new Response(null, { status: 401 });
    return new Response("#EXTM3U\n");
  });
  assert.equal((await fetch(`${base}/api/highway-cameras/89/stream`)).status, 200);
  assert.equal(exchanges, 2);
  const failed = await proxy(t, async () => new Response(null, { status: 503 }));
  const response = await fetch(`${failed}/api/highway-cameras/89/stream`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /retry/i);
});
