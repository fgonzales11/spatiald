import { PublicLayerProvider, PUBLIC_LAYERS, mergePublicLayers, AreaTooLargeError } from '../data/public-layers.js';

/** A separate study collection: complete detail records, independent of visible layers/tiles. */
export async function collectStudyAssets(bundle, bounds, { signal, onProgress = () => {} } = {}) {
  const provider = new PublicLayerProvider(undefined, { maxFeatures: 4000 });
  const results = [];
  for (const layer of PUBLIC_LAYERS) {
    const parts = [];
    async function collect(area, depth = 0) {
      signal?.throwIfAborted();
      try {
        const result = await provider.loadLayer(layer, area, { signal, onProgress: (count, total) => onProgress(`${layer.name}: ${count} / ${total}`) });
        if (result.rejected.length) throw new Error(`${layer.name}: ${result.rejected.length} source records have invalid geometry. This collection cannot certify complete coverage.`);
        parts.push(result);
      } catch (error) {
        if (!(error instanceof AreaTooLargeError) || depth >= 12) throw error;
        const [w,s,e,n] = area;
        const a = e-w >= n-s ? [w,s,(w+e)/2,n] : [w,s,e,(s+n)/2];
        const b = e-w >= n-s ? [(w+e)/2,s,e,n] : [w,(s+n)/2,e,n];
        await collect(a, depth+1); await collect(b, depth+1);
      }
    }
    await collect(bounds);
    const assets = [...new Map(parts.flatMap(p => p.assets).map(a => [a.id, a])).values()];
    if (assets.length > 100000) throw new Error('The study inventory exceeds 100,000 features. Narrow the study boundary.');
    results.push({ ...parts[0], assets, total: assets.length, rejected: [], dataset: { ...parts[0].dataset, queryBounds: bounds, bounds } });
    onProgress(`${layer.name}: ${assets.length} complete detailed records`);
  }
  // Imported records remain in the snapshot; map filters never alter the analytical inventory.
  return mergePublicLayers(bundle, results);
}
