import { createSimulation3D } from "../simulation/map-layer.js";
import { loadGoogleMaps3D, onGoogleAuthFailure } from './google-maps-loader.js';
import { assetCenter, boundsOf, geometryPaths } from '../domain/model.js';
import { infrastructureColor } from './infrastructure-style.js';
import { lineDisplayOptions } from './line-elevation.js';
import { withinSubstationViewExtent } from './substation-symbol-range.js';
import { withinCameraViewExtent } from './camera-symbol-range.js';
import { HIGHWAY_CAMERAS } from '../data/highway-cameras.js';
import { createCameraPopup } from '../components/highway-cameras.js';
import { appendPublicAttribution } from '../components/public-layers.js';
import { appendOsmAttribution } from '../components/osm-layers.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const coordinate = ([lng, lat, altitude = 0]) => ({ lng, lat, altitude });
const zoomRange = zoom => 2 ** (20 - clamp(zoom, 1, 22)) * 80;

export async function createSpatialView({ host, bundle, apiKey, camera: savedCamera,
  onSelect, onSelectContext, onPointer, onViewChange, onStatus, onFatal, signal }) {
  const loading = document.createElement('div');
  loading.className = 'google-map-loading floating-card';
  loading.setAttribute('role', 'status');
  loading.textContent = 'Loading Google photorealistic 3D…';
  host.append(loading);
  let library;
  try { library = await loadGoogleMaps3D(apiKey); }
  catch (error) { loading.remove(); throw error; }
  if (signal?.aborted) { loading.remove(); throw new DOMException('Map closed', 'AbortError'); }
  const { Map3DElement, Marker3DInteractiveElement, Polyline3DInteractiveElement } = library;
  const bounds = boundsOf(bundle.assets);
  const initialCenter = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const map = new Map3DElement({
    center: coordinate(initialCenter), range: 1900, tilt: 65, heading: 0,
    mode: 'SATELLITE', defaultUIHidden: false,
    gestureHandling: 'GREEDY',
    description: 'Google photorealistic 3D infrastructure map. Drag to move; use the map controls to zoom, rotate, and tilt.',
  });
  map.className = 'google-photorealistic-map';
  const simulationLayer = createSimulation3D(map, library);
  let disposed = false, failed = false, ready = false, current, viewTimer, drawTimer;
  let overlays = [], cameraPopup;
  const events = new AbortController();
  const popupHost = document.createElement('div');
  popupHost.className = 'google-camera-popup floating-card';
  popupHost.hidden = true;
  host.append(popupHost);
  const removePublicCredit = appendPublicAttribution(host, bundle);
  const osmCredit = appendOsmAttribution(host);

  function closeCameraPopup() {
    cameraPopup?.dispose(); cameraPopup = null;
    popupHost.replaceChildren(); popupHost.hidden = true;
  }
  function fail(message) {
    if (disposed || failed) return;
    failed = true; clearTimeout(readyTimeout); loading.remove();
    onFatal?.(message);
  }
  const unsubscribeAuth = onGoogleAuthFailure(fail);
  const readyTimeout = setTimeout(() => fail('Google photorealistic 3D did not finish loading. Check the connection, Maps JavaScript API access, billing, and browser hardware acceleration, then Retry 3D.'), 45000);
  const listen = (element, event, callback) => element.addEventListener(event, callback, { signal: events.signal });
  const controls = document.createElement('div');
  controls.className = 'google-camera-controls floating-card';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '3D camera controls');
  for (const [label, text, action] of [
    ['Rotate left', '↶', () => { map.heading = (map.heading + 330) % 360; }],
    ['Rotate right', '↷', () => { map.heading = (map.heading + 30) % 360; }],
    ['Reset north', 'N', () => { map.heading = 0; }],
    ['Tilt camera up', 'Tilt +', () => { map.tilt = clamp(map.tilt + 10, 0, 85); }],
    ['Tilt camera down', 'Tilt −', () => { map.tilt = clamp(map.tilt - 10, 0, 85); }],
  ]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    button.setAttribute('aria-label', label); button.title = label;
    listen(button, 'click', () => { map.stopCameraAnimation(); action(); });
    controls.append(button);
  }
  host.append(controls);
  listen(map, 'gmp-error', () => fail('Google photorealistic 3D could not initialize. Check Maps JavaScript API access, website key restrictions, billing, and browser hardware acceleration.'));
  listen(map, 'gmp-steadychange', event => {
    if (disposed || failed || !event.isSteady) return;
    ready = true; clearTimeout(readyTimeout); loading.remove();
    onStatus?.('3D · Google photorealistic terrain and buildings');
    reportView(); scheduleDraw();
  });
  listen(map, 'gmp-click', event => {
    if (event.position) onPointer?.({ longitude: event.position.lng, latitude: event.position.lat });
  });
  for (const event of ['gmp-centerchange', 'gmp-rangechange', 'gmp-tiltchange', 'gmp-headingchange']) {
    listen(map, event, () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => { reportView(); scheduleDraw(); }, 180);
    });
  }

  function captureCamera() {
    const c = map.center;
    return { mode: '3d', center: [c.lng, c.lat], altitude: c.altitude,
      range: map.range, tilt: map.tilt, heading: map.heading,
      zoom: clamp(20 - Math.log2(map.range / 80), 1, 22) };
  }
  function restoreCamera(camera) {
    const c = camera?.center;
    if (!Array.isArray(c) || !c.slice(0, 2).every(Number.isFinite)) return;
    map.center = coordinate([c[0], c[1], Number.isFinite(camera.altitude) ? camera.altitude : 0]);
    map.range = Number.isFinite(camera.range) ? clamp(camera.range, 30, 20000000)
      : Number.isFinite(camera.zoom) ? zoomRange(camera.zoom) : 1900;
    map.tilt = Number.isFinite(camera.tilt) ? clamp(camera.tilt, 0, 85) : 65;
    map.heading = Number.isFinite(camera.heading) ? camera.heading : 0;
  }
  function viewBounds() {
    // A conservative camera footprint for regional source loading, not survey bounds.
    const extent = map.range * 2 * Math.tan(35 * Math.PI / 360)
      * Math.max(1, host.clientWidth / Math.max(1, host.clientHeight))
      / Math.max(0.25, Math.cos(map.tilt * Math.PI / 180));
    const latRadius = extent / 222000;
    const lngRadius = latRadius / Math.max(0.1, Math.cos(map.center.lat * Math.PI / 180));
    return { extent, bounds: [clamp(map.center.lng - lngRadius, -180, 180),
      clamp(map.center.lat - latRadius, -85, 85), clamp(map.center.lng + lngRadius, -180, 180),
      clamp(map.center.lat + latRadius, -85, 85)] };
  }
  function reportView() {
    if (!disposed && !failed && ready) onViewChange?.({ center: captureCamera().center, bounds: viewBounds().bounds });
  }
  function focus(center, range = 1900) {
    closeCameraPopup(); map.stopCameraAnimation();
    map.flyCameraTo({ endCamera: { center: coordinate(center), altitudeMode: 'RELATIVE_TO_GROUND', range, tilt: 65, heading: map.heading }, durationMillis: 700 });
  }
  function scheduleDraw() {
    clearTimeout(drawTimer); drawTimer = setTimeout(draw, 120);
  }
  function inView(geometry, area) {
    const b = boundsOf([{ geometry }]);
    return b[0] <= area[2] && b[2] >= area[0] && b[1] <= area[3] && b[3] >= area[1];
  }
  function draw() {
    if (disposed || failed || !current) return;
    overlays.forEach(element => element.remove()); overlays = [];
    const area = viewBounds();
    // Bound DOM/GPU work to the local viewport; full source records stay in inventory.
    let count = 0, limited = false;
    const add = element => { map.append(element); overlays.push(element); };
    function geometry(geometry, color, title, select, selected = false, asset) {
      if (!geometry || !inView(geometry, area.bounds)) return;
      if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
        for (const point of geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates) {
          if (++count > 1500) { limited = true; return; }
          const marker = new Marker3DInteractiveElement({ position: coordinate(point),
            altitudeMode: point.length > 2 ? 'ABSOLUTE' : 'CLAMP_TO_GROUND',
            title, ...(selected ? { label: title } : {}), drawsWhenOccluded: true });
          if (select) marker.addEventListener('gmp-click', event => { event.stopPropagation(); select(); });
          add(marker);
        }
      } else {
        for (const path of geometryPaths(geometry)) {
          if (++count > 1500) { limited = true; return; }
          const line = new Polyline3DInteractiveElement({ ...lineDisplayOptions(asset, path),
            strokeColor: color, strokeWidth: selected ? 5 : 2, drawsOccludedSegments: true });
          line.setAttribute('aria-label', title);
          if (asset) { line.dataset.assetId = asset.id; line.dataset.assetType = asset.assetType; }
          if (select) line.addEventListener('gmp-click', event => { event.stopPropagation(); select(); });
          add(line);
        }
      }
    }
    for (const asset of current.assets || []) {
      if (asset.assetType === 'substation' && !withinSubstationViewExtent(area.extent)) continue;
      geometry(asset.geometry, asset.id === current.selectedId ? '#ffffff' : infrastructureColor(asset),
        asset.name || asset.id, () => onSelect?.(asset.id), asset.id === current.selectedId, asset);
    }
    const context = current.context;
    let osmVisible = false;
    for (const layer of context?.manifest?.layers || []) {
      if (!context.layers[layer.id]) continue;
      for (const feature of context.data[layer.id]?.features || []) {
        geometry(feature.geometry, layer.color, feature.properties.name || 'OpenStreetMap feature',
          () => onSelectContext?.(feature.properties.id), feature.properties.id === context.selectedId);
      }
      osmVisible = true;
    }
    osmCredit.update(osmVisible);
    if (current.highwayCamerasVisible !== false && withinCameraViewExtent(area.extent)) {
      for (const feature of HIGHWAY_CAMERAS.features) geometry(feature.geometry, '#ffffff', feature.properties.name, () => {
        closeCameraPopup(); cameraPopup = createCameraPopup(feature, { onClose: closeCameraPopup });
        popupHost.append(cameraPopup.element); popupHost.hidden = false;
      });
    }
    if (ready) onStatus?.(limited ? '3D · Google photorealistic · zoom in for more overlays' : '3D · Google photorealistic terrain and buildings');
  }
  restoreCamera(savedCamera);
  // Attach error/ready listeners before Google starts the renderer.
  host.prepend(map);
  onStatus?.('Loading Google photorealistic 3D…');
  const observer = new ResizeObserver(() => { reportView(); scheduleDraw(); });
  observer.observe(host);
  return {
    setSimulation: simulationLayer.set,
    async focusSimulation(bounds) {
      if (!ready) await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); map.removeEventListener('gmp-steadychange', steady); events.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
        const steady = event => { if (event.isSteady) finish(); };
        const aborted = () => finish(new Error('Map changed during network loading. Load the network again.'));
        const timer = setTimeout(() => finish(new Error('Google 3D is still loading. Retry Load network.')), 45000);
        map.addEventListener('gmp-steadychange', steady); events.signal.addEventListener('abort', aborted, { once: true });
      });
      if (disposed || failed) throw new Error('The 3D map is unavailable. Retry Load network.');
      await map.stopCameraAnimation();
      // Flush a pending stop before starting this network's flight.
      await new Promise(resolve => requestAnimationFrame(resolve));
      const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
      const range = Math.max(200, (bounds[3] - bounds[1]) * 111000,
        (bounds[2] - bounds[0]) * 111000 * Math.cos(center[1] * Math.PI / 180)) * 1.8;
      await new Promise((resolve, reject) => {
        // Google adjusts terrain-relative cameras as terrain detail resolves.
        // Verify the requested circuit region and completed flight, not exact floats.
        const started = performance.now();
        const latPad = Math.max(1e-4, (bounds[3]-bounds[1])*.05), lngPad = Math.max(1e-4, (bounds[2]-bounds[0])*.05);
        const arrived = () => map.center.lng>=bounds[0]-lngPad && map.center.lng<=bounds[2]+lngPad && map.center.lat>=bounds[1]-latPad && map.center.lat<=bounds[3]+latPad && map.range>=range*.5 && map.range<=range*2;
        const finish = error => { clearTimeout(timer); map.removeEventListener('gmp-animationend', ended); events.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
        const ended = () => { if (performance.now()-started>=650 && arrived()) finish(); };
        const aborted = () => finish(new Error('Map changed during the camera flight. Load the network again.'));
        const timer = setTimeout(() => finish(arrived() ? null : new Error('The camera flight was interrupted. Load the network again.')), 20000);
        map.addEventListener('gmp-animationend', ended); events.signal.addEventListener('abort', aborted, { once: true });
        map.flyCameraTo({endCamera:{center:coordinate(center),altitudeMode:'RELATIVE_TO_GROUND',range,tilt:65,heading:map.heading},durationMillis:700});
      });
    },
    update(state) { current = state; if (state.highwayCamerasVisible === false) closeCameraPopup(); scheduleDraw(); },
    captureCamera, restoreCamera, closeCameraPopup,
    resize() { /* Map3DElement tracks its own container dimensions. */ },
    focusAsset(asset) { focus(assetCenter(asset), asset.assetType === 'substation' ? 90 : 700); },
    focusBounds(b) { focus([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
      Math.max(200, (b[3] - b[1]) * 111000, (b[2] - b[0]) * 111000 * Math.cos(map.center.lat * Math.PI / 180)) * 1.8); },
    reset() { focus(initialCenter); },
    zoom(delta) { map.stopCameraAnimation(); map.range = clamp(map.range * (delta > 0 ? 0.8 : 1.25), 30, 20000000); },
    dispose() {
      disposed = true; simulationLayer.dispose(); clearTimeout(readyTimeout); clearTimeout(viewTimer); clearTimeout(drawTimer);
      events.abort(); unsubscribeAuth(); observer.disconnect(); closeCameraPopup();
      map.stopCameraAnimation(); overlays.forEach(element => element.remove()); overlays = [];
      map.remove(); controls.remove(); popupHost.remove(); loading.remove(); removePublicCredit(); osmCredit.dispose();
    },
  };
}
