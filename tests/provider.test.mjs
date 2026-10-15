import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { BrowserDataProvider } from "../src/data/provider.js";
import { previewImport, fingerprint } from "../src/data/imports.js";
import { createDemo } from "../scripts/generate-demo.mjs";

test("observations sort chronologically across valid timestamp precisions", async () => {
  const bundle = createDemo();
  const observation = bundle.observations[0];
  bundle.observations = [
    { ...observation, observedAt: "2026-10-11T12:00:00.005Z", value: 2 },
    { ...observation, observedAt: "2026-10-11T12:00:00Z", value: 1 },
  ];
  const provider = await new BrowserDataProvider(new IDBFactory()).initialize(bundle);
  assert.deepEqual((await provider.getObservations(bundle.workspace.id, observation.seriesId)).map(o => o.value), [1, 2]);
  provider.dispose();
});

const file = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-82.46, 27.94] },
      properties: {
        id: "new-meter",
        name: "New meter",
        utilityType: "electric",
        assetType: "meter",
      },
    },
  ],
});
test("imports survive provider restart and export retains relationships", async () => {
  const idb = new IDBFactory(),
    p = await new BrowserDataProvider(idb).initialize(createDemo());
  const base = await p.loadWorkspace("tampa-electric");
  const preview = previewImport({
    text: file,
    filename: "a.geojson",
    current: base,
    id: "dataset",
  });
  await p.importDataset(preview);
  p.dispose();
  const next = await new BrowserDataProvider(idb).initialize(createDemo());
  const stored = await next.loadWorkspace("tampa-electric");
  assert.equal(stored.assets.length, base.assets.length + 1);
  assert.equal(
    JSON.parse(await next.exportWorkspace("tampa-electric")).terminals.length,
    base.terminals.length,
  );
  assert.equal(
    (await next.queryAssets("tampa-electric", { query: "New meter" })).length,
    1,
  );
  next.dispose();
});
test("invalid import and stale preview never alter the stored workspace", async () => {
  const p = await new BrowserDataProvider(new IDBFactory()).initialize(
    createDemo(),
  );
  const base = await p.loadWorkspace("tampa-electric");
  const bad = previewImport({
    text: "{}",
    filename: "invalid.json",
    current: base,
  });
  await assert.rejects(p.importDataset(bad));
  assert.deepEqual(await p.loadWorkspace("tampa-electric"), base);
  const preview = previewImport({
    text: file,
    filename: "a.geojson",
    current: base,
    id: "dataset",
  });
  const changed = structuredClone(base);
  changed.workspace.name = "Updated in another tab";
  await p.write(changed, { expected: fingerprint(base) });
  await assert.rejects(p.importDataset(preview), /changed after preview/);
  assert.deepEqual(await p.loadWorkspace("tampa-electric"), changed);
  p.dispose();
});
test("transaction abort leaves persisted and in-memory data unchanged", async () => {
  const p = await new BrowserDataProvider(new IDBFactory()).initialize(
    createDemo(),
  );
  const base = await p.loadWorkspace("tampa-electric"),
    original = p.db.transaction.bind(p.db);
  p.db.transaction = (...args) => {
    const tx = original(...args);
    if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  };
  const next = structuredClone(base);
  next.workspace.name = "Should not persist";
  await assert.rejects(p.write(next));
  assert.deepEqual(await p.loadWorkspace(base.workspace.id), base);
  p.dispose();
});
test("unavailable storage leaves a usable demo and rejects mutations", async () => {
  const p = await new BrowserDataProvider(null).initialize(createDemo());
  assert(p.warning.includes("unavailable"));
  const b = await p.loadWorkspace("tampa-electric");
  await assert.rejects(p.write(b), /could not be saved/);
  assert.equal((await p.listWorkspaces()).length, 1);
  assert.equal(
    JSON.parse(await p.exportWorkspace("tampa-electric")).assets.length,
    b.assets.length,
  );
});
