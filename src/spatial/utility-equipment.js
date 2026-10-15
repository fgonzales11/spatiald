import {
  BoxGeometry,
  CustomBlending,
  SrcAlphaFactor,
  DstAlphaFactor,
  AddEquation,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Curve,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  DoubleSide,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import poleDefinition from "../assets/transmission-pole.json" with { type: "json" };
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { geometryPaths, geometryPositions } from "../domain/model.js";
import { TYPE_COLORS } from "../domain/types.js";
import { infrastructureColor, CARTO_TRANSMISSION_OPACITY } from "./infrastructure-style.js";
import { withinSubstationViewExtent } from "./substation-symbol-range.js";
import {
  planTransmissionPoles,
  sampleRoute,
  offsetMeters,
  routeDirection,
  distanceMeters,
} from "./pole-placement.js";

export const EQUIPMENT_SETTINGS = Object.freeze({
  poleHeight: poleDefinition.height,
  attachmentHeight: Math.max(...poleDefinition.phaseHeights),
  phaseOffset: Math.max(...poleDefinition.phaseOffsets.map(Math.abs)),
  conductorSag: 0.85,
  conductorWidth: 3,
  selectedConductorWidth: 4.5,
  poleGroundLift: 0.15,
  groundLift: 2,
  pipeRadius: 0.9,
  pipeDepth: 2.2,
  pipeOpacity: 0.38,
  pipeSampleSpacing: 10,
  pipeGroundingDistance: 1800,
  maximumPipeGroundSamples: 160,
  poleDetailDistance: 1200,
  maximumDetailedPoles: 96,
  poleVisibilityDistance: 8000,
  maximumVisiblePoles: 384,
  bankDetailDistance: 1800,
  maximumDetailedBanks: 24,
});

const poleModelUrl = new URL("../assets/transmission-pole.glb", import.meta.url).href;

/** These world-space seats use the same transform as the instanced pole. */
export function poleConductorSeats(placement, phase, project, basisAt, groundHeight = 0) {
  const base = basisAt(placement.coordinates, placement.direction);
  base.setPosition(project(placement.coordinates, EQUIPMENT_SETTINGS.poleGroundLift + groundHeight));
  return ["incoming", "outgoing"].map((side) =>
    new Vector3().fromArray(poleDefinition.attachments[side][phase]).applyMatrix4(base));
}

// Retain every source corner while adding enough samples to follow terrain.
function routeAnchors(path, spacing) {
  const anchors = [...sampleRoute(path, spacing)];
  let chainage = 0;
  for (let i = 1; i < path.length; i++) {
    chainage += distanceMeters(path[i - 1], path[i]);
    anchors.push({ coordinates: path[i], direction: routeDirection(path[i - 1], path[i]), chainage });
  }
  anchors.sort((a, b) => a.chainage - b.chainage);
  return anchors.filter((anchor, i) => !i || Math.abs(anchor.chainage - anchors[i - 1].chainage) > 0.001);
}

// Linear interpolation prevents a spline from arching above the sampled surface.
class GroundRouteCurve extends Curve {
  constructor(anchors, points) {
    super();
    this.anchors = anchors;
    this.points = points;
  }
  getPoint(t, target = new Vector3()) {
    const chainage = t * this.anchors.at(-1).chainage;
    let low = 0, high = this.anchors.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (this.anchors[middle].chainage < chainage) low = middle;
      else high = middle;
    }
    const start = this.anchors[low].chainage, end = this.anchors[high].chainage;
    return target.copy(this.points[low]).lerp(this.points[high], (chainage - start) / (end - start));
  }
  getPointAt(t, target) { return this.getPoint(t, target); }
  getTangentAt(t, target) { return this.getTangent(t, target); }
}

