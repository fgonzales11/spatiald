# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html vite.config.js camera-feeds.json ./
COPY src/ ./src/
COPY schemas/ ./schemas/
COPY config/ ./config/
COPY public/ ./public/
COPY server/ ./server/
COPY shared/ ./shared/
COPY worker/ ./worker/
COPY build/ ./build/
COPY scripts/build-hosted.mjs scripts/compact-simulation-assets.mjs scripts/stage-simulation-storage.mjs ./scripts/
COPY .openai/hosting.json ./.openai/hosting.json
COPY data/camera-catalogs/caltrans-camera-feeds.json ./data/camera-catalogs/caltrans-camera-feeds.json

# Map credentials are supplied to the running server, outside the image.
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5178

COPY --from=build --chown=node:node /app/dist/ ./dist/
COPY --from=build --chown=node:node /app/package.json /app/camera-feeds.json ./
COPY --from=build --chown=node:node /app/server/ ./server/
COPY --from=build --chown=node:node /app/shared/ ./shared/
COPY --from=build --chown=node:node /app/src/data/highway-cameras.js /app/src/data/tampa-cameras.json ./src/data/
COPY --chown=node:node data/camera-catalogs/caltrans-camera-feeds.json ./data/camera-catalogs/caltrans-camera-feeds.json

USER node
EXPOSE 5178
CMD ["node", "server/start.js"]
