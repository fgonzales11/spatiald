export const PV_SIZE_BINS = [
  { max: 5, label: '≤5 kW', color: '#ffffb2' },
  { max: 10, label: '>5–10 kW', color: '#fecc5c' },
  { max: 25, label: '>10–25 kW', color: '#fd8d3c' },
  { max: 100, label: '>25–100 kW', color: '#f03b20' },
  { max: Infinity, label: '>100 kW', color: '#bd0026' },
];
export const PV_UNKNOWN_COLOR = '#f6df50';
export function pvSizeColor(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return PV_UNKNOWN_COLOR;
  return PV_SIZE_BINS.find(bin => size <= bin.max).color;
}

const metresPerDegree = 111195.08;
function segmentDistance(point, a, b) {
  const sx = metresPerDegree * Math.cos(point[1] * Math.PI / 180), sy = metresPerDegree;
  const ax = (a[0] - point[0]) * sx, ay = (a[1] - point[1]) * sy;
  const bx = (b[0] - point[0]) * sx, by = (b[1] - point[1]) * sy;
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (segmentDistance(point, a, b) < 0.005) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function pointInFootprint(point, geometry) {
  if (geometry.type !== 'Polygon') throw new Error('Building footprints must be individual polygons');
  return inRing(point, geometry.coordinates[0]) && !geometry.coordinates.slice(1).some(ring => inRing(point, ring));
}
export function footprintDistance(point, geometry) {
  if (pointInFootprint(point, geometry)) return 0;
  let distance = Infinity;
  for (const ring of geometry.coordinates)
    for (let i = 1; i < ring.length; i++) distance = Math.min(distance, segmentDistance(point, ring[i - 1], ring[i]));
  return distance;
}

/** Tile building layers may group unrelated roofs in one MultiPolygon. Split
 * components before matching; never paint the other roofs in that feature. */
export function individualFootprints(feature, prefix) {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates]
    : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
  return polygons.map((coordinates, i) => ({ type: 'Feature', id: `${prefix}:${i}`,
    properties: {}, geometry: { type: 'Polygon', coordinates } }));
}

export function footprintArea(geometry) {
  const latitude = geometry.coordinates[0][0][1];
  const sx = metresPerDegree * Math.cos(latitude * Math.PI / 180), sy = metresPerDegree;
  const origin = geometry.coordinates[0][0];
  const area = ring => {
    let sum = 0;
    for(let i=1;i<ring.length;i++) {
      const a=ring[i-1],b=ring[i];
      sum += (a[0]-origin[0])*(b[1]-origin[1])-(b[0]-origin[0])*(a[1]-origin[1]);
    }
    return Math.abs(sum * sx * sy / 2);
  };
  return Math.max(0,area(geometry.coordinates[0])-geometry.coordinates.slice(1).reduce((sum,ring)=>sum+area(ring),0));
}

export function matchPvBuilding(site, candidates, { tieTolerance = 0.01 } = {}) {
  const point = [site.longitude, site.latitude];
  const ranked = candidates.map(footprint => ({ footprint, distance: footprintDistance(point, footprint.geometry) }))
    .sort((a,b) => a.distance - b.distance);
  if(!ranked.length) return null;
  const tied = ranked.filter(candidate => candidate.distance - ranked[0].distance <= tieTolerance)
    .sort((a,b) => footprintArea(b.footprint.geometry)-footprintArea(a.footprint.geometry) || String(a.footprint.id).localeCompare(String(b.footprint.id)));
  return { ...tied[0], method: tied[0].distance === 0 ? 'location inside building' : 'nearest building',
    tieResolvedByArea: tied.length > 1 };
}

export function buildingCapacity(sites) {
  const sizes = sites.map(site => site.system_size_kw).filter(size => typeof size === 'number' && Number.isFinite(size) && size >= 0);
  // Multiple permits can describe the same system. Do not double-count them.
  return sizes.length ? Math.max(...sizes) : null;
}