/** A three-phase bank with three concentric windings per unit and radiator fins. */
export function createTransformerBankTemplate() {
  const root = new Group();
  root.name = "Three-phase three-winding transformer bank";
  const box = new BoxGeometry(1, 1, 1),
    cylinder = new CylinderGeometry(1, 1, 1, 10),
    torus = new TorusGeometry(1, 0.06, 5, 20);
  const metal = new MeshPhongMaterial({
    color: "#718893",
    shininess: 45,
    depthTest: true,
  });
  const dark = new MeshPhongMaterial({ color: "#30464e", depthTest: true });
  const concrete = new MeshPhongMaterial({
    color: "#99a4a6",
    depthTest: true,
  });
  const glass = new MeshPhongMaterial({
    color: "#83d7e5",
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
  });
  const windingMaterials = ["#c77836", "#a85423", "#e1ae53"].map(
    (color) => new MeshPhongMaterial({ color, shininess: 65, depthTest: true }),
  );
  const bushingMaterials = ["#947151", "#c3d2dc", "#82b9c4"].map(
    (color) => new MeshPhongMaterial({ color, shininess: 45, depthTest: true }),
  );
  function part(
    parent,
    name,
    geometry,
    material,
    dimensions,
    position,
    rotation,
  ) {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.scale.set(...dimensions);
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
  }
  part(root, "Shared foundation", box, concrete, [16, 0.4, 6.6], [0, 0.2, 0]);
  for (const [phaseIndex, phase] of ["A", "B", "C"].entries()) {
    const unit = new Group();
    unit.name = `Phase ${phase} transformer`;
    unit.position.x = (phaseIndex - 1) * 5;
    unit.userData = { phase, windingCount: 3, radiatorFinCount: 24 };
    root.add(unit);
    // A display cutaway exposes the windings through the front inspection panel.
    part(unit, "Tank back", box, metal, [2.5, 3.7, 0.12], [0, 2.35, -1.4]);
    for (const x of [-1.25, 1.25])
      part(unit, "Tank side", box, metal, [0.12, 3.7, 2.8], [x, 2.35, 0]);
    part(unit, "Tank base", box, metal, [2.6, 0.25, 2.9], [0, 0.65, 0]);
    part(unit, "Tank lid", box, metal, [2.65, 0.25, 2.95], [0, 4.25, 0]);
    part(
      unit,
      "Inspection cutaway",
      box,
      glass,
      [2.38, 3.4, 0.05],
      [0, 2.45, 1.4],
    );
    part(unit, "Iron core", box, dark, [0.5, 2.9, 0.5], [0, 2.1, 0]);
    for (const [windingIndex, windingName] of [
      "HV",
      "LV",
      "Tertiary",
    ].entries()) {
      const winding = new Group();
      winding.name = `${phase} ${windingName} winding`;
      winding.userData.winding = windingName;
      unit.add(winding);
      const radius = [0.42, 0.68, 0.95][windingIndex];
      for (let ring = 0; ring < 7; ring++)
        part(
          winding,
          "Copper winding turn",
          torus,
          windingMaterials[windingIndex],
          [radius, radius, radius],
          [0, 1.3 + ring * 0.3, 0],
          [Math.PI / 2, 0, 0],
        );
      for (const x of [-0.63, 0.63]) {
        const height = [1.6, 1.1, 0.8][windingIndex],
          z = (windingIndex - 1) * 0.85;
        part(
          unit,
          `${windingName} bushing stem`,
          cylinder,
          bushingMaterials[windingIndex],
          [0.1, height, 0.1],
          [x, 4.37 + height / 2, z],
        );
        for (let rib = 0; rib < 6; rib++)
          part(
            unit,
            `${windingName} bushing rib`,
            cylinder,
            bushingMaterials[windingIndex],
            [0.22, 0.09, 0.22],
            [x, 4.55 + (rib * height) / 7, z],
          );
        part(
          unit,
          `${windingName} terminal cap`,
          cylinder,
          metal,
          [0.1, 0.17, 0.1],
          [x, 4.4 + height, z],
        );
      }
    }
    for (const side of [-1, 1]) {
      for (let fin = 0; fin < 12; fin++)
        part(
          unit,
          "Radiator fin",
          box,
          metal,
          [0.9, 2.75, 0.065],
          [side * 1.75, 2.35, (fin - 5.5) * 0.22],
        );
      for (const height of [1.02, 3.64])
        part(
          unit,
          "Radiator manifold",
          cylinder,
          dark,
          [0.1, 3, 0.1],
          [side * 1.67, height, 0],
          [Math.PI / 2, 0, 0],
        );
    }
    part(
      unit,
      "Oil conservator",
      cylinder,
      metal,
      [0.34, 2.3, 0.34],
      [0, 4.95, -1.65],
      [0, 0, Math.PI / 2],
    );
  }
  root.updateMatrixWorld(true);
  return root;
}

