export const SUBSTATION_VIEW_EXTENT_METERS = 1000 * 0.3048;

// Use the larger ground dimension: a wide viewport must not expose symbols just
// because its shorter dimension fits within the limit. Global spans are not
// measured as a shortest-distance arc between coincident dateline endpoints.
export function groundViewExtent(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return Infinity;
  const [west, south, east, north] = bounds;
  if (east < west || north < south) return Infinity;
  const metersPerDegree = 6371008.8 * Math.PI / 180;
  return Math.max((east - west) * metersPerDegree * Math.cos((south + north) * Math.PI / 360),
    (north - south) * metersPerDegree);
}

export function withinSubstationViewExtent(extent) {
  return Number.isFinite(extent) && extent >= 0 && extent <= SUBSTATION_VIEW_EXTENT_METERS;
}
