export const NATIONAL_TRANSMISSION_VERSION = 1;
export const NATIONAL_TRANSMISSION_VIEWS = {
  country: { name: "United States", bounds: [-125, 24, -66, 50] },
  alaska: { name: "Alaska", bounds: [-170, 51, -129, 72] },
  hawaii: { name: "Hawaii", bounds: [-161, 18, -154, 23] },
  territories: { name: "Puerto Rico", bounds: [-67.4, 17.8, -65.1, 18.7] },
  guam: { name: "Guam", bounds: [144.5, 13.2, 145, 13.75] },
};
export async function loadNationalTransmission(baseUrl) {
  const root = new URL(`${baseUrl}data/us-transmission/`, location.href);
  const response = await fetch(new URL("manifest.json", root), { cache: "no-cache" });
  if (!response.ok) throw new Error(`Nationwide transmission tiles unavailable (${response.status}).`);
  const manifest = await response.json();
  if (manifest.version !== NATIONAL_TRANSMISSION_VERSION || !Number.isInteger(manifest.featureCount)
    || !Number.isInteger(manifest.maxZoom) || !manifest.tiles || !manifest.tileTemplate)
    throw new Error("Invalid nationwide transmission manifest.");
  return { ...manifest, tileUrl: `${new URL(manifest.tileTemplate, root).href.replaceAll("%7B", "{").replaceAll("%7D", "}")}?v=${encodeURIComponent(manifest.fetchedAt || manifest.version)}`,
    populatedTiles: new Set(Object.entries(manifest.tiles).flatMap(([z, entries]) => entries.map((xy) => `${z}/${xy}`))) };
}
