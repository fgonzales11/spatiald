import { esc, icon } from './ui.js';
import { PUBLIC_WORKSPACE_ID } from '../data/public-layers.js';

export function renderPklPvLayers(state) {
  if(state.mapMode!=='2d'||state.bundle.workspace.id!==PUBLIC_WORKSPACE_ID) return '';
  const status=state.pklPvStatus,summary=status?.summary,open=state.pklPvOpen||status?.status==='error';
  return `<section class="context-layer-list solar-pv-controls" aria-label="PKL PV layer">
    <div class="pv-layer-heading"><label><input type="checkbox" data-pkl-pv ${state.pklPvVisible!==false?'checked':''}><i class="layer-swatch" style="--layer-color:#ff0000"></i><span>PKL PV buildings</span><small>${summary?summary.totalSites.toLocaleString():''}</small></label><button class="text-button pv-legend-toggle" data-action="toggle-pkl-pv" aria-label="PKL PV layer details" aria-expanded="${Boolean(open)}" aria-controls="pkl-pv-details">${icon('chevron')}</button></div>
    <div id="pkl-pv-details" ${open?'':'hidden'}><p class="layer-foot pkl-pv-status" aria-live="polite">${status?.status==='error'?esc(status.error):summary?`${summary.totalSites.toLocaleString()} model generators · ${summary.buildingCount.toLocaleString()} red OSM buildings.<br>Connected-bus locations within the local OSM coverage.<br>All model generators included, as selected. Model technology is unclassified; power is modeled generation.`:'Loading PKL PV buildings…'}</p>
    ${summary?'<button class="text-button" data-action="view-pkl-pv">View PKL PV buildings</button>':''}
    ${status?.status==='error'?'<button class="text-button" data-action="retry-pkl-pv">Retry PKL PV layer</button>':''}</div>
  </section>`;
}

export function createPklPvPopup(feature,sites,{onZoom}) {
  const records=feature.properties.site_ids.map(id=>sites.get(id)).filter(Boolean);
  const root=document.createElement('section');root.className='solar-pv-popup pkl-pv-popup';
  root.innerHTML=`<h3>PKL PV building</h3><p class="pv-match-note">Nearest local OSM building to the connected bus · ${records.length>1?'up to ':''}${Number(feature.properties.match_distance_m).toFixed(1)} m.</p>
    ${feature.properties.tie_resolved_by_area?'<p class="pv-match-note">Equal distances: the larger building was selected.</p>':''}
    <div class="pv-site-records">${records.map(r=>`<article><strong>Generator ${esc(r.generator_name || r.generator_id)}</strong><p>Feeder ${esc(r.feeder)} · bus ${esc(r.bus_id)}</p><p>${Number(r.modeled_p_kw).toLocaleString(undefined,{maximumFractionDigits:3})} kW modeled active power</p><small>${esc(r.phase_connections)} · ${r.circuit_row_count} circuit rows</small><small>${esc(r.source_model)}</small><small>Model technology: ${esc(r.technology)}</small></article>`).join('')}</div><button class="text-button" type="button">Zoom to building</button>`;
  root.querySelector('button').addEventListener('click',()=>{
    const points=feature.geometry.coordinates[0];
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    onZoom([(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2]);
  });
  return root;
}
