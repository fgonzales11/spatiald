export const ENVIRONMENT_SETTINGS = Object.freeze({
  qualityPreset: "low",
  cloudCoverage: 0.2,
  cloudResolutionScale: 0.5,
  exposure: 10,
  // Illustrative Tampa daylight, independent of utility source dates and the device clock.
  date: "2026-09-19T20:00:00Z",
});

export function environmentPreferences(value) {
  return {
    cloudsEnabled: value?.cloudsEnabled !== false,
    cloudCoverage: Number.isFinite(value?.cloudCoverage)
      ? Math.max(0, Math.min(1, value.cloudCoverage))
      : ENVIRONMENT_SETTINGS.cloudCoverage,
  };
}
