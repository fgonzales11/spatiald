import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../../schemas/twin.schema.json" with { type: "json" };
import { ASSET_TYPES } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateShape = ajv.compile(schema);
export const isTimestamp = ajv.compile({ type: "string", format: "date-time" });

export function geometryPositions(geometry) {
  const found = [];
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number") found.push(value);
    else for (const child of value) visit(child);
  }
  visit(geometry?.coordinates);
  return found;
}

/** Independent line/ring paths; never join disconnected multipart geometry. */
export function geometryPaths(geometry) {
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    default:
      return [];
  }
}

export function geometryErrors(geometry) {
  const errors = [];
  const coordinate = (p) =>
    Array.isArray(p) &&
    p.length >= 2 &&
    p.length <= 3 &&
    p.every(Number.isFinite) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90;
  const line = (points, ring = false) =>
    Array.isArray(points) &&
    points.length >= (ring ? 4 : 2) &&
    points.every(coordinate) &&
    (!ring || JSON.stringify(points[0]) === JSON.stringify(points.at(-1)));
  const polygon = (rings) =>
    Array.isArray(rings) &&
    rings.length > 0 &&
    rings.every((ring) => line(ring, true));
  const c = geometry?.coordinates;
  const valid = {
    Point: () => coordinate(c),
    MultiPoint: () => Array.isArray(c) && c.length > 0 && c.every(coordinate),
    LineString: () => line(c),
    MultiLineString: () =>
      Array.isArray(c) && c.length > 0 && c.every((p) => line(p)),
    Polygon: () => polygon(c),
    MultiPolygon: () => Array.isArray(c) && c.length > 0 && c.every(polygon),
  }[geometry?.type];
  if (!valid?.())
    errors.push(
      "Invalid WGS84 geometry: use longitude/latitude, valid coordinate ranges, and closed polygon rings.",
    );
  return errors;
}

export function boundsOf(assets) {
  const points = assets.flatMap((a) => geometryPositions(a.geometry));
  if (!points.length) return [-82.48, 27.92, -82.43, 27.96];
  return points.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [180, 90, -180, -90],
  );
}

