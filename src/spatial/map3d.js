import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  DirectionalLight,
  CatmullRomCurve3,
  CanvasTexture,
  Group,
  Line,
  LineSegments,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Matrix4,
  NoToneMapping,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Float32BufferAttribute,
  Raycaster,
  Ray,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { GlobeControls } from "3d-tiles-renderer/three";
import { GLTFExtensionsPlugin } from "3d-tiles-renderer/three/plugins";
import { createGoogleTiles, monitorGoogleTiles } from "./google-3d.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  assetCenter,
  boundsOf,
  geometryPositions,
  geometryPaths,
} from "../domain/model.js";
import { TYPE_COLORS } from "../domain/types.js";
import {createConductorComposer} from "./conductor-composer.js";
import {createSimulationTiles} from "../simulation/tiles-layer.js";
import { appendPublicAttribution } from "../components/public-layers.js";
import { appendOsmAttribution } from "../components/osm-layers.js";
import { createUtilityEquipment } from "./utility-equipment.js";
import { HIGHWAY_CAMERAS } from "../data/highway-cameras.js";
import { cameraSymbolCanvas, createCameraPopup } from "../components/highway-cameras.js";
import { withinCameraViewExtent } from "./camera-symbol-range.js";
import { reverseGlobeRightDrag } from "./right-drag.js";

const rad = (value) => (value * Math.PI) / 180;

