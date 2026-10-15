import { geometryPaths, geometryPositions } from "../domain/model.js";

export const ROUTE_SAMPLE_SPACING_METERS = 30.48;
export const MINIMUM_TURN_DEGREES = 0.001; // Ignore numerical noise on straight spans.
const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const CELL = 0.001;

export function distanceMeters(a, b) {
  const dLat = (b[1] - a[1]) * RAD,
    dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return (
    2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  );
}

export function offsetMeters(point, east, north) {
  const result = [
    point[0] + east / (EARTH_RADIUS * RAD * Math.cos(point[1] * RAD)),
    point[1] + north / (EARTH_RADIUS * RAD),
  ];
  if (point[2] !== undefined) result.push(point[2]);
  return result;
}

export function routeDirection(a, b) {
  const east = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD),
    north = b[1] - a[1];
  const length = Math.hypot(east, north);
  return length ? [east / length, north / length] : [1, 0];
}

/** Sampling restarts for each independent path; repeated vertices never add distance. */
export function* sampleRoute(path, spacing = ROUTE_SAMPLE_SPACING_METERS) {
  if (!(spacing > 0)) throw new Error("Pole spacing must be positive.");
  let accumulated = 0,
    next = 0;
  for (let segment = 1; segment < path.length; segment++) {
    const a = path[segment - 1],
      b = path[segment],
      length = distanceMeters(a, b);
    if (length < 0.001) continue;
    const direction = routeDirection(a, b);
    while (next <= accumulated + length + 1e-7) {
      const t = Math.min(1, Math.max(0, (next - accumulated) / length));
      const coordinates = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (a[2] !== undefined && b[2] !== undefined)
        coordinates.push(a[2] + (b[2] - a[2]) * t);
      yield { coordinates, direction, chainage: next };
      next += spacing;
    }
    accumulated += length;
  }
}

/** Every interior bend, independently for each path; ignore repeated vertices. */
export function* routeTurns(path) {
  const vertices = path.filter(
    (point, i) => !i || distanceMeters(point, path[i - 1]) >= 0.001,
  );
  let chainage = 0;
  for (let i = 1; i < vertices.length - 1; i++) {
    const a = vertices[i - 1], b = vertices[i], c = vertices[i + 1];
    chainage += distanceMeters(a, b);
    const incoming = routeDirection(a, b), outgoing = routeDirection(b, c);
    const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
    const turnDegrees = Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
    if (turnDegrees < MINIMUM_TURN_DEGREES) continue;
    const east = incoming[0] + outgoing[0], north = incoming[1] + outgoing[1];
    const length = Math.hypot(east, north);
    yield {
      coordinates: b,
      direction: length > 0.000001 ? [east / length, north / length] : incoming,
      chainage,
      turnDegrees,
    };
  }
}

function bounds(geometry) {
  return geometryPositions(geometry).reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [180, 90, -180, -90],
  );
}
const contains = (b, p) =>
  p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const intersects = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const metersPerDegree = EARTH_RADIUS * RAD;

function segmentDistance(point, a, b) {
  const scale = metersPerDegree * Math.cos(point[1] * RAD);
  const ax = (a[0] - point[0]) * scale,
    ay = (a[1] - point[1]) * metersPerDegree;
  const bx = (b[0] - point[0]) * scale,
    by = (b[1] - point[1]) * metersPerDegree;
  const dx = bx - ax,
    dy = by - ay,
    denominator = dx * dx + dy * dy;
  const t = denominator
    ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / denominator))
    : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (segmentDistance(point, a, b) < 0.02) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