export function assetCenter(asset) {
  const b = boundsOf([asset]);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

export function validateBundle(bundle) {
  if (!validateShape(bundle))
    return {
      valid: false,
      errors: validateShape.errors.map(
        (e) => `${e.instancePath || "/"} ${e.message}`,
      ),
    };
  const errors = [];
  const maps = {};
  for (const key of [
    "sources",
    "datasets",
    "networks",
    "assets",
    "nodes",
    "terminals",
    "series",
    "events",
  ]) {
    maps[key] = new Map();
    for (const item of bundle[key]) {
      if (maps[key].has(item.id))
        errors.push(`${key}: duplicate identity ${item.id}`);
      maps[key].set(item.id, item);
    }
  }
  const unique = (records, key, label) => {
    const seen = new Set();
    for (const record of records) {
      const id = key(record);
      if (seen.has(id)) errors.push(`${label}: duplicate identity ${id}`);
      seen.add(id);
    }
  };
  unique(
    bundle.assets,
    (a) => `${a.datasetId}|${a.externalId}`,
    "Asset external ID",
  );
  unique(
    bundle.networkMemberships,
    (a) => `${a.networkId}|${a.assetId}`,
    "Network membership",
  );
  unique(
    bundle.eventAssets,
    (a) => `${a.eventId}|${a.assetId}`,
    "Event association",
  );
  unique(
    bundle.observations,
    (a) => `${a.seriesId}|${Date.parse(a.observedAt)}`,
    "Observation",
  );
  const ref = (table, id, label) => {
    if (!maps[table].has(id))
      errors.push(`${label}: unresolved ${table} reference ${id}`);
    return maps[table].get(id);
  };
  const workspace = (record, label) => {
    if (record.workspaceId !== bundle.workspace.id)
      errors.push(`${label}: belongs to another workspace`);
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: bundle.workspace.timezone });
  } catch {
    errors.push("Workspace timezone is invalid");
  }
  errors.push(
    ...geometryErrors(bundle.workspace.serviceArea).map(
      (e) => `Service area: ${e}`,
    ),
  );
  for (const d of bundle.datasets) {
    workspace(d, d.id);
    ref("sources", d.sourceId, d.id);
    if (
      d.bounds[0] > d.bounds[2] ||
      d.bounds[1] > d.bounds[3] ||
      Math.abs(d.bounds[0]) > 180 ||
      Math.abs(d.bounds[2]) > 180 ||
      Math.abs(d.bounds[1]) > 90 ||
      Math.abs(d.bounds[3]) > 90
    )
      errors.push(`${d.id}: invalid dataset bounds`);
  }
  for (const n of bundle.networks) workspace(n, n.id);
  for (const a of bundle.assets) {
    workspace(a, a.id);
    ref("datasets", a.datasetId, a.id);
    if (!ASSET_TYPES[a.utilityType]?.includes(a.assetType))
      errors.push(
        `${a.id}: invalid ${a.utilityType} asset type ${a.assetType}`,
      );
    errors.push(...geometryErrors(a.geometry).map((e) => `${a.id}: ${e}`));
    for (const key of [
      "nominalVoltageV",
      "ratingKva",
      "diameterMm",
      "pressureKpa",
    ]) {
      if (
        a.attributes[key] !== undefined &&
        (!Number.isFinite(a.attributes[key]) || a.attributes[key] < 0)
      )
        errors.push(`${a.id}: invalid ${key}`);
    }
    if (
      a.attributes.switchPosition !== undefined &&
      !["open", "closed", "unknown"].includes(a.attributes.switchPosition)
    )
      errors.push(`${a.id}: invalid switch position`);
    if (
      a.attributes.phases !== undefined &&
      (!Array.isArray(a.attributes.phases) ||
        a.attributes.phases.some((p) => !["A", "B", "C", "N"].includes(p)))
    )
      errors.push(`${a.id}: invalid phases`);
  }
  for (const n of bundle.nodes) {
    workspace(n, n.id);
    ref("datasets", n.datasetId, n.id);
    errors.push(...geometryErrors(n.geometry).map((e) => `${n.id}: ${e}`));
    if (n.geometry.type !== "Point")
      errors.push(`${n.id}: connectivity node must be a Point`);
  }
  for (const t of bundle.terminals) {
    const a = ref("assets", t.assetId, t.id);
    const n = t.nodeId ? ref("nodes", t.nodeId, t.id) : null;
    if (a && n && a.utilityType !== n.utilityType)
      errors.push(`${t.id}: terminal and node utility types differ`);
    if (a?.utilityType !== "electric" && t.phases?.length)
      errors.push(`${t.id}: phases apply only to electric assets`);
    if (
      a?.attributes.phases &&
      t.phases?.some((p) => !a.attributes.phases.includes(p))
    )
      errors.push(`${t.id}: terminal phase is absent from asset`);
  }
  for (const m of bundle.networkMemberships) {
    const a = ref("assets", m.assetId, "Membership");
    const n = ref("networks", m.networkId, "Membership");
    if (a && n && a.utilityType !== n.utilityType)
      errors.push(`Membership ${m.assetId}: utility types differ`);
  }
  for (const s of bundle.series) {
    const a = ref("assets", s.assetId, s.id);
    ref("datasets", s.datasetId, s.id);
    if (s.terminalId) {
      const t = ref("terminals", s.terminalId, s.id);
      if (t && t.assetId !== s.assetId)
        errors.push(`${s.id}: terminal belongs to another asset`);
    }
    if (a?.utilityType !== "electric" && s.phase)
      errors.push(`${s.id}: phases apply only to electric measurements`);
  }
  for (const o of bundle.observations) {
    ref("series", o.seriesId, "Observation");
    ref("datasets", o.datasetId, "Observation");
    if (o.value === null && o.quality !== "missing")
      errors.push(`${o.seriesId}: null values require missing quality`);
  }
  for (const e of bundle.events) {
    workspace(e, e.id);
    ref("datasets", e.datasetId, e.id);
    if (e.endedAt && Date.parse(e.endedAt) < Date.parse(e.startedAt))
      errors.push(`${e.id}: end precedes start`);
  }
  for (const e of bundle.eventAssets) {
    ref("events", e.eventId, "Event association");
    ref("assets", e.assetId, "Event association");
  }
  return { valid: errors.length === 0, errors };
}

export function assertBundle(bundle) {
  const result = validateBundle(bundle);
  if (!result.valid) throw new Error(result.errors.slice(0, 12).join("\n"));
  return bundle;
}

export function connectedAssets(bundle, assetId) {
  const nodes = new Set(
    bundle.terminals
      .filter((t) => t.assetId === assetId && t.nodeId)
      .map((t) => t.nodeId),
  );
  const ids = new Set(
    bundle.terminals
      .filter((t) => t.assetId !== assetId && nodes.has(t.nodeId))
      .map((t) => t.assetId),
  );
  return bundle.assets.filter((a) => ids.has(a.id));
}

export function assetNetworks(bundle, assetId) {
  const ids = new Set(
    bundle.networkMemberships
      .filter((m) => m.assetId === assetId)
      .map((m) => m.networkId),
  );
  return bundle.networks.filter((n) => ids.has(n.id));
}

export function assetEvents(bundle, assetId) {
  const ids = new Set(
    bundle.eventAssets
      .filter((e) => e.assetId === assetId)
      .map((e) => e.eventId),
  );
  return bundle.events.filter((e) => ids.has(e.id));
}
