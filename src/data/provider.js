import { assertBundle, assetEvents } from "../domain/model.js";
import { fingerprint, withoutDataset } from "./imports.js";

/** IndexedDB repository. Writes are validated and checked inside one transaction. */
export class BrowserDataProvider {
  constructor(indexedDB = globalThis.indexedDB) {
    this.indexedDB = indexedDB;
    this.db = null;
    this.memory = new Map();
    this.warning = "";
  }
  async initialize(initialWorkspace) {
    assertBundle(initialWorkspace);
    this.memory.set(
      initialWorkspace.workspace.id,
      structuredClone(initialWorkspace),
    );
    try {
      if (!this.indexedDB) throw new Error("IndexedDB is unavailable.");
      this.db = await new Promise((resolve, reject) => {
        const req = this.indexedDB.open("tidebound-v1", 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore("workspaces", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () =>
          reject(
            new Error(
              "Browser storage is blocked by another tab. Close other SPATIAL D tabs and reload.",
            ),
          );
      });
      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
        this.warning =
          "Browser storage changed in another tab. Reload to reconnect.";
      };
      const stored = await this.read(initialWorkspace.workspace.id);
      if (!stored) await this.write(initialWorkspace);
    } catch (error) {
      this.warning = `Browser storage is unavailable: ${error.message} The workspace is available in memory; export before closing.`;
    }
    return this;
  }
  async read(id) {
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("workspaces", "readonly");
      const req = tx.objectStore("workspaces").get(id);
      req.onsuccess = () => resolve(req.result?.bundle || null);
      req.onerror = () => reject(req.error);
    });
  }
  async write(bundle, { expected = null, create = false } = {}) {
    assertBundle(bundle);
    if (!this.db)
      throw new Error(
        "Changes could not be saved. Browser storage is unavailable; the current workspace is unchanged. Export it before closing.",
      );
    const copy = structuredClone(bundle);
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction("workspaces", "readwrite");
      const store = tx.objectStore("workspaces");
      let problem;
      const req = store.get(copy.workspace.id);
      req.onsuccess = () => {
        const existing = req.result?.bundle;
        if (
          (create && existing) ||
          (expected && (!existing || fingerprint(existing) !== expected))
        ) {
          problem = new Error(
            "The workspace changed after preview. Reload the workspace and preview the import again.",
          );
          tx.abort();
          return;
        }
        store.put({ id: copy.workspace.id, bundle: copy });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          problem || tx.error || new Error("Could not save browser workspace."),
        );
      tx.onabort = () =>
        reject(
          problem ||
            tx.error ||
            new Error(
              "Browser save was aborted. The current workspace is unchanged.",
            ),
        );
    });
    this.memory.set(copy.workspace.id, copy);
    return structuredClone(copy);
  }
  async listWorkspaces() {
    if (!this.db) return [...this.memory.values()].map((b) => b.workspace);
    return new Promise((resolve, reject) => {
      const req = this.db
        .transaction("workspaces", "readonly")
        .objectStore("workspaces")
        .getAll();
      req.onsuccess = () => resolve(req.result.map((r) => r.bundle.workspace));
      req.onerror = () => reject(req.error);
    });
  }
  async loadWorkspace(id) {
    const bundle = (await this.read(id)) || this.memory.get(id);
    if (!bundle) throw new Error("Workspace could not be found.");
    return structuredClone(assertBundle(bundle));
  }
  async saveWorkspace(bundle) {
    return this.write(bundle);
  }
  async queryAssets(id, { query = "", type = "", networkId = "" } = {}) {
    const b = await this.loadWorkspace(id);
    const q = query.toLowerCase();
    const memberships = new Set(
      b.networkMemberships
        .filter((m) => m.networkId === networkId)
        .map((m) => m.assetId),
    );
    return b.assets.filter(
      (a) =>
        (!q || `${a.name} ${a.id} ${a.externalId}`.toLowerCase().includes(q)) &&
        (!type || a.assetType === type) &&
        (!networkId || memberships.has(a.id)),
    );
  }
  async getAsset(id, assetId) {
    return (
      (await this.loadWorkspace(id)).assets.find((a) => a.id === assetId) ||
      null
    );
  }
  async getSeries(id, assetId) {
    return (await this.loadWorkspace(id)).series.filter(
      (s) => s.assetId === assetId,
    );
  }
  async getObservations(id, seriesId) {
    return (await this.loadWorkspace(id)).observations
      .filter((o) => o.seriesId === seriesId)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  }
  async queryEvents(id, assetId) {
    return assetEvents(await this.loadWorkspace(id), assetId);
  }
  async importDataset(preview) {
    if (preview.errors.length || !preview.candidate)
      throw new Error("Resolve validation errors before importing.");
    return this.write(preview.candidate, {
      create: preview.newWorkspace,
      expected: preview.newWorkspace ? null : preview.baseFingerprint,
    });
  }
  async exportWorkspace(id) {
    return JSON.stringify(await this.loadWorkspace(id), null, 2);
  }
  async removeDataset(id, datasetId) {
    const current = await this.loadWorkspace(id);
    return this.write(withoutDataset(current, datasetId), {
      expected: fingerprint(current),
    });
  }
  async resetWorkspace(demo) {
    return this.write(structuredClone(demo));
  }
  /** Retire the shipped synthetic dataset, preserving unrelated imported records. */
  async retireSyntheticDemo() {
    const old =
      (await this.read("tampa-electric")) || this.memory.get("tampa-electric");
    if (!old) return;
    let next = old;
    for (const dataset of old.datasets.filter(
      (d) => d.isSynthetic && d.sourceId === "tampa-demo",
    ))
      next = withoutDataset(next, dataset.id);
    if (next === old) return;
    const usedNetworks = new Set(
      next.networkMemberships.map((m) => m.networkId),
    );
    next.networks = next.networks.filter((n) => usedNetworks.has(n.id));
    next.sources = next.sources.filter((s) => s.id !== "tampa-demo");
    if (next.datasets.length) {
      if (next.workspace.name === "Tampa Bay · Electric")
        next.workspace.name = "Imported assets · United States";
      if (this.db) await this.write(next);
      else this.memory.set(next.workspace.id, next);
    } else {
      if (this.db)
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction("workspaces", "readwrite");
          tx.objectStore("workspaces").delete("tampa-electric");
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      this.memory.delete("tampa-electric");
    }
  }
  dispose() {
    this.db?.close();
    this.db = null;
  }
}
