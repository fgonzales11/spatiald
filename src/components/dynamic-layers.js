import { esc, icon } from './ui.js';
import { BUILTIN_BASEMAPS } from '../data/dynamic-layers.js';

export function renderDynamicLayers(s) {
  const catalog = s.mapCatalog;
  const basemaps = [...BUILTIN_BASEMAPS, ...catalog.basemaps];
  const selected = basemaps.find(b => b.id === catalog.basemapId);
  return `<section class="custom-map-section"><h3>Basemap</h3><label class="basemap-label" for="basemap-selector">Map background</label><select id="basemap-selector" ${s.mapSourceBusy ? 'disabled' : ''}>${basemaps.map(b => `<option value="${esc(b.id)}" ${b.id === catalog.basemapId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    ${s.mapMode === '3d' ? '<p class="layer-foot">Selecting a basemap opens the 2D map.</p>' : ''}
    ${s.basemapError ? `<p class="map-source-error" role="alert">${esc(s.basemapError)} <button class="text-button" data-action="retry-basemap">Retry</button></p>` : ''}
    ${catalog.basemaps.some(b => b.id === selected?.id) ? `<button class="text-button" data-remove-basemap="${esc(selected.id)}" ${s.mapSourceBusy ? 'disabled' : ''}>Remove selected basemap</button>` : ''}
  </section><section class="custom-map-section"><h3>Saved layers</h3><p class="layer-foot">Custom overlays display in 2D. Sources and GeoJSON snapshots are saved in this browser.</p>
    ${catalog.layers.length ? catalog.layers.map(layer => `<div class="saved-map-layer" data-saved-layer="${esc(layer.id)}"><label><input type="checkbox" data-dynamic-layer="${esc(layer.id)}" ${layer.visible ? 'checked' : ''} ${s.mapSourceBusy ? 'disabled' : ''}><i class="layer-swatch" style="--layer-color:${esc(layer.color)}"></i><span>${esc(layer.name)}</span></label><small>${layer.type === 'raster' ? 'Raster tiles' : `${layer.data.features.length.toLocaleString()} features`}</small><div class="saved-layer-actions">${layer.bounds ? `<button class="text-button" data-focus-dynamic="${esc(layer.id)}">View</button>` : ''}${layer.type === 'geojson' && layer.url ? `<button class="text-button" data-refresh-dynamic="${esc(layer.id)}" ${s.mapSourceBusy ? 'disabled' : ''}>Refresh</button>` : ''}<button class="text-button" data-remove-dynamic="${esc(layer.id)}" ${s.mapSourceBusy ? 'disabled' : ''}>Remove</button></div>${s.dynamicLayerErrors[layer.id] ? `<p class="map-source-error" role="alert">${esc(s.dynamicLayerErrors[layer.id])}</p>` : ''}</div>`).join('') : '<p class="small muted">No custom layers yet.</p>'}
    <div class="map-source-buttons"><button class="secondary" data-action="add-layer">${icon('layers')} Add layer</button><button class="secondary" data-action="add-basemap">${icon('globe')} Add basemap</button></div>
  </section>`;
}

export function sourceDialog() {
  return `<dialog id="map-source-dialog" aria-labelledby="map-source-title"><form id="map-source-form"><div class="map-source-title"><h2 id="map-source-title">Add layer</h2><button type="button" class="icon-button" data-action="cancel-map-source" aria-label="Close source form">${icon('close')}</button></div><p class="small muted">Save map sources in this browser and show them in 2D.</p>
  <label for="map-source-name">Name</label><input id="map-source-name" name="name" required maxlength="100" placeholder="e.g. Service boundaries">
  <label for="map-source-type">Source type</label><select id="map-source-type" name="type"></select>
  <div id="map-source-url-field"><label for="map-source-url">Source URL</label><input id="map-source-url" name="url" type="text" placeholder="https://example.com/layer.geojson"><p id="map-source-hint" class="small muted">A GeoJSON FeatureCollection in WGS84. Remote sources must allow browser access (CORS).</p></div>
  <div id="map-source-file-field" hidden><label for="map-source-file">GeoJSON file</label><input id="map-source-file" type="file" accept=".geojson,.json,application/geo+json,application/json"><p class="small muted">WGS84 longitude and latitude. Maximum 20 MB.</p></div>
  <div id="map-source-color-field"><label for="map-source-color">Layer color</label><input id="map-source-color" name="color" type="color" value="#50c9de"></div>
  <div id="map-source-attribution-field"><label for="map-source-attribution">Attribution (optional)</label><input id="map-source-attribution" name="attribution" maxlength="500" placeholder="Data provider or license credit"></div>
  <p id="map-source-form-error" class="map-source-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="secondary" data-action="cancel-map-source">Cancel</button><button id="map-source-save" type="submit" class="primary">Add and save</button></div></form></dialog>`;
}
