import poleDefinition from '../assets/transmission-pole.json' with { type: 'json' };
import { geometryPaths } from '../domain/model.js';

// Display defaults, not surveyed conductor heights or engineering clearances.
// Transmission matches the existing 24 m illustrative support model.
export const LINE_DISPLAY_HEIGHTS = Object.freeze({
  transmission_line: poleDefinition.height,
  overhead_line: 14,
});

function relativeHeight(asset) {
  const fallback = LINE_DISPLAY_HEIGHTS[asset?.assetType];
  if (fallback === undefined) return null;
  const attributes = asset.attributes || {};
  const construction = String(attributes.construction || attributes.sourceAttributes?.TYPE || '');
  if (/underground|buried|submarine|submerged|subsea|u\/g/i.test(construction)) return null;
  for (const key of ['heightAboveGroundM', 'conductorHeightM']) {
    const value = attributes[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      return { height: value, estimated: false };
  }
  return { height: fallback, estimated: true };
}

/** Resolve one independent path without editing the original source geometry.
 * Partial coordinate elevations cannot be mixed with above-ground offsets in
 * a single Google polyline, so incomplete overhead paths use the display rule.
 */
export function lineDisplayOptions(asset, path) {
  if (path.length && path.every(point => Number.isFinite(point[2]))) {
    return { altitudeMode: 'ABSOLUTE', path: path.map(([lng, lat, altitude]) => ({ lng, lat, altitude })) };
  }
  const relative = relativeHeight(asset);
  return {
    altitudeMode: relative ? 'RELATIVE_TO_GROUND' : 'CLAMP_TO_GROUND',
    path: path.map(([lng, lat]) => ({ lng, lat, altitude: relative?.height ?? 0 })),
  };
}

export function lineHeightNote(asset) {
  if (LINE_DISPLAY_HEIGHTS[asset?.assetType] === undefined) return '';
  const paths = geometryPaths(asset.geometry);
  if (!paths.length) return '';
  if (paths.every(path => path.every(point => Number.isFinite(point[2]))))
    return 'Using supplied coordinate elevations.';
  const relative = relativeHeight(asset);
  if (!relative) return 'Underground route shown at ground level for inspection; burial depth is not supplied.';
  return relative.estimated
    ? `${relative.height} m above ground · display estimate for paths without complete elevations. Actual conductor heights and sag are not supplied.`
    : `${relative.height} m above ground · supplied height for paths without coordinate elevations.`;
}
