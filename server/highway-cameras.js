import { Buffer } from 'node:buffer';
import { HIGHWAY_CAMERA_BY_ID } from "../src/data/highway-cameras.js";

const exchangeUrl = "https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId";
const providerHeaders = { Referer: "https://fl511.com/", Origin: "https://fl511.com" };

// Only listed cameras and files within their stream directory can be proxied.
export function createCameraMiddleware({ fetchImpl = fetch, now = Date.now, onError = () => {} } = {}) {
  const authorizations = new Map();
  async function authorization(camera, signal) {
    if (!camera.isVideoAuthRequired) return "";
    const cached = authorizations.get(camera.id);
    if (cached && cached.expires > now()) return cached.value;
    const endpoint = `https://fl511.com/Camera/GetVideoUrl?imageId=${encodeURIComponent(camera.imageId)}&_=${now()}`;
    const response = await fetchImpl(endpoint, { headers: providerHeaders, signal });
    if (!response.ok) throw new Error(`Camera authorization unavailable (HTTP ${response.status})`);
    let value = await response.json();
    if (value && typeof value === "object") {
      const exchange = await fetchImpl(exchangeUrl, {
        method: "POST", headers: { ...providerHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(value), signal,
      });
      if (!exchange.ok) throw new Error(`Camera token exchange unavailable (HTTP ${exchange.status})`);
      value = await exchange.json();
    }
    if (typeof value !== "string" || !value) throw new Error("Camera authorization unavailable");
    authorizations.set(camera.id, { value, expires: now() + 45000 });
    return value;
  }
  return async function cameraMiddleware(req, res, next) {
    const request = new URL(req.url, "http://localhost");
    if (!request.pathname.startsWith("/api/highway-cameras/")) return next();
    const match = /^\/api\/highway-cameras\/(\d+)\/(stream|snapshot)$/.exec(request.pathname);
    const feature = match && HIGHWAY_CAMERA_BY_ID.get(match[1]);
    const fail = (status, error) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error }));
    };
    if (req.method !== "GET") return fail(405, "Only GET is supported");
    if (!feature) return fail(404, "Live camera not found");
    const camera = feature.properties;
    if (match[2] === "snapshot") {
      if (!camera.snapshotUrl) return fail(404, "FDOT image not found");
      if (request.searchParams.has("path")) return fail(400, "Invalid image path");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", disconnected);
      try {
        const url = new URL(camera.snapshotUrl);
        url.searchParams.set("_", String(now()));
        const response = await fetchImpl(url.href, { headers: providerHeaders, signal: controller.signal, redirect: "error" });
        const type = response.headers.get("content-type")?.split(";")[0];
        if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Invalid FDOT image");
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.length || body.length > 8 * 1024 * 1024) throw new Error("Invalid FDOT image");
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        res.end(body);
      } catch(error) { onError('snapshot',error); if (!res.destroyed) fail(502, "FDOT image unavailable. Please retry."); }
      finally { clearTimeout(timeout); res.off("close", disconnected); }
      return;
    }
    if (!camera.videoAvailable) return fail(404, "Live video not available for this camera");
    const base = new URL(camera.videoUrl);
    const directory = new URL(".", base).pathname;
    const allowed = (url) => url.origin === base.origin && url.pathname.startsWith(directory) && !url.username && !url.password;
    let upstream;
    try { upstream = new URL(request.searchParams.get("path") || base.href, base); }
    catch { return fail(400, "Invalid stream path"); }
    if (!allowed(upstream)) return fail(400, "Invalid stream path");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", disconnected);
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await authorization(camera, controller.signal);
        const url = /^https:\/\//.test(auth) && !request.searchParams.has("path") ? new URL(auth) : new URL(upstream);
        if (!allowed(url)) throw new Error("Invalid authorized stream URL");
        if (auth.startsWith("?"))
          for (const [key, value] of new URLSearchParams(auth.slice(1))) url.searchParams.set(key, value);
        response = await fetchImpl(url.href, { headers: providerHeaders, signal: controller.signal, redirect: "error" });
        if (response.status !== 401 && response.status !== 403) break;
        await response.body?.cancel();
        authorizations.delete(camera.id);
      }
      if (!response.ok) throw new Error(`Live camera feed unavailable (HTTP ${response.status})`);
      const playlist = /\.m3u8$/i.test(upstream.pathname);
      let body;
      if (playlist) {
        const rewrite = (uri) => {
          const url = new URL(uri, upstream);
          if (!allowed(url)) throw new Error("Invalid playlist resource");
          url.searchParams.delete("token");
          return `${request.pathname}?path=${encodeURIComponent(url.pathname + url.search)}`;
        };
        const text = await response.text();
        if (!text.startsWith("#EXTM3U")) throw new Error("Invalid camera playlist");
        body = text.split(/\r?\n/).map((line) => {
          if (!line.trim()) return line;
          if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
          return rewrite(line.trim());
        }).join("\n");
      } else body = Buffer.from(await response.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": playlist ? "application/vnd.apple.mpegurl" : response.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch(error) {
      onError('stream',error);
      if (!res.destroyed) fail(502, "Live camera feed unavailable. Please retry.");
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnected);
    }
  };
}
