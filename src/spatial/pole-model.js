import { Box3, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from "three";

// Keep the shaft and complete upper assembly; omit transformer, lower arms, lamp,
// source wires, and display plane from the separate runtime derivative.
export const RETAINED_POLE_PARTS = Object.freeze({
  Cylinder: "Pole shaft",
  "Cylinder.004_Cylinder.005": "Upper crossarm mounting band",
  "Nut.002": "Upper mounting fasteners",
  "Cube.005_Cube.006": "Upper crossarm braces",
  "Cube.004_Cube.005": "Paired upper crossarms",
  "Nut.001": "Upper crossarm fasteners",
  "Cube.007_Cube.008": "Upper insulators",
});

function componentBounds(geometry) {
  const position = geometry.attributes.position;
  const vertices = [], parents = [], identities = new Map(), ids = [];
  for (let i = 0; i < position.count; i++) {
    const p = new Vector3().fromBufferAttribute(position, i);
    const key = p.toArray().map((v) => v.toFixed(6)).join(":");
    if (!identities.has(key)) {
      identities.set(key, vertices.length);
      parents.push(vertices.length);
      vertices.push(p);
    }
    ids.push(identities.get(key));
  }
  const find = (id) => {
    while (parents[id] !== id) {
      parents[id] = parents[parents[id]];
      id = parents[id];
    }
    return id;
  };
  const indices = geometry.index?.array || ids.map((_, i) => i);
  for (let i = 0; i < indices.length; i += 3) {
    const root = find(ids[indices[i]]);
    parents[find(ids[indices[i + 1]])] = root;
    parents[find(ids[indices[i + 2]])] = root;
  }
  const boxes = new Map();
  vertices.forEach((p, id) => {
    const root = find(id);
    if (!boxes.has(root)) boxes.set(root, new Box3());
    boxes.get(root).expandByPoint(p);
  });
  return [...boxes.values()];
}

/** Normalize a copy of the supplied OBJ and derive conductor seats from its mesh. */
export function prepareSteelPoleModel(source, height = 24) {
  source.updateMatrixWorld(true);
  const root = new Group();
  root.name = "POSTE 05 · transmission pole";
  const materials = new Map();
  for (const [sourceName, name] of Object.entries(RETAINED_POLE_PARTS)) {
    const original = source.getObjectByName(sourceName);
    if (!original?.isMesh) throw new Error(`Missing source pole part: ${sourceName}`);
    if (Array.isArray(original.material)) throw new Error(`Unexpected multi-material part: ${sourceName}`);
    if (!materials.has(original.material)) {
      const shaft = sourceName === "Cylinder";
      const insulator = sourceName === "Cube.007_Cube.008";
      const material = new MeshStandardMaterial({
        color: shaft ? "#8b908c" : insulator ? "#65574f" : "#858a87",
        metalness: shaft || insulator ? 0 : 0.12,
        roughness: shaft ? 0.9 : 0.8,
      });
      material.name = original.material.name;
      materials.set(original.material, material);
    }
    const part = new Mesh(original.geometry.clone().applyMatrix4(original.matrixWorld), materials.get(original.material));
    part.name = name;
    part.userData.sourcePart = sourceName;
    root.add(part);
  }
  const sourceBounds = new Box3().setFromObject(root);
  const scale = height / (sourceBounds.max.y - sourceBounds.min.y);
  const transform = new Matrix4().makeRotationY(Math.PI / 2)
    .multiply(new Matrix4().makeScale(scale, scale, scale))
    .multiply(new Matrix4().makeTranslation(0, -sourceBounds.min.y, 0));
  for (const part of root.children) part.geometry.applyMatrix4(transform);
  const boxes = componentBounds(root.getObjectByName("Upper insulators").geometry);
  if (boxes.length !== 8) throw new Error(`Expected eight upper insulators, found ${boxes.length}`);
  const tops = boxes.map((box) => {
    const center = box.getCenter(new Vector3());
    return [center.x, box.max.y, center.z];
  });
  const incoming = tops.filter((p) => p[0] < 0).sort((a, b) => a[2] - b[2]);
  const outgoing = tops.filter((p) => p[0] > 0).sort((a, b) => a[2] - b[2]);
  if (incoming.length !== 4 || outgoing.length !== 4) throw new Error("Unexpected upper insulator arrangement");
  // Preserve all eight source insulators; three matching pairs carry phases A/B/C.
  const columns = [0, 1, 3];
  const attachments = {
    incoming: columns.map((i) => incoming[i]),
    outgoing: columns.map((i) => outgoing[i]),
  };
  const definition = {
    source: "POSTE 05.obj", height,
    finish: "Neutral gray matte shaft and paired gray crossarms; brown upper insulators",
    parts: root.children.map((part) => ({ name: part.name, sourcePart: part.userData.sourcePart })),
    insulatorTops: tops, attachments,
    phaseOffsets: attachments.incoming.map((p, i) => (p[2] + attachments.outgoing[i][2]) / 2),
    phaseHeights: attachments.incoming.map((p, i) => (p[1] + attachments.outgoing[i][1]) / 2),
  };
  root.userData = definition;
  root.updateMatrixWorld(true);
  return { root, definition };
}