export function createSpatialView({
  host,
  bundle,
  apiKey,
  camera: savedCamera,
  environment: savedEnvironment,
  onSelect,
  onSelectContext,
  onEquipmentStatus,
  onEquipmentError,
  onPointer,
  onViewChange,
  onStatus,
  onEnvironmentError,
  onFatal,
}) {
  if (!apiKey)
    throw new Error("Google 3D requires a configured Map Tiles API key.");
  let disposed = false,
    loaded = false,
    fatal = false;
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor("#122c3c");
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.setAttribute(
    "aria-label",
    "Photorealistic 3D utility map. Use search or the asset inventory for keyboard inspection.",
  );
  host.append(renderer.domElement);
  const scene = new Scene();
  const ambient = new AmbientLight(0xffffff, 2);
  ambient.layers.enable(1);
  scene.add(ambient);
  const camera = new PerspectiveCamera(60, 1, 2, 1e8);
  const tiles = createGoogleTiles(apiKey);
  const draco = new DRACOLoader().setDecoderPath(
    `${import.meta.env.BASE_URL}draco/`,
  );
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.setCamera(camera);
  scene.add(tiles.group);
  const overlay = new Group();
  scene.add(overlay);
  const b = boundsOf(bundle.assets),
    initialCenter = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const origin = tiles.ellipsoid.getCartographicToPosition(
    rad(initialCenter[1]),
    rad(initialCenter[0]),
    0,
    new Vector3(),
  );
  overlay.position.copy(origin);
  const contextOverlay = new Group();
  contextOverlay.position.copy(origin);
  scene.add(contextOverlay);
  const cameraOverlay = new Group();
  cameraOverlay.position.copy(origin);
  scene.add(cameraOverlay);
  const cameraTexture = new CanvasTexture(cameraSymbolCanvas());
  cameraTexture.colorSpace = SRGBColorSpace;
  const cameraMaterial = new SpriteMaterial({ map: cameraTexture, sizeAttenuation: false, depthTest: false, toneMapped: false });
  for (const feature of HIGHWAY_CAMERAS.features) {
    const sprite = new Sprite(cameraMaterial);
    sprite.position.copy(position(feature.geometry.coordinates, 12));
    sprite.layers.set(1);
    sprite.userData.cameraFeature = feature;
    cameraOverlay.add(sprite);
  }
  let cameraPopup, selectedCamera;
  const popupHost = document.createElement("div");
  popupHost.className = "camera-3d-popup";
  popupHost.hidden = true;
  host.append(popupHost);
  function closeCameraPopup() {
    cameraPopup?.dispose();
    cameraPopup = null;
    selectedCamera = null;
    popupHost.hidden = true;
  }
  function showCamera(sprite) {
    closeCameraPopup();
    selectedCamera = sprite;
    cameraPopup = createCameraPopup(sprite.userData.cameraFeature, { onClose: closeCameraPopup });
    popupHost.replaceChildren(cameraPopup.element);
    popupHost.hidden = false;
    positionCameraPopup();
  }
  const cameraWorld = new Vector3(), cameraScreen = new Vector3(), toViewer = new Vector3();
  function groundViewExtentMeters() {
    const target = new Vector3();
    if (!tiles.ellipsoid.intersectRay(new Ray(camera.position.clone(), camera.getWorldDirection(new Vector3())), target))
      return Infinity;
    return 2 * camera.position.distanceTo(target) * Math.tan(camera.fov * Math.PI / 360) * Math.max(1, camera.aspect);
  }
  function positionCameraPopup() {
    const size = (29 / Math.max(host.clientHeight, 1)) * 2 * Math.tan(rad(camera.fov / 2));
    const camerasVisible = withinCameraViewExtent(groundViewExtentMeters());
    for (const sprite of cameraOverlay.children) {
      sprite.scale.set(size, size, 1);
      sprite.getWorldPosition(cameraWorld);
      toViewer.copy(camera.position).sub(cameraWorld);
      cameraScreen.copy(cameraWorld).project(camera);
      sprite.visible = camerasVisible && cameraWorld.dot(toViewer) > 0 && Math.abs(cameraScreen.x) < 1.1 && Math.abs(cameraScreen.y) < 1.1 && cameraScreen.z >= -1 && cameraScreen.z < 1;
    }
    if (!selectedCamera) return;
    if (!selectedCamera.visible) { closeCameraPopup(); return; }
    popupHost.hidden = false;
    selectedCamera.getWorldPosition(cameraWorld);
    cameraScreen.copy(cameraWorld).project(camera);
    const maxHeight = `${Math.max(100, host.clientHeight / 2 - 36)}px`;
    if (cameraPopup.element.style.maxHeight !== maxHeight) cameraPopup.element.style.maxHeight = maxHeight;
    const width = popupHost.offsetWidth, height = popupHost.offsetHeight;
    const maximumTop = host.clientHeight - height - 8;
    const minimumTop = Math.min(64, Math.max(8, maximumTop));
    popupHost.style.left = `${Math.max(8, Math.min(host.clientWidth - width - 8, (cameraScreen.x + 1) / 2 * host.clientWidth - width / 2))}px`;
    popupHost.style.top = `${Math.max(minimumTop, Math.min(maximumTop, (1 - cameraScreen.y) / 2 * host.clientHeight - height - 20))}px`;
  }
  let previousContextData, previousContextLayers, previousContextSelection;
  const controls = new GlobeControls(scene, camera, renderer.domElement);
  const restoreRightDrag = reverseGlobeRightDrag(controls, renderer.domElement);
  controls.setEllipsoid(tiles.ellipsoid, tiles.group);
  controls.enableDamping = true;
  controls.adjustHeight = false;
  const raycaster = new Raycaster(),
    mouse = new Vector2();
  raycaster.layers.set(1);
  raycaster.params.Line.threshold = 20;
  raycaster.params.Points.threshold = 8;
  const removeAttribution = appendPublicAttribution(host, bundle);
  const osmAttribution = appendOsmAttribution(host);
  let down = null;
  function fail(message) {
    if (disposed || fatal) return;
    fatal = true;
    onFatal(message);
  }
  const onLoaded = ({ scene: model, tile }) => {
    if (disposed) return;
    model?.traverse((object) => {
      if (object.isMesh)
        object.userData.geoboundTerrainError = tile?.geometricError ?? Infinity;
      if (
        object.isMesh &&
        object.geometry &&
        !object.geometry.getAttribute("normal")
      )
        object.geometry.computeVertexNormals();
    });
  };
  const credit = document.createElement("div");
  credit.className = "google-attribution";
  credit.setAttribute("aria-label", "Google Maps attribution");
  host.append(credit);
  const brand = document.createElement("img");
  brand.src = `${import.meta.env.BASE_URL}google-maps-logo.svg`;
  brand.alt = "Google Maps";
  brand.width = 86;
  brand.height = 18;
  credit.append(brand);
  const credits = document.createElement("span");
  credit.append(credits);
  const refreshCredits = () => {
    credits.textContent = tiles
      .getAttributions()
      .filter((a) => a.type === "string")
      .map((a) => a.value)
      .join(" · ");
  };
  tiles.addEventListener("load-model", onLoaded);
  tiles.addEventListener("tile-visibility-change", refreshCredits);
  tiles.addEventListener("load-tileset", refreshCredits);
  const environment = createConductorComposer({
    renderer,scene,camera,settings:savedEnvironment,
    onState:({ready,cloudsEnabled,cloudCoverage})=>{
      host.dataset.atmosphere=ready?'ready':'loading';
      host.dataset.cloudsEnabled=String(cloudsEnabled);
      host.dataset.cloudCoverage=String(cloudCoverage);
    },
    onUnavailable:()=>{
      host.dataset.atmosphere='unavailable';
      onEnvironmentError?.('Sky and clouds could not load. The 3D map and line glow remain available.');
    },
  });
  const simulationLayer=createSimulationTiles({renderer,scene,camera,tiles,glow:environment.glow,host,onError:onEquipmentError,
    getView:()=>{const target=viewPivot();if(!target)return null;const p=tiles.ellipsoid.getPositionToCartographic(target,{});return {center:{lng:p.lon*180/Math.PI,lat:p.lat*180/Math.PI},range:camera.position.distanceTo(target)};}});
  const stopMonitoringTiles = monitorGoogleTiles(tiles, {
    onReady: () => {
      loaded = true;
      void environment.start();
      onStatus("3D · Google Photorealistic 3D Tiles · illustrative utility overlays");
    },
    onProgress: onStatus,
    onFailure: fail,
  });
  function clearOverlay() {
    overlay.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material))
        object.material.forEach((m) => m.dispose());
      else object.material?.dispose();
    });
    overlay.clear();
  }
  function position(c, lift = 0) {
    // Unknown source height stays unknown. The lift is an illustrative display offset,
    // independent of any imagery-derived elevation and never exported as asset geometry.
    return tiles.ellipsoid
      .getCartographicToPosition(
        rad(c[1]),
        rad(c[0]),
        (c[2] ?? 0) + lift,
        new Vector3(),
      )
      .sub(origin);
  }
  function basisAt(c, direction = [1, 0]) {
    const east = new Vector3(),
      north = new Vector3(),
      up = new Vector3();
    tiles.ellipsoid.getEastNorthUpAxes(rad(c[1]), rad(c[0]), east, north, up);
    const forward = east
      .multiplyScalar(direction[0])
      .addScaledVector(north, direction[1])
      .normalize();
    return new Matrix4().makeBasis(
      forward,
      up,
      forward.clone().cross(up).normalize(),
    );
  }
  const equipmentLight = new DirectionalLight(0xfff2df, 1.3);
  const lightBasis = basisAt(initialCenter);
  equipmentLight.position
    .copy(origin)
    .add(new Vector3(1800, 3000, 2000).applyMatrix4(lightBasis));
  equipmentLight.target.position.copy(origin);
  equipmentLight.layers.set(1);
  scene.add(equipmentLight, equipmentLight.target);
  const equipment = createUtilityEquipment({
    project: position,
    basisAt,
    getCameraPosition: () => camera.position.clone().sub(origin),
    getViewExtentMeters: groundViewExtentMeters,
    sampleGroundHeight: (c) => {
      if (!loaded || c[2] !== undefined) return null;
      const probe = new Raycaster();
      probe.firstHitOnly = true;
      probe.ray.origin.copy(
        tiles.ellipsoid.getCartographicToPosition(
          rad(c[1]),
          rad(c[0]),
          500,
          new Vector3(),
        ),
      );
      probe.ray.direction
        .copy(
          tiles.ellipsoid.getCartographicToNormal(
            rad(c[1]),
            rad(c[0]),
            new Vector3(),
          ),
        )
        .negate();
      probe.far = 1000;
      const hit = probe.intersectObject(tiles.group, true)[0];
      if (!hit || hit.object.userData.geoboundTerrainError > 15) return null;
      const height = tiles.ellipsoid.getPositionToCartographic(
        hit.point,
        {},
      ).height;
      return Number.isFinite(height) && Math.abs(height) < 150 ? height : null;
    },
    onStatus: onEquipmentStatus,
    onError: onEquipmentError,
  });
  equipment.group.position.copy(origin);
  scene.add(equipment.group);
  function clearContext() {
    contextOverlay.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    contextOverlay.clear();
  }
  function updateContext(context) {
    if (!context) return;
    if (
      context.data === previousContextData &&
      context.layers === previousContextLayers &&
      context.selectedId === previousContextSelection
    )
      return;
    previousContextData = context.data;
    previousContextLayers = context.layers;
    previousContextSelection = context.selectedId;
    clearContext();
    osmAttribution.update(
      Object.keys(context.data).some((id) => context.layers[id]),
    );
    for (const layer of context.manifest?.layers || []) {
      if (!context.layers[layer.id] || !context.data[layer.id]) continue;
      const linePositions = [],
        lineIds = [],
        pointPositions = [],
        pointIds = [];
      let selectedFeature;
      for (const feature of context.data[layer.id].features) {
        const id = feature.properties.id;
        if (id === context.selectedId) selectedFeature = feature;
        // Flat outlines are context; height tags stay source metadata rather than
        // being confused with absolute terrain elevation or a surveyed utility height.
        if (feature.geometry.type === "Point") {
          const p = position(feature.geometry.coordinates, 3);
          pointPositions.push(p.x, p.y, p.z);
          pointIds.push(id);
        } else {
          for (const path of geometryPaths(feature.geometry)) {
            let previous = position(path[0], 3);
            for (const c of path.slice(1)) {
              const next = position(c, 3);
              linePositions.push(
                previous.x,
                previous.y,
                previous.z,
                next.x,
                next.y,
                next.z,
              );
              lineIds.push(id);
              previous = next;
            }
          }
        }
      }
      if (linePositions.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          "position",
          new Float32BufferAttribute(linePositions, 3),
        );
        const lines = new LineSegments(
          geometry,
          new LineBasicMaterial({
            color: layer.color,
            transparent: true,
            opacity: 0.75,
            depthTest: false,
          }),
        );
        lines.userData.contextSegments = lineIds;
        lines.renderOrder = 10;
        contextOverlay.add(lines);
      }
      if (pointPositions.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          "position",
          new Float32BufferAttribute(pointPositions, 3),
        );
        const points = new Points(
          geometry,
          new PointsMaterial({
            color: layer.color,
            size: 5,
            sizeAttenuation: false,
            depthTest: false,
          }),
        );
        points.userData.contextPoints = pointIds;
        points.renderOrder = 10;
        contextOverlay.add(points);
      }
      if (selectedFeature) {
        for (const path of geometryPaths(selectedFeature.geometry)) {
          const line = new Line(
            new BufferGeometry().setFromPoints(path.map((c) => position(c, 4))),
            new LineBasicMaterial({ color: "#ffffff", depthTest: false }),
          );
          line.userData.contextId = selectedFeature.properties.id;
          line.renderOrder = 15;
          contextOverlay.add(line);
        }
        if (selectedFeature.geometry.type === "Point") {
          const point = new Mesh(
            new SphereGeometry(7, 10, 8),
            new MeshBasicMaterial({ color: "#ffffff", depthTest: false }),
          );
          point.position.copy(
            position(selectedFeature.geometry.coordinates, 4),
          );
          point.userData.contextId = selectedFeature.properties.id;
          contextOverlay.add(point);
        }
      }
    }
    contextOverlay.traverse((object) => object.layers.set(1));
  }
  function update({ assets, selectedId, connectedIds, context, highwayCamerasVisible = true }) {
    cameraOverlay.visible = highwayCamerasVisible;
    if (!highwayCamerasVisible) closeCameraPopup();
    updateContext(context);
    equipment.update({ assets, selectedId, connectedIds });
    clearOverlay();
    for (const asset of assets) {
      if (
        ["substation", "transmission_line", "gas_main"].includes(
          asset.assetType,
        )
      )
        continue;
      const selected = asset.id === selectedId,
        neighbor = connectedIds.includes(asset.id);
      const color = selected
        ? "#ffffff"
        : neighbor
          ? "#65e4f5"
          : TYPE_COLORS[asset.assetType] || "#37c6ef";
      const pts = geometryPositions(asset.geometry).map((p) =>
        position(p, asset.assetType === "overhead_line" ? 14 : 8),
      );
      if (
        asset.geometry.type === "Point" ||
        asset.geometry.type === "MultiPoint"
      ) {
        for (const p of pts) {
          const radius = selected
            ? 9
            : neighbor
              ? 7
              : asset.assetType === "meter"
                ? 3
                : asset.assetType === "pole"
                  ? 2
                  : 5;
          const mesh = new Mesh(
            new SphereGeometry(radius, 10, 8),
            new MeshBasicMaterial({ color, depthTest: false }),
          );
          mesh.position.copy(p);
          mesh.userData.assetId = asset.id;
          mesh.renderOrder = 20;
          overlay.add(mesh);
          const glow = new Mesh(
            new SphereGeometry(radius * 1.9, 10, 8),
            new MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.12,
              blending: AdditiveBlending,
              depthWrite: false,
              depthTest: false,
            }),
          );
          glow.position.copy(p);
          overlay.add(glow);
        }
      } else
        for (const path of geometryPaths(asset.geometry)) {
          const pts = path.map((p) =>
            position(p, asset.assetType === "overhead_line" ? 14 : 8),
          );
          if (asset.geometry.type.includes("LineString")) {
            if (
              asset.assetType === "transmission_line" ||
              asset.assetType === "gas_main"
            ) {
              const line = new Line(
                new BufferGeometry().setFromPoints(pts),
                new LineBasicMaterial({ color, depthTest: false }),
              );
              line.userData.assetId = asset.id;
              line.renderOrder = 20;
              overlay.add(line);
              continue;
            }
            const curve = new CatmullRomCurve3(pts);
            const line = new Mesh(
              new TubeGeometry(
                curve,
                Math.max(2, pts.length * 3),
                selected ? 2.4 : 1.3,
                5,
                false,
              ),
              new MeshBasicMaterial({ color, depthTest: false }),
            );
            line.userData.assetId = asset.id;
            line.renderOrder = 20;
            overlay.add(line);
            const halo = new Mesh(
              new TubeGeometry(curve, Math.max(2, pts.length * 3), 5, 5, false),
              new MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.14,
                blending: AdditiveBlending,
                depthWrite: false,
                depthTest: false,
              }),
            );
            overlay.add(halo);
          } else {
            const line = new Line(
              new BufferGeometry().setFromPoints(pts),
              new LineBasicMaterial({ color, depthTest: false }),
            );
            line.userData.assetId = asset.id;
            overlay.add(line);
          }
        }
    }
    // Compose the environment on terrain, then draw utility symbols independently
    // so cloud lighting does not alter their legend or selection colors.
    overlay.traverse((object) => object.layers.set(1));
  }
  function viewAt(center, distance = 1900, groundHeight = 0) {
    const target = tiles.ellipsoid.getCartographicToPosition(
      rad(center[1]),
      rad(center[0]),
      groundHeight,
      new Vector3(),
    );
    const east = new Vector3(),
      north = new Vector3(),
      up = new Vector3();
    tiles.ellipsoid.getEastNorthUpAxes(
      rad(center[1]),
      rad(center[0]),
      east,
      north,
      up,
    );
    camera.position
      .copy(target)
      .addScaledVector(north, -distance * (distance === 1900 ? 0.96 : 0.8))
      .addScaledVector(up, distance * (distance === 1900 ? 0.25 : 0.65))
      .addScaledVector(east, distance * 0.13);
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  }
  function viewPivot() {
    const probe=new Raycaster(camera.position,camera.getWorldDirection(new Vector3()));
    probe.firstHitOnly=true;
    const hit=probe.intersectObject(tiles.group,true)[0];
    if(hit)return hit.point;
    const pivot=new Vector3();controls.getPivotPoint(pivot);return pivot;
  }
  function captureCamera() {
    const pivot = viewPivot();
    const p = tiles.ellipsoid.getPositionToCartographic(
      pivot.length() > 1 ? pivot : origin,
      {},
    );
    return {
      mode: "3d",
      center: [(p.lon * 180) / Math.PI, (p.lat * 180) / Math.PI],
      zoom: 15,
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      up: camera.up.toArray(),
    };
  }
  function restoreCamera(c) {
    if (c?.position && c?.quaternion) {
      camera.position.fromArray(c.position);
      camera.quaternion.fromArray(c.quaternion);
      if (c.up) camera.up.fromArray(c.up);
      camera.updateMatrixWorld();
    } else viewAt(c?.center || initialCenter);
  }
  function resize() {
    if (disposed || !host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
    environment.resize(host.clientWidth, host.clientHeight);
    tiles.setResolutionFromRenderer(camera, renderer);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  function mouseRay(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(mouse, camera);
  }
  function pointerDown(e) {
    down = [e.clientX, e.clientY];
  }
  function pointerUp(e) {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
      return;
    mouseRay(e);
    const cameraHit = cameraOverlay.visible && raycaster.intersectObjects(cameraOverlay.children).find((hit) => hit.object.visible);
    if (cameraHit) { showCamera(cameraHit.object); return; }
    closeCameraPopup();
    const hit = raycaster
      .intersectObjects(
        [...overlay.children, ...equipment.group.children],
        true,
      )
      .find(
        (h) =>
          h.object.userData.assetId ||
          h.object.userData.assetIds?.[h.instanceId],
      );
    if (hit) {
      const ids = hit.object.userData.assetIds?.[hit.instanceId];
      onSelect(hit.object.userData.assetId || ids?.[0]);
    } else {
      const hits = raycaster.intersectObjects(contextOverlay.children, true);
      // The wider line hit tolerance must not steal clicks from small point symbols.
      const context =
        hits.find(
          (hit) =>
            hit.object.userData.contextPoints ||
            (hit.object.isMesh && hit.object.userData.contextId),
        ) ||
        hits.find(
          (hit) =>
            hit.object.userData.contextId ||
            hit.object.userData.contextSegments,
        );
      if (context) {
        const data = context.object.userData;
        const id =
          data.contextId ||
          data.contextPoints?.[context.index] ||
          data.contextSegments?.[Math.floor(context.index / 2)];
        if (id) onSelectContext?.(id);
      }
    }
  }
  function pointerMove(e) {
    mouseRay(e);
    const p = new Vector3();
    if (tiles.ellipsoid.intersectRay(raycaster.ray, p)) {
      const c = tiles.ellipsoid.getPositionToCartographic(p, {});
      onPointer?.({
        longitude: (c.lon * 180) / Math.PI,
        latitude: (c.lat * 180) / Math.PI,
      });
    }
  }
  function lost(e) {
    e.preventDefault();
    fail("3D rendering was interrupted. Switching to the 2D view.");
  }
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("webglcontextlost", lost);
  restoreCamera(savedCamera);
  resize();
  update({ assets: bundle.assets, selectedId: null, connectedIds: [] });
  let previousFrame = null, flight, focusEpoch=0;
  let lastViewPosition = new Vector3(),
    lastViewQuaternion = camera.quaternion.clone(),
    lastViewReport = 0;
  renderer.setAnimationLoop((now) => {
    if (disposed || !host.clientWidth || !host.clientHeight) return;
    if(flight){const t=Math.min(1,(now-flight.start)/900),e=t*t*(3-2*t);viewAt(flight.center,flight.range*(2.5-1.5*e),flight.height);if(t===1){const done=flight.resolve;flight=null;controls.enabled=true;done();}}
    else controls.update();
    camera.updateMatrixWorld();
    tiles.update();
    equipment.tick();
    simulationLayer.tick(now);
    positionCameraPopup();
    if (
      now - lastViewReport > 500 &&
      (lastViewPosition.distanceTo(camera.position) > 25 ||
        lastViewQuaternion.angleTo(camera.quaternion) > 0.02)
    ) {
      lastViewReport = now;
      lastViewPosition.copy(camera.position);
      lastViewQuaternion.copy(camera.quaternion);
      const target = new Vector3();
      if (
        tiles.ellipsoid.intersectRay(
          new Ray(
            camera.position.clone(),
            camera.getWorldDirection(new Vector3()),
          ),
          target,
        )
      ) {
        const c = tiles.ellipsoid.getPositionToCartographic(target, {});
        const lon = (c.lon * 180) / Math.PI,
          lat = (c.lat * 180) / Math.PI;
        const latitudeRadius = Math.max(
          0.025,
          (camera.position.distanceTo(target) / 111000) * 1.5,
        );
        const longitudeRadius = latitudeRadius / Math.max(0.2, Math.cos(c.lat));
        onViewChange?.({
          center: [lon, lat],
          bounds: [
            Math.max(-180, lon - longitudeRadius),
            Math.max(-90, lat - latitudeRadius),
            Math.min(180, lon + longitudeRadius),
            Math.min(90, lat + latitudeRadius),
          ],
        });
      }
    }
    const delta =
      previousFrame === null ? 0 : Math.min((now - previousFrame) / 1000, 0.1);
    previousFrame = now;
    camera.layers.set(0);
    if (!environment.render(delta)) {
      // Atmospheric LUT generation temporarily disables autoClear on the renderer.
      // Keep the map visible while those resources warm up.
      const autoClear = renderer.autoClear;
      renderer.autoClear = true;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.clearDepth();
    camera.layers.set(1);
    renderer.render(scene, camera);
    camera.layers.set(0);
    renderer.autoClear = autoClear;
  });
  onStatus("Loading Google photorealistic 3D…");
  return {
    simulationPostprocessing:true,
    async setSimulation(next){
      if(!next?.visible){focusEpoch++;flight?.resolve();flight=null;controls.enabled=true;}
      await simulationLayer.set(next);
    },
    async focusSimulation(bounds){
      const epoch=focusEpoch;
      const center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
      const range=Math.max(350,(bounds[3]-bounds[1])*111320,(bounds[2]-bounds[0])*111320*Math.cos(rad(center[1]))/Math.max(.4,camera.aspect))*1.4;
      viewAt(center,range*2.5);
      await simulationLayer.waitReady();
      if(disposed||epoch!==focusEpoch)return;
      await new Promise(resolve=>{controls.enabled=false;flight={center,range,height:simulationLayer.groundCenter(),start:performance.now(),resolve};});
    },
    update,
    closeCameraPopup,
    setEnvironment: (settings) => environment.setClouds(settings),
    captureCamera,
    restoreCamera,
    resize,
    focusAsset: (asset) => viewAt(assetCenter(asset), asset.assetType === "substation" ? 100 : 700),
    focusBounds: (bounds) =>
      viewAt(
        [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        Math.max(1900, (bounds[3] - bounds[1]) * 111000 * 1.2),
      ),
    reset: () => viewAt(initialCenter),
    zoom(delta) {
      const pivot = viewPivot();
      if (pivot.length() < 1) pivot.copy(origin);
      camera.position
        .sub(pivot)
        .multiplyScalar(delta > 0 ? 0.8 : 1.25)
        .add(pivot);
    },
    dispose() {
      disposed = true;
      flight?.resolve();flight=null;simulationLayer.dispose();
      stopMonitoringTiles();
      renderer.setAnimationLoop(null);
      observer.disconnect();
      restoreRightDrag();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      tiles.removeEventListener("load-model", onLoaded);
      tiles.removeEventListener("tile-visibility-change", refreshCredits);
      tiles.removeEventListener("load-tileset", refreshCredits);
      clearOverlay();
      equipment.dispose();
      clearContext();
      closeCameraPopup();
      popupHost.remove();
      cameraOverlay.clear();
      cameraMaterial.dispose();
      cameraTexture.dispose();
      osmAttribution.dispose();
      tiles.dispose();
      draco.dispose();
      renderer.domElement.remove();
      credit.remove();
      removeAttribution();
      delete host.dataset.atmosphere;
      delete host.dataset.cloudsEnabled;
      delete host.dataset.cloudCoverage;
      void environment.dispose().finally(() => {
        renderer.dispose();
        renderer.forceContextLoss();
      });
    },
  };
}
