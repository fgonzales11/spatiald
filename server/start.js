import { createMapConfigMiddleware } from "./map-config.js";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCameraMiddleware } from "./highway-cameras.js";
import { createTransmissionTileMiddleware } from "./transmission-tiles.js";
import { createAnalysisMiddleware } from './analysis.js';

const root = fileURLToPath(new URL("../dist/client/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".pbf": "application/x-protobuf" };
const cameras = createCameraMiddleware();
const transmissionTiles = createTransmissionTileMiddleware(root);
const analysis = createAnalysisMiddleware();
const mapConfig = createMapConfigMiddleware();
createServer((req, res) => {
  mapConfig(req, res, () => { void analysis(req, res, () => { transmissionTiles(req, res, () => { void cameras(req, res, async () => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let path = resolve(root, `.${pathname}`);
      if (path !== resolve(root) && !path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
      if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
      const info = await stat(path);
      res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Content-Length": info.size });
      if (req.method === "HEAD") res.end();
      else createReadStream(path).pipe(res);
    } catch { res.writeHead(404).end("Not found"); }
  }).catch(() => { if (!res.headersSent) res.writeHead(400).end("Bad request"); }); }); }); });
}).listen(Number(process.env.PORT || 5178), process.env.HOST || "127.0.0.1", () => {
  console.log(`SPATIAL D available at http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 5178}`);
});