export function insidePolygon(point, geometry) {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.some(
    (rings) =>
      insideRing(point, rings[0]) &&
      !rings.slice(1).some((hole) => insideRing(point, hole)),
  );
}
function nearGeometry(point, geometry, radius) {
  if (insidePolygon(point, geometry)) return true;
  if (geometry.type === "Point")
    return distanceMeters(point, geometry.coordinates) <= radius;
  return geometryPaths(geometry).some((path) =>
    path.slice(1).some((b, i) => segmentDistance(point, path[i], b) <= radius),
  );
}
const numericWidth = (value) => {
  const match = String(value || "").match(
    /^(\d+(?:\.\d+)?)\s*(m|ft|feet|')?$/i,
  );
  return match
    ? Number(match[1]) * (/ft|feet|'/.test(match[2] || "") ? 0.3048 : 1)
    : null;
};

function roadClearance(tags) {
  const defaults = {
    motorway: 18,
    trunk: 14,
    primary: 12,
    secondary: 10,
    tertiary: 8,
    residential: 7,
    service: 5,
    footway: 2,
    path: 2,
    cycleway: 3,
    pedestrian: 5,
  };
  const width =
    numericWidth(tags.width) ||
    (Number(tags.lanes) > 0
      ? Number(tags.lanes) * 3.4
      : defaults[tags.highway] || 6);
  return width / 2 + 2;
}

/** Broad-phase grid followed by exact polygon/segment tests in meters. */
export class PolePlacementIndex {
  constructor({ manifest, collections }) {
    this.coverage = manifest.files.map((file) => file.bounds).filter(Boolean);
    this.bounds = manifest.bounds;
    this.grid = new Map();
    for (const category of ["landcover", "roads", "water", "buildings"]) {
      if (!collections[category])
        throw new Error(`Pole screening requires local OSM ${category} data.`);
      for (const feature of collections[category].features) {
        const tags = feature.properties.tags || {};
        const restricted =
          category === "landcover" &&
          (/^(pitch|playground|golf_course)$/.test(tags.leisure || "") ||
            /^(cemetery|railway)$/.test(tags.landuse || ""));
        const clearance =
          category === "roads"
            ? roadClearance(tags)
            : category === "buildings"
              ? 2
              : category === "water"
                ? Math.max(
                    4,
                    (numericWidth(tags.width) ||
                      (tags.waterway === "canal" ? 10 : 2)) /
                      2 +
                      3,
                  )
                : 0;
        const b = bounds(feature.geometry),
          margin = clearance / 80000;
        const expanded = [
          b[0] - margin,
          b[1] - margin,
          b[2] + margin,
          b[3] + margin,
        ];
        // Local exports can contain complete ways extending beyond their download.
        // Index only cells within the coverage envelope, where placement is permitted.
        const clipped = [
          Math.max(expanded[0], this.bounds[0]),
          Math.max(expanded[1], this.bounds[1]),
          Math.min(expanded[2], this.bounds[2]),
          Math.min(expanded[3], this.bounds[3]),
        ];
        const entry = {
          feature,
          category,
          clearance,
          restricted,
          bounds: expanded,
        };
        for (
          let x = Math.floor(clipped[0] / CELL);
          x <= Math.floor(clipped[2] / CELL);
          x++
        )
          for (
            let y = Math.floor(clipped[1] / CELL);
            y <= Math.floor(clipped[3] / CELL);
            y++
          ) {
            const key = `${x}:${y}`;
            if (!this.grid.has(key)) this.grid.set(key, []);
            this.grid.get(key).push(entry);
          }
      }
    }
  }
  classify(point) {
    if (
      !this.coverage.some(
        (b) =>
          contains(b, offsetMeters(point, -2, -2)) &&
          contains(b, offsetMeters(point, 2, 2)),
      )
    )
      return "unknown_coverage";
    const entries = (
      this.grid.get(
        `${Math.floor(point[0] / CELL)}:${Math.floor(point[1] / CELL)}`,
      ) || []
    ).filter((entry) => contains(entry.bounds, point));
    for (const category of ["water", "buildings", "roads"])
      if (
        entries.some(
          (entry) =>
            entry.category === category &&
            nearGeometry(point, entry.feature.geometry, entry.clearance),
        )
      )
        return category;
    if (
      entries.some(
        (entry) =>
          entry.restricted && insidePolygon(point, entry.feature.geometry),
      )
    )
      return "restricted_land";
    if (
      !entries.some(
        (entry) =>
          entry.category === "landcover" &&
          !entry.restricted &&
          insidePolygon(point, entry.feature.geometry),
      )
    )
      return "unknown_land";
    return "valid";
  }
  intersectsPath(path) {
    return intersects(
      bounds({ type: "LineString", coordinates: path }),
      this.bounds,
    );
  }
}

/** Exact illustrative bend supports by default; an optional index requests screened placement. */
export function planTransmissionPoles(assets, index) {
  const placements = [],
    byAsset = new Map(),
    statistics = { accepted: 0, skipped: 0, reasons: {} };
  const occupied = new Map();
  for (const asset of assets.filter(
    (asset) => asset.assetType === "transmission_line",
  )) {
    let pathIndex = 0;
    for (const path of geometryPaths(asset.geometry)) {
      if (index && !index.intersectsPath(path)) {
        pathIndex++;
        continue;
      }
      for (const anchor of routeTurns(path)) {
        let coordinates = index ? undefined : anchor.coordinates.slice(), reason;
        // Try the route first, then modest roadside offsets; never bridge a
        // missing coverage area or put a support inside a mapped obstruction.
        for (const lateral of index ? [0, 6, -6, 10, -10, 16, -16, 22, -22] : []) {
          const candidate = offsetMeters(
            anchor.coordinates,
            anchor.direction[1] * lateral,
            -anchor.direction[0] * lateral,
          );
          const status = index.classify(candidate);
          reason ||= status;
          if (status === "valid") {
            coordinates = candidate;
            break;
          }
        }
        if (!coordinates) {
          statistics.skipped++;
          statistics.reasons[reason] = (statistics.reasons[reason] || 0) + 1;
          continue;
        }
        const key = `${Math.round(coordinates[0] * 100000)}:${Math.round(coordinates[1] * 100000)}`;
        const previous = occupied.get(key);
        if (previous) {
          if (!previous.assetIds.includes(asset.id))
            previous.assetIds.push(asset.id);
          if (!byAsset.has(asset.id)) byAsset.set(asset.id, []);
          byAsset.get(asset.id).push({
            ...anchor,
            coordinates: previous.coordinates,
            direction: previous.direction,
            routeCoordinates: anchor.coordinates,
            assetId: asset.id,
            assetIds: previous.assetIds,
            pathIndex,
          });
          continue;
        }
        const placement = {
          ...anchor,
          coordinates,
          routeCoordinates: anchor.coordinates,
          assetId: asset.id,
          assetIds: [asset.id],
          pathIndex,
        };
        placements.push(placement);
        occupied.set(key, placement);
        if (!byAsset.has(asset.id)) byAsset.set(asset.id, []);
        byAsset.get(asset.id).push(placement);
      }
      pathIndex++;
    }
  }
  statistics.accepted = placements.length;
  return { placements, byAsset, statistics };
}
