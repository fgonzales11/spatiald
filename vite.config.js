import { sites } from './build/sites-vite-plugin.ts';
import { defineConfig, loadEnv } from "vite";
import { createMapConfigMiddleware } from "./server/map-config.js";
import { createCameraMiddleware } from "./server/highway-cameras.js";
import { createTransmissionTileMiddleware } from "./server/transmission-tiles.js";
import { resolve } from "node:path";
import { createAnalysisMiddleware } from './server/analysis.js';

export default defineConfig(({ mode }) => {
  const mapEnv = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
  build: { outDir: "dist/client" },
  plugins: [sites({mockAuth:false}), {
    name: 'runtime-map-config',
    configureServer(server) { server.middlewares.use(createMapConfigMiddleware(mapEnv)); },
    configurePreviewServer(server) { server.middlewares.use(createMapConfigMiddleware(mapEnv)); },
  }, {
    name: 'local-analysis',
    configureServer(server) { server.middlewares.use(createAnalysisMiddleware()); },
    configurePreviewServer(server) { server.middlewares.use(createAnalysisMiddleware()); },
  }, {
    name: "national-transmission-tiles",
    configureServer(server) { server.middlewares.use(createTransmissionTileMiddleware(resolve(server.config.root, "public"))); },
    configurePreviewServer(server) { server.middlewares.use(createTransmissionTileMiddleware(resolve(server.config.root, server.config.build.outDir))); },
  }, {
    name: "highway-camera-feeds",
    configureServer(server) { server.middlewares.use(createCameraMiddleware()); },
    configurePreviewServer(server) { server.middlewares.use(createCameraMiddleware()); },
  }],
};
});
