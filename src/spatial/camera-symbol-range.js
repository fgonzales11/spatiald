import { groundViewExtent } from "./substation-symbol-range.js";

export const CAMERA_VIEW_EXTENT_METERS = 10000 * 0.3048;

export function withinCameraViewExtent(extent) {
  return Number.isFinite(extent) && extent >= 0 && extent <= CAMERA_VIEW_EXTENT_METERS;
}

export function visibleCameraIds(features, bounds) {
  if (!withinCameraViewExtent(groundViewExtent(bounds))) return [];
  const [west, south, east, north] = bounds;
  return features
    .filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates;
      return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
    })
    .map((feature) => String(feature.properties.id));
}
