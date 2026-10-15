import { TilesRenderer } from "3d-tiles-renderer/three";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";

export const GOOGLE_3D_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";

export function createGoogleTiles(apiKey) {
  const key = apiKey?.trim();
  if (!key) throw new Error("Google 3D requires a configured Map Tiles API key.");
  const tiles = new TilesRenderer(GOOGLE_3D_ROOT);
  tiles.registerPlugin(new GoogleCloudAuthPlugin({
    apiToken: key,
    autoRefreshToken: true,
    useRecommendedSettings: true,
  }));
  return tiles;
}

// A tileset JSON or a decoded model does not establish that imagery is visible.
// Allow slow downloads to make progress and tolerate an individual missing tile.
export function monitorGoogleTiles(tiles, { onReady, onProgress, onFailure }) {
  let settled = false, idleTimeout;
  const clearTimers = () => {
    clearTimeout(idleTimeout);
    clearTimeout(startupTimeout);
  };
  const fail = (message) => {
    if (settled) return;
    settled = true;
    clearTimers();
    onFailure(message);
  };
  const waitingMessage = "Google 3D tiles did not finish loading. Retry 3D or check your connection and Map Tiles API access.";
  const startupTimeout = setTimeout(() => fail(waitingMessage), 120000);
  const progress = () => {
    if (settled) return;
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => fail(waitingMessage), 60000);
    onProgress?.("Loading Google photorealistic 3D terrain and buildings…");
  };
  const visible = ({ visible }) => {
    if (settled || !visible) return;
    settled = true;
    clearTimers();
    onReady();
  };
  const error = ({ tile }) => {
    if (settled || tile != null) return;
    fail("Google photorealistic 3D could not connect. Check the key, website restrictions, and Map Tiles API access, then retry 3D.");
  };
  progress();
  tiles.addEventListener("load-tileset", progress);
  tiles.addEventListener("load-model", progress);
  tiles.addEventListener("tile-visibility-change", visible);
  tiles.addEventListener("load-error", error);
  return () => {
    settled = true;
    clearTimers();
    tiles.removeEventListener("load-tileset", progress);
    tiles.removeEventListener("load-model", progress);
    tiles.removeEventListener("tile-visibility-change", visible);
    tiles.removeEventListener("load-error", error);
  };
}
