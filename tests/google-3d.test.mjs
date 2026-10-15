import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleTiles, GOOGLE_3D_ROOT, monitorGoogleTiles } from "../src/spatial/google-3d.js";
import { initialMapView } from "../src/spatial/map-mode.js";

test("a configured Google 3D view opens locally even when nationwide data is new", () => {
  for (const defaultMap of [undefined, "3d"]) {
    assert.deepEqual(initialMapView({ defaultMap, googleConfigured: true, nationalOverview: true }), {
      mode: "3d", showNationalOverview: false,
    });
  }
  assert.deepEqual(initialMapView({ defaultMap: "2d", googleConfigured: true, nationalOverview: true }), {
    mode: "2d", showNationalOverview: true,
  });
  assert.deepEqual(initialMapView({ googleConfigured: false, nationalOverview: true }), {
    mode: "2d", showNationalOverview: true,
  });
});

test("Google tiles use the Map Tiles endpoint and propagate its session to child requests", async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: "https://geobound.test/" } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("root.json")) return Response.json({
      asset: { version: "1.0" }, geometricError: 1000,
      root: {
        geometricError: 1000,
        boundingVolume: { sphere: [0, 0, 0, 6378137] },
        content: { uri: "https://tile.googleapis.com/v1/3dtiles/child.json?session=google-session" },
      },
    });
    return Response.json({ asset: { version: "1.0" } });
  });
  const tiles = createGoogleTiles(" browser-key ");
  t.after(() => tiles.dispose());
  const root = await tiles.loadRootTileset();
  const auth = tiles.plugins.find((plugin) => plugin.name === "GOOGLE_CLOUD_AUTH_PLUGIN");
  await auth.fetchData(root.root.content.uri, {});
  assert.equal(calls[0].origin + calls[0].pathname, GOOGLE_3D_ROOT);
  assert.equal(calls[0].searchParams.get("key"), "browser-key");
  assert.equal(calls[1].searchParams.get("key"), "browser-key");
  assert.equal(calls[1].searchParams.get("session"), "google-session");
  assert.throws(() => createGoogleTiles(" "), /Map Tiles API key/);
});

function monitored(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tiles = createGoogleTiles("test-key"), ready = [], failures = [], progress = [];
  const stop = monitorGoogleTiles(tiles, {
    onReady: () => ready.push(true),
    onProgress: (message) => progress.push(message),
    onFailure: (message) => failures.push(message),
  });
  t.after(() => { stop(); tiles.dispose(); });
  return { tiles, stop, ready, failures, progress };
}

test("slow tile downloads remain in 3D past the old cutoff and become ready only when visible", (t) => {
  const { tiles, ready, failures } = monitored(t);
  t.mock.timers.tick(25000);
  assert.deepEqual(failures, []);
  tiles.dispatchEvent({ type: "load-tileset" });
  t.mock.timers.tick(35000);
  tiles.dispatchEvent({ type: "load-model" });
  assert.deepEqual(ready, []);
  tiles.dispatchEvent({ type: "tile-visibility-change", visible: false, tile: { engineData: {} } });
  assert.deepEqual(ready, []);
  tiles.dispatchEvent({ type: "tile-visibility-change", visible: true, tile: { engineData: {} } });
  assert.deepEqual(ready, [true]);
  t.mock.timers.tick(180000);
  assert.deepEqual(failures, []);
});

test("one unavailable child tile does not discard the photorealistic map", (t) => {
  const { tiles, ready, failures } = monitored(t);
  tiles.dispatchEvent({ type: "load-error", tile: {}, error: new Error("Missing child") });
  assert.deepEqual(failures, []);
  tiles.dispatchEvent({ type: "tile-visibility-change", visible: true, tile: { engineData: {} } });
  assert.deepEqual(ready, [true]);
});

test("a failed root connection reports a retryable Google access failure once", (t) => {
  const { tiles, failures } = monitored(t);
  tiles.dispatchEvent({ type: "load-error", tile: null });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /website restrictions/);
  t.mock.timers.tick(180000);
  assert.equal(failures.length, 1);
});

test("a stalled or never-visible stream ends with a retry message", (t) => {
  const { tiles, failures } = monitored(t);
  t.mock.timers.tick(55000);
  tiles.dispatchEvent({ type: "load-tileset" });
  t.mock.timers.tick(55000);
  tiles.dispatchEvent({ type: "load-model" });
  assert.deepEqual(failures, []);
  t.mock.timers.tick(10000);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Retry 3D/);
});

test("leaving 3D cancels pending startup callbacks", (t) => {
  const { stop, ready, failures } = monitored(t);
  stop();
  t.mock.timers.tick(180000);
  assert.deepEqual(ready, []);
  assert.deepEqual(failures, []);
});
