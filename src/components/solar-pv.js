import { esc, icon } from './ui.js';
import { PV_SIZE_BINS, PV_UNKNOWN_COLOR } from '../spatial/pv-buildings.js';
import { PUBLIC_WORKSPACE_ID } from '../data/public-layers.js';

export function renderSolarPvLayers(state) {
  if(state.mapMode !== '2d' || state.bundle.workspace.id !== PUBLIC_WORKSPACE_ID) return '';
  const status = state.solarPvStatus, summary = status?.summary;
  const open = state.solarPvOpen || status?.status === 'error';
  return `<section class="context-layer-list solar-pv-controls" aria-label="Solar PV layer">
    <div class="pv-layer-heading"><label><input type="checkbox" data-solar-pv ${state.solarPvVisible !== false ? 'checked' : ''}><i class="layer-swatch" style="--layer-color:${PV_UNKNOWN_COLOR}"></i><span>PV system size</span><small>${summary ? summary.totalSites.toLocaleString() : ''}</small></label><button class="text-button pv-legend-toggle" data-action="toggle-solar-pv" aria-label="PV legend and details" aria-expanded="${Boolean(open)}" aria-controls="pv-layer-details">${icon('chevron')}</button></div>
    <div id="pv-layer-details" ${open ? '' : 'hidden'}>
    <div class="pv-size-legend" aria-label="PV capacity legend">${PV_SIZE_BINS.map(bin => `<span><i style="background:${bin.color}"></i>${esc(bin.label)}</span>`).join('')}<span><i style="background:${PV_UNKNOWN_COLOR}"></i>Size unreported</span></div>
    <p class="layer-foot solar-pv-status" aria-live="polite">${status?.status === 'error' ? esc(status.error) : summary ? `${summary.sitesWithSize.toLocaleString()} sized sites · ${summary.sitesWithoutSize.toLocaleString()} sizes unreported.<br>${summary.buildingCount.toLocaleString()} nearest buildings from the local OSM layer.<br>Only solar sites within the OSM layer's coverage are included. Zoom in to see colored roofs.` : 'Loading public solar sites…'}</p>
    ${summary ? '<button class="text-button" data-action="view-solar-pv">View PV sites</button>' : ''}
    ${status?.status === 'error' ? '<button class="text-button" data-action="retry-solar-pv">Retry solar layer</button>' : ''}
    <a class="text-button pv-source-link" href="https://panelcensus.com/sites?operator=Tampa%20Electric%20Co" target="_blank" rel="noopener noreferrer">PanelCensus · TECO</a>
    </div>
  </section>`;
}

export function createSolarPvPopup(feature, sites, { onZoom }) {
  const element = document.createElement('section');
  element.className = 'solar-pv-popup';
  const properties = feature.properties;
  const records = properties.site_ids.map(id => sites.get(id)).filter(Boolean);
  element.innerHTML = `<h3>Solar PV building</h3>
    <p class="pv-match-note">${properties.match_method === 'nearest building'
      ? `Nearest OSM building · ${records.length > 1 ? 'up to ' : ''}${Number(properties.match_distance_m).toFixed(1)} m from the published ${records.length > 1 ? 'locations' : 'location'}.`
      : 'Published location falls inside this OSM building.'}</p>
    ${properties.tie_resolved_by_area ? '<p class="pv-match-note">Equal distances: the larger building was selected.</p>' : ''}
    ${records.length > 1 ? '<p class="pv-match-note">Color uses the largest reported size; records may describe the same system.</p>' : ''}
    <div class="pv-site-records">${records.map(site => `<article><strong>${site.system_size_kw === null ? 'PV · size not reported' : `${Number(site.system_size_kw).toLocaleString(undefined, {maximumFractionDigits:3})} kW`}</strong><p>${esc(site.site_name)}</p>${site.capacity_basis ? `<small>${esc(site.capacity_basis)}</small>` : ''}<a href="${esc(site.source_url)}" target="_blank" rel="noopener noreferrer">View public source ↗</a></article>`).join('')}</div>
    <button class="text-button" type="button">Zoom to site</button>`;
  element.querySelector('button').addEventListener('click', () => {
    if(records[0]) onZoom([records[0].longitude, records[0].latitude]);
  });
  return element;
}