function partsOf(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((object) => {
    if (object.isMesh)
      parts.push({
        geometry: object.geometry,
        material: object.material,
        matrix: object.matrixWorld.clone(),
        name: object.name,
        sourcePart: object.userData.sourcePart,
      });
  });
  return parts;
}

/** Resources and instance buffers belong to this view, not the workspace records. */
export function createUtilityEquipment({
  project,
  basisAt,
  getCameraPosition,
  getViewExtentMeters = () => Infinity,
  sampleGroundHeight = () => null,
  loadPoleModel = async () => (await new GLTFLoader().loadAsync(poleModelUrl)).scene,
  onStatus,
  onError,
}) {
  const group = new Group();
  group.name = "Illustrative utility equipment";
  const staticGroup = new Group(),
    detailGroup = new Group();
  group.add(staticGroup, detailGroup);
  let disposed = false,
    assets = [],
    selectedId,
    connectedIds = [],
    plan,
    poleParts,
    modelLoading = false;
  let revision = 0,
    lastDetailRevision = -1,
    lastDetailPosition = new Vector3(Infinity, Infinity, Infinity);
  const resources = new Set(),
    dynamic = new Set(),
    materialsByAsset = new Map();
  const bankParts = partsOf(createTransformerBankTemplate());
  const groundHeights = new Map();
  const resolvedPoleHeights = new Map();
  let pipeGroundPoints = [];
  let lastGroundSample = 0;
  const groundKey = (c) => `${c[0].toFixed(6)}:${c[1].toFixed(6)}`;
  const sampledGroundOffset = (c) =>
    c[2] === undefined ? (groundHeights.get(groundKey(c)) ?? null) : 0;
  const groundOffset = (c) => sampledGroundOffset(c) ?? resolvedPoleHeights.get(groundKey(c))?.height ?? null;
  for (const part of bankParts) {
    resources.add(part.geometry);
    resources.add(part.material);
  }
  const markerGeometry = new BoxGeometry(5, 1, 5),
    markerMaterial = new MeshBasicMaterial({
      color: "#ffffff",
      depthTest: true,
    });
  resources.add(markerGeometry);
  resources.add(markerMaterial);

  function disposeResource(resource) {
    for (const value of Object.values(resource))
      if (value?.isTexture) {
        value.dispose();
        value.source?.data?.close?.();
      }
    resource.dispose?.();
  }
  function clearInstances(target) {
    target.traverse((object) => {
      if (object.isInstancedMesh) object.dispose();
    });
    target.clear();
  }
  function clearStatic() {
    clearInstances(staticGroup);
    for (const resource of dynamic) resource.dispose();
    dynamic.clear();
    materialsByAsset.clear();
  }
  function applyHighlight() {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    for (const [id, materials] of materialsByAsset)
      for (const material of materials) {
        material.color.set(
          id === selectedId
            ? "#ffffff"
            : connectedIds.includes(id)
              ? "#65e4f5"
              : infrastructureColor(assetsById.get(id) || {}),
        );
        if (material.isLineMaterial)
          material.linewidth = id === selectedId
            ? EQUIPMENT_SETTINGS.selectedConductorWidth
            : EQUIPMENT_SETTINGS.conductorWidth;
      }
    detailGroup.traverse((object) => {
      if (!object.isInstancedMesh) return;
      for (let i = 0; i < object.count; i++)
        object.setColorAt(
          i,
          new Color(
            object.userData.assetIds[i]?.includes(selectedId) && !object.userData.sourceParts?.length
              ? "#b9f3ff"
              : object.name === "Substation · distant marker"
                ? connectedIds.includes(object.userData.assetIds[i]?.[0])
                  ? "#65e4f5"
                  : infrastructureColor(assetsById.get(object.userData.assetIds[i]?.[0]) || {})
                : "#ffffff",
          ),
        );
      if (object.instanceColor) object.instanceColor.needsUpdate = true;
    });
  }
  function ownMaterial(asset, material) {
    dynamic.add(material);
    if (!materialsByAsset.has(asset.id)) materialsByAsset.set(asset.id, []);
    materialsByAsset.get(asset.id).push(material);
    return material;
  }
  function addInstances(target, name, parts, placements, lift = EQUIPMENT_SETTINGS.groundLift) {
    if (!placements.length) return;
    const buckets = new Map();
    // Repeated radiator fins, winding turns, and model primitives share draw calls.
    for (const part of parts) {
      let bucket = [...buckets.values()].find(
        (bucket) =>
          bucket.geometry === part.geometry &&
          bucket.material === part.material,
      );
      if (!bucket) {
        bucket = {
          geometry: part.geometry,
          material: part.material,
          parts: [],
        };
        buckets.set(buckets.size, bucket);
      }
      bucket.parts.push(part);
    }
    for (const bucket of buckets.values()) {
      const mesh = new InstancedMesh(
        bucket.geometry,
        bucket.material,
        placements.length * bucket.parts.length,
      );
      mesh.name = name;
      mesh.userData.assetIds = [];
      mesh.userData.sourceParts = bucket.parts.map((part) => part.sourcePart).filter(Boolean);
      mesh.layers.set(1);
      mesh.renderOrder = 23;
      let cursor = 0;
      for (const placement of placements) {
        const base = basisAt(placement.coordinates, placement.direction);
        base.setPosition(
          project(
            placement.coordinates,
            lift +
              (groundOffset(placement.coordinates) || 0),
          ),
        );
        for (const part of bucket.parts) {
          mesh.setMatrixAt(cursor, base.clone().multiply(part.matrix));
          mesh.userData.assetIds[cursor++] = placement.assetIds;
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      target.add(mesh);
    }
  }
  function terrainHeights(anchors, centers = anchors.map((a) => a.coordinates), maximumExtrapolation = 2000, offset = groundOffset) {
    const heights = centers.map(offset);
    const known = heights.flatMap((height, i) => (height === null ? [] : [i]));
    let previousKnown, nextKnown = 0;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] !== null) {
        previousKnown = i;
        while (known[nextKnown] <= i) nextKnown++;
        continue;
      }
      const after = known[nextKnown];
      if (previousKnown !== undefined && after !== undefined) {
        const t = (anchors[i].chainage - anchors[previousKnown].chainage) /
          (anchors[after].chainage - anchors[previousKnown].chainage);
        heights[i] = heights[previousKnown] * (1 - t) + heights[after] * t;
      } else {
        const nearest = previousKnown ?? after;
        heights[i] = nearest !== undefined &&
          Math.abs(anchors[nearest].chainage - anchors[i].chainage) < maximumExtrapolation ? heights[nearest] : 0;
      }
    }
    return heights;
  }
  function transmissionProfile(asset, path, pathIndex) {
    const unique = routeAnchors(path, 30.48);
    const supports = new Map(
      (plan?.byAsset.get(asset.id) || [])
        .filter((p) => p.pathIndex === pathIndex)
        .map((p) => [p.chainage.toFixed(3), p]),
    );
    const centers = unique.map(
      (anchor) =>
        supports.get(anchor.chainage.toFixed(3))?.coordinates ||
        anchor.coordinates,
    );
    return { unique, supports, centers };
  }
  function resolvePoleHeights(profiles) {
    // Resolve every shared support before drawing any line or pole. An unknown
    // bend must not jump to ellipsoid height while its neighboring wires follow
    // sampled terrain. Prefer the route with the closest actual terrain sample.
    for (const { unique, supports, centers } of profiles) {
      const known = centers.flatMap((c, i) => sampledGroundOffset(c) === null ? [] : [i]);
      if (!known.length) continue;
      const heights = terrainHeights(unique, centers, Infinity, sampledGroundOffset);
      let before, after = 0;
      for (let i = 0; i < unique.length; i++) {
        while (after < known.length && known[after] <= i) before = known[after++];
        const support = supports.get(unique[i].chainage.toFixed(3));
        if (!support || sampledGroundOffset(support.coordinates) !== null) continue;
        const distance = Math.min(before === undefined ? Infinity : unique[i].chainage - unique[before].chainage,
          after === known.length ? Infinity : unique[known[after]].chainage - unique[i].chainage);
        const key = groundKey(support.coordinates);
        if (!resolvedPoleHeights.has(key) || distance < resolvedPoleHeights.get(key).distance)
          resolvedPoleHeights.set(key, { height: heights[i], distance });
      }
    }
  }
  function phaseLines(asset, { unique, supports, centers }) {
    if (unique.length < 2) return;
    // The same resolved support height anchors both the span and the pole model.
    const heights = terrainHeights(unique, centers, Infinity);
    const positions = [];
    const segment = (start, end) => positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
    for (let phase = 0; phase < 3; phase++) {
      let previous;
      for (let i = 0; i < unique.length; i++) {
        const anchor = unique[i], center = centers[i];
        const support = supports.get(anchor.chainage.toFixed(3));
        let seats;
        if (support) {
          seats = poleConductorSeats(support, phase, project, basisAt, groundOffset(support.coordinates) ?? heights[i]);
        } else {
          const offset = poleDefinition.phaseOffsets[phase];
          const p = offsetMeters(center, anchor.direction[1] * offset, -anchor.direction[0] * offset);
          seats = [project(p, EQUIPMENT_SETTINGS.poleGroundLift + poleDefinition.phaseHeights[phase] + heights[i])];
        }
        if (previous) {
          const end = seats[0];
          const sag = Math.min(1, previous.distanceTo(end) / 30.48) * EQUIPMENT_SETTINGS.conductorSag;
          const up = new Vector3().setFromMatrixColumn(basisAt(center, anchor.direction), 1).normalize();
          let start = previous;
          for (let step = 1; step <= 4; step++) {
            const t = step / 4;
            const next = previous.clone().lerp(end, t).addScaledVector(up, -4 * t * (1 - t) * sag);
            segment(start, next);
            start = next;
          }
        }
        // A short jumper joins the matching insulators on the paired upper arms.
        if (seats.length === 2) segment(seats[0], seats[1]);
        previous = seats.at(-1);
      }
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    dynamic.add(geometry);
    const line = new LineSegments2(
      geometry,
      ownMaterial(
        asset,
        new LineMaterial({
          color: infrastructureColor(asset),
          transparent: true,
          opacity: CARTO_TRANSMISSION_OPACITY,
          blending: CustomBlending,
          blendSrc: SrcAlphaFactor,
          blendDst: DstAlphaFactor,
          blendEquation: AddEquation,
          linewidth: EQUIPMENT_SETTINGS.conductorWidth,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    );
    line.name = "Three phase A/B/C conductors";
    line.userData = { assetId: asset.id, phaseCount: 3 };
    line.layers.set(1);
    line.renderOrder = 21;
    staticGroup.add(line);
  }
  function rebuild() {
    if (disposed) return;
    clearStatic();
    pipeGroundPoints = [];
    resolvedPoleHeights.clear();
    const profiles = new Map(assets.filter((asset) => asset.assetType === "transmission_line").map((asset) =>
      [asset.id, geometryPaths(asset.geometry).map((path, i) => transmissionProfile(asset, path, i))]));
    resolvePoleHeights([...profiles.values()].flat());
    for (const asset of assets) {
      if (asset.assetType === "transmission_line")
        profiles.get(asset.id).forEach((profile) => phaseLines(asset, profile));
      if (asset.assetType === "gas_main")
        for (const path of geometryPaths(asset.geometry)) {
          if (path.length < 2) continue;
          const length = path.slice(1).reduce((sum, c, i) => sum + distanceMeters(path[i], c), 0);
          const anchors = routeAnchors(path, Math.max(EQUIPMENT_SETTINGS.pipeSampleSpacing, length / 2048));
          if (anchors.length < 2) continue;
          pipeGroundPoints.push(...anchors.map((a) => ({ coordinates: a.coordinates })));
          const heights = terrainHeights(anchors);
          const curve = new GroundRouteCurve(anchors, anchors.map((a, i) =>
            project(a.coordinates, heights[i] - EQUIPMENT_SETTINGS.pipeDepth)));
          const geometry = new TubeGeometry(
            curve,
            Math.min(4096, Math.max(16, anchors.length * 2)),
            EQUIPMENT_SETTINGS.pipeRadius,
            10,
            false,
          );
          dynamic.add(geometry);
          const material = ownMaterial(
            asset,
            new MeshPhongMaterial({
              color: TYPE_COLORS.gas_main,
              shininess: 95,
              specular: "#ffe0cf",
              transparent: true,
              opacity: EQUIPMENT_SETTINGS.pipeOpacity,
              side: DoubleSide,
              depthTest: true,
              depthWrite: false,
            }),
          );
          const pipe = new Mesh(geometry, material);
          pipe.name = "Translucent underground gas pipe";
          pipe.userData = { assetId: asset.id, displayDepth: EQUIPMENT_SETTINGS.pipeDepth };
          pipe.layers.set(1);
          pipe.renderOrder = 25;
          staticGroup.add(pipe);
        }
    }
    revision++;
    refreshDetail(true);
    applyHighlight();
  }
  function refreshDetail(force = false) {
    if (disposed) return;
    const camera = getCameraPosition();
    const changed =
      force ||
      lastDetailRevision !== revision ||
      camera.distanceTo(lastDetailPosition) >= 100;
    const sampleDue = Date.now() - lastGroundSample > 2000;
    if (!changed && !sampleDue) return;
    const near = (placements, distance, limit) =>
      placements
        .map((placement) => ({
          placement,
          distance: project(
            placement.coordinates,
            EQUIPMENT_SETTINGS.groundLift,
          ).distanceTo(camera),
        }))
        .filter((p) => p.distance < distance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((p) => p.placement);
    const detailedPoles = poleParts ? near(
          plan?.placements || [],
          EQUIPMENT_SETTINGS.poleDetailDistance,
          EQUIPMENT_SETTINGS.maximumDetailedPoles,
        ) : [];
    const detailedSet = new Set(detailedPoles);
    // Keep full model instances near the viewer; distant bends become visible
    // as the camera approaches them rather than drawing thousands of tiny GLBs.
    const visiblePoles = poleParts ? near(plan?.placements || [], EQUIPMENT_SETTINGS.poleVisibilityDistance, EQUIPMENT_SETTINGS.maximumVisiblePoles) : [];
    const stations = assets
      .filter((asset) => asset.assetType === "substation")
      .flatMap((asset) =>
        geometryPositions(asset.geometry).map((coordinates) => ({
          coordinates,
          assetIds: [asset.id],
        })),
      );
    const detailed = near(
      stations,
      EQUIPMENT_SETTINGS.bankDetailDistance,
      EQUIPMENT_SETTINGS.maximumDetailedBanks,
    );
    if (sampleDue) {
      lastGroundSample = Date.now();
      let groundChanged = false;
      const nearbyPipePoints = near(pipeGroundPoints,
        EQUIPMENT_SETTINGS.pipeGroundingDistance, EQUIPMENT_SETTINGS.maximumPipeGroundSamples);
      for (const placement of [...detailedPoles, ...detailed, ...nearbyPipePoints]) {
        if (placement.coordinates[2] !== undefined) continue;
        const height = sampleGroundHeight(placement.coordinates),
          previous = sampledGroundOffset(placement.coordinates);
        if (
          Number.isFinite(height) &&
          height !== null &&
          (previous === null || Math.abs(previous - height) > 0.25)
        ) {
          groundHeights.set(groundKey(placement.coordinates), height);
          groundChanged = true;
        }
      }
      if (groundChanged) {
        rebuild();
        return;
      }
    }
    if (!changed) return;
    lastDetailRevision = revision;
    lastDetailPosition.copy(camera);
    clearInstances(detailGroup);
    if (poleParts) addInstances(
        detailGroup,
        "Steel pole · POSTE 05 · bend supports",
        poleParts,
        detailedPoles,
        EQUIPMENT_SETTINGS.poleGroundLift,
      );
    if (poleParts) addInstances(
      detailGroup,
      "Steel pole · POSTE 05 · distant supports",
      poleParts,
      visiblePoles.filter(
        (placement) => !detailedSet.has(placement),
      ),
      EQUIPMENT_SETTINGS.poleGroundLift,
    );
    addInstances(
      detailGroup,
      "Three phase three winding transformer bank",
      bankParts,
      detailed,
    );
    const detailedIds = new Set(detailed.map((station) => station.assetIds[0]));
    addInstances(
      detailGroup,
      "Substation · distant marker",
      [
        {
          geometry: markerGeometry,
          material: markerMaterial,
          matrix: new Matrix4().makeTranslation(0, 6, 0).multiply(new Matrix4().makeRotationY(Math.PI / 4)),
        },
      ],
      stations.filter((station) => !detailedIds.has(station.assetIds[0])),
    );
    applyHighlight();
  }
  function report() {
    onStatus?.({
      status: plan ? "ready" : "loading",
      poles: plan?.statistics.accepted || 0,
      skipped: plan?.statistics.skipped || 0,
      modelReady: Boolean(poleParts),
      modelLoading,
    });
  }
  async function ensureResources() {
    if (!modelLoading && !poleParts && plan?.placements.length) {
      modelLoading = true;
      report();
      try {
        const root = await loadPoleModel();
        const parts = partsOf(root);
        const loadedResources = new Set(parts.flatMap((part) => [part.geometry, part.material]));
        if (disposed) {
          for (const resource of loadedResources) disposeResource(resource);
          return;
        }
        if (!parts.length) throw new Error("The pole model contains no meshes.");
        poleParts = parts;
        for (const resource of loadedResources) resources.add(resource);
        lastGroundSample = 0;
        rebuild();
      } catch (error) {
        if (!disposed) onError?.(`The new pole model could not load: ${error.message}. Use Retry map to reload it.`);
      } finally {
        modelLoading = false;
        if (!disposed) report();
      }
    }
  }
  return {
    group,
    update(next) {
      const changed =
        assets.length !== next.assets.length ||
        assets.some((asset, i) => asset !== next.assets[i]);
      assets = next.assets;
      selectedId = next.selectedId;
      connectedIds = next.connectedIds || [];
      if (changed) {
        plan = planTransmissionPoles(assets);
        rebuild();
        report();
      } else applyHighlight();
      void ensureResources();
    },
    tick: () => {
      refreshDetail();
      const visible = withinSubstationViewExtent(getViewExtentMeters());
      detailGroup.traverse((object) => {
        if (object.name === "Three phase three winding transformer bank" || object.name === "Substation · distant marker")
          object.visible = visible;
      });
    },
    dispose() {
      disposed = true;
      clearStatic();
      clearInstances(detailGroup);
      group.clear();
      for (const resource of resources) disposeResource(resource);
      resources.clear();
      groundHeights.clear();
      resolvedPoleHeights.clear();
    },
  };
}
