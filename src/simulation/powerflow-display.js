const finite = value => typeof value === 'number' && Number.isFinite(value);
export const busNumber = id => String(id ?? '').match(/\/bus\/([^/]+)$/)?.[1] ?? null;
export const lineConductorOffsets = (line, fallbackPhases = '') => {
  const phases = String(line?.phases || fallbackPhases).split(/[,/\s·-]+/).filter(phase => /^[ABC]$/i.test(phase));
  return phases.length >= 2 ? [-1.5, 1.5] : [0];
};

export function networkBusLocations(lines = []) {
  const buses = new Map();
  for (const line of lines) {
    if (!line.points?.length) continue;
    for (const [id, point] of [[line.fromBus, line.points[0]], [line.toBus, line.points.at(-1)]]) {
      if (!id || !point?.every(Number.isFinite)) continue;
      const key = `${line.circuit}:${id}`;
      if (!buses.has(key)) buses.set(key, { kind: 'bus', id, circuit: line.circuit, x: point[0], z: point[1], overhead: false, underground: false });
      const bus = buses.get(key);
      bus.overhead ||= line.overhead === true;
      bus.underground ||= line.overhead === false;
    }
  }
  return [...buses.values()];
}

export function indexPowerFlow(state) {
  if (state?.status !== 'success' || state.result?.solved !== true || state.circuit?.id == null) return null;
  const group = rows => {
    const map = new Map();
    for (const row of rows || []) {
      if (row.index == null) continue;
      const id = String(row.index);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(row);
    }
    return map;
  };
  return { circuit: String(state.circuit.id), completedAt: state.completedAt,
    buses: group(state.result.tables?.res_bus), lines: group(state.result.tables?.res_line) };
}

export function assetResults(index, asset) {
  if (!index || String(asset.circuit) !== index.circuit) return [];
  if (asset.kind === 'bus') return index.buses.get(busNumber(asset.id)) || [];
  const prefix = `L-${index.circuit}-`;
  if (asset.kind === 'line' && String(asset.id).startsWith(prefix)) return index.lines.get(String(asset.id).slice(prefix.length)) || [];
  return [];
}

export function totalResult(rows, column) {
  return rows.length && rows.every(row => finite(row[column])) ? rows.reduce((sum, row) => sum + row[column], 0) : null;
}

export function maxResult(rows, column) {
  const values = rows.map(row => row[column]).filter(finite);
  return values.length ? Math.max(...values) : null;
}

// Follow the center conductor's actual span geometry, including its rendered
// sag. Underground particles stay at the buried-line display elevation.
// One particle per FLOW_SPACING meters of line, at most FLOW_MAX_PER_LINE per line, and none on stubs shorter than
// FLOW_MIN_LINE meters (their neighbours already show the direction).
const FLOW_SPACING = 120, FLOW_MAX_PER_LINE = 4, FLOW_MIN_LINE = 20;
export function flowPaths(lines, index, scale = 1) {
  if (!index) return [];
  const paths = [];
  for (const line of lines) {
    const rows = assetResults(index, { ...line, kind: 'line' });
    const watts = totalResult(rows, 'p_from_mw');
    const current = maxResult(rows, 'i_ka') ?? maxResult(rows, 'i_from_ka');
    if (!finite(watts) || Math.abs(watts) < 1e-9 || !(current > 1e-9)) continue;
    const points = [];
    for (let i = 1; i < (line.points?.length || 0); i++) {
      const [ax, az] = line.points[i - 1], [bx, bz] = line.points[i];
      if (![ax, az, bx, bz].every(finite)) continue;
      const length = Math.hypot(bx - ax, bz - az);
      if (length < 0.001) continue;
      const spans = line.overhead === true ? Math.max(1, Math.ceil(length / (55 * scale))) : 1;
      const steps = line.overhead === true ? spans * 5 : 1;
      for (let j = 0; j <= steps; j++) {
        const t = j / steps, spanT = (j % 5) / 5;
        const sag = Math.min(1.8 * scale, length / spans * 0.06);
        const y = line.overhead === true ? 10.5 * scale - 4 * sag * spanT * (1 - spanT) : 0.14 * scale;
        points.push([ax + (bx - ax) * t, y, az + (bz - az) * t]);
      }
    }
    const distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances.at(-1) + Math.hypot(...points[i].map((n, j) => n - points[i - 1][j])));
    const length = distances.at(-1);
    if (!(length > 0) || length < FLOW_MIN_LINE * scale) continue;
    paths.push({ id: line.id, points, distances, length, direction: Math.sign(watts), current,
      count: Math.min(FLOW_MAX_PER_LINE, Math.max(1, Math.round(length / (FLOW_SPACING * scale)))) });
  }
  return paths;
}

export function sampleFlowPath(path, distance, target, offset = 0) {
  const d = ((distance % path.length) + path.length) % path.length;
  let lo = 1, hi = path.distances.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (path.distances[mid] < d) lo = mid + 1; else hi = mid; }
  const a = path.points[lo - 1], b = path.points[lo], span = path.distances[lo] - path.distances[lo - 1];
  const t = span ? (d - path.distances[lo - 1]) / span : 0;
  for (let i = 0; i < 3; i++) target[offset + i] = a[i] + (b[i] - a[i]) * t;
  return target;
}
