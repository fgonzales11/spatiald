import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Serve precompressed static tiles with a snapshot-specific browser cache. */
export function createTransmissionTileMiddleware(root) {
  return (req, res, next) => {
    const url = new URL(req.url, "http://localhost");
    const match = /^\/data\/us-transmission\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
    if (!match || !["GET", "HEAD"].includes(req.method) || !/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      next(); return;
    }
    void (async () => {
      const file = resolve(root, `data/us-transmission/tiles/${match[1]}/${match[2]}/${match[3]}.pbf.gz`);
      let info;
      try { info = await stat(file); } catch { next(); return; }
      res.writeHead(200, { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip",
        "Content-Length": info.size, "Vary": "Accept-Encoding",
        "Cache-Control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache" });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
    })().catch(() => { if (!res.headersSent) next(); else res.destroy(); });
  };
}
