import { HIGHWAY_CAMERAS } from "../data/highway-cameras.js";
import { esc, icon } from "./ui.js";

export function renderHighwayCameras(state) {
  return `<div class="context-layer-list camera-layer-controls"><label><input type="checkbox" data-highway-cameras ${state.highwayCamerasVisible ? "checked" : ""}>${icon("camera")}<span>Highway cameras</span><small>${HIGHWAY_CAMERAS.features.length}</small></label><p class="layer-foot">Symbols in views spanning 10,000 ft or less · Select a camera to watch its live feed · FL511</p></div>`;
}

export function cameraSymbolCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#123544";
  ctx.strokeStyle = "#76e3ef";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(4, 4, 56, 56, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e6fcff";
  ctx.beginPath();
  ctx.roundRect(14, 21, 25, 22, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(41, 27);
  ctx.lineTo(51, 22);
  ctx.lineTo(51, 42);
  ctx.lineTo(41, 37);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

export function createCameraPopup(feature, { onClose } = {}) {
  const camera = feature.properties;
  const root = document.createElement("section");
  root.className = "highway-camera-popup";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Live highway camera: ${camera.name}`);
  root.innerHTML = `<div class="camera-popup-heading"><div><span class="eyebrow">FL511 · Live highway camera</span><h2>${esc(camera.roadway)}</h2></div><button class="icon-button" aria-label="Close live camera">${icon("close")}</button></div><p class="camera-location">${esc(camera.location)}<br>${esc([camera.direction, camera.county && `${camera.county} County`].filter(Boolean).join(" · "))}</p><video controls autoplay muted playsinline aria-label="Live feed for ${esc(camera.name)}"></video><img class="camera-snapshot" alt="FDOT image for ${esc(camera.name)}" hidden><p class="camera-feed-status" role="status">Connecting to live feed…</p><div class="camera-popup-actions"><button class="text-button camera-retry">Retry feed</button>${camera.snapshotUrl ? '<button class="text-button camera-image-toggle">Show image</button>' : ""}<a class="text-button" href="https://fl511.com/#camera-${encodeURIComponent(camera.id)}" target="_blank" rel="noopener noreferrer">View on FL511 ${icon("arrow")}</a></div>`;
  const video = root.querySelector("video");
  const snapshot = root.querySelector(".camera-snapshot");
  const imageToggle = root.querySelector(".camera-image-toggle");
  const status = root.querySelector(".camera-feed-status");
  video.muted = true;
  let player, disposed = false, generation = 0, timer, refreshTimer, showingImage = false, videoFailed = false;
  const message = (text) => { status.textContent = text; };
  const stop = () => {
    clearTimeout(timer);
    clearInterval(refreshTimer);
    player?.destroy();
    player = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    snapshot.onload = snapshot.onerror = null;
    snapshot.removeAttribute("src");
  };
  const refreshImage = () => {
    if (disposed || !showingImage) return;
    snapshot.src = `${import.meta.env.BASE_URL}api/highway-cameras/${encodeURIComponent(camera.id)}/snapshot?_=${Date.now()}`;
  };
  const showImage = (failed = false) => {
    if (disposed) return;
    generation++;
    stop();
    showingImage = true;
    videoFailed = failed;
    video.hidden = true;
    snapshot.hidden = false;
    if (imageToggle) imageToggle.textContent = "Try video";
    message(`${failed ? "Live video unavailable · " : ""}Loading FDOT image…`);
    snapshot.onload = () => {
      if (!disposed && showingImage) message(`${videoFailed ? "Live video unavailable · " : ""}FDOT image · Refreshes every 30 seconds`);
    };
    snapshot.onerror = () => {
      if (!disposed && showingImage) message("FDOT image unavailable. Retry or view this camera on FL511.");
    };
    refreshImage();
    refreshTimer = setInterval(refreshImage, 30000);
  };
  const unavailable = () => {
    if (disposed || showingImage) return;
    if (camera.snapshotUrl) return showImage(true);
    generation++;
    stop();
    message("Live feed unavailable. Retry or view this camera on FL511.");
  };
  async function start() {
    if (disposed) return;
    const attempt = ++generation;
    stop();
    showingImage = false;
    video.hidden = false;
    snapshot.hidden = true;
    if (imageToggle) imageToggle.textContent = "Show image";
    message("Connecting to live feed…");
    const url = `${import.meta.env.BASE_URL}api/highway-cameras/${encodeURIComponent(camera.id)}/stream`;
    timer = setTimeout(unavailable, 20000);
    try {
      const { default: Hls } = await import("hls.js");
      if (disposed || attempt !== generation) return;
      if (Hls.isSupported()) {
        player = new Hls({ maxBufferLength: 12, backBufferLength: 0 });
        player.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal && attempt === generation) unavailable(); });
        player.loadSource(url);
        player.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
      } else {
        unavailable();
      }
    } catch {
      if (!disposed && attempt === generation) unavailable();
    }
  }
  video.addEventListener("playing", () => { if (!disposed && !showingImage) { clearTimeout(timer); message("Live video · FL511"); } });
  video.addEventListener("error", unavailable);
  root.querySelector(".camera-retry").addEventListener("click", () => { if (showingImage) refreshImage(); else void start(); });
  imageToggle?.addEventListener("click", () => { if (showingImage) void start(); else showImage(); });
  root.querySelector('[aria-label="Close live camera"]').addEventListener("click", () => onClose?.());
  const escape = (event) => { if (event.key === "Escape") onClose?.(); };
  document.addEventListener("keydown", escape);
  void start();
  return {
    element: root,
    dispose() {
      disposed = true;
      generation++;
      video.removeEventListener("error", unavailable);
      document.removeEventListener("keydown", escape);
      stop();
      root.remove();
    },
  };
}
