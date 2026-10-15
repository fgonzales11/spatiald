export function initialMapView({ defaultMap = "3d", googleConfigured, nationalOverview }) {
  const preferredMode = ["2d", "tron"].includes(defaultMap) ? defaultMap : "3d";
  const showNationalOverview = Boolean(nationalOverview && ((!googleConfigured && preferredMode === "3d") || preferredMode === "2d"));
  return {
    mode: showNationalOverview ? "2d" : preferredMode,
    showNationalOverview,
  };
}
