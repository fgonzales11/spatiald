import feeds from "../../camera-feeds.json" with { type: "json" };
import tampa from "./tampa-cameras.json" with { type: "json" };

export const TAMPA_CAMERA_IDS = new Set(tampa.cameraIds.map(String));
export function officialSnapshotUrl(camera) {
  try {
    const url = new URL(camera.imageUrl);
    return url.origin === "https://fl511.com" && /^\d+$/.test(String(camera.imageId))
      && url.pathname === `/map/Cctv/${camera.imageId}` && !url.username && !url.password
      && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function cameraFeatures(records) {
  return {
    type: "FeatureCollection",
    features: records.flatMap((camera) => {
      if (camera.disabled || camera.blocked) return [];
      let videoAvailable = false;
      try { videoAvailable = !camera.videoDisabled && new URL(camera.videoUrl).protocol === "https:"; } catch {}
      const snapshotUrl = officialSnapshotUrl(camera);
      if (!videoAvailable) return [];
      const point = /^POINT\s*\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)$/i.exec(camera.coordinatesWkt || "");
      if (!point) return [];
      const coordinates = point.slice(1).map(Number);
      if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90)
        return [];
      return [{
        type: "Feature",
        id: String(camera.id),
        geometry: { type: "Point", coordinates },
        properties: { ...camera, id: String(camera.id), name: `${camera.roadway} · ${camera.location}`,
          videoAvailable, snapshotUrl },
      }];
    }),
  };
}

export const HIGHWAY_CAMERAS = cameraFeatures(feeds.filter((camera) => TAMPA_CAMERA_IDS.has(String(camera.id))));
export const HIGHWAY_CAMERA_BY_ID = new Map(HIGHWAY_CAMERAS.features.map((feature) => [feature.properties.id, feature]));
