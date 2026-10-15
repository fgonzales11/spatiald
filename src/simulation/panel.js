import {esc,icon} from '../components/ui.js';
export function mountSimulationPanel(host,controller,{onClose}){
  host.innerHTML=`<div class="simulation-heading"><strong>${icon('bolt')} Simulation</strong><button type="button" class="icon-button" data-simulation-action="close" aria-label="Close simulation">${icon('close')}</button></div>
    <label for="simulation-circuit">Circuit key</label><select id="simulation-circuit" aria-describedby="simulation-status"><option value="">Loading circuit catalog…</option></select>
    <div class="simulation-actions"><button type="button" class="secondary" data-simulation-action="load" disabled>Load network</button><button type="button" class="primary" data-simulation-action="run" disabled>${icon('bolt')} Run power flow</button></div>
    <div class="simulation-options"><label>Topology <select id="simulation-topology"><option value="solver">GIS network</option><option value="gis">GIS circuit route (flat)</option></select></label><label class="simulation-layer-toggle"><input type="checkbox" id="simulation-visible" checked disabled> Network layer</label></div>
    <p id="simulation-status" role="status" aria-live="polite"></p><div id="simulation-detail"></div><button class="text-button" data-simulation-action="cancel" hidden>Cancel</button>`;
  let catalog;
  const $=q=>host.querySelector(q);
  host.addEventListener('change',event=>{
    if(event.target.id==='simulation-circuit')controller.select(event.target.value);
    if(event.target.id==='simulation-topology')controller.topology(event.target.value);
    if(event.target.id==='simulation-visible')controller.visible(event.target.checked);
  });
  host.addEventListener('click',event=>{
    const action=event.target.closest('[data-simulation-action]')?.dataset.simulationAction;
    if(action==='load')void controller.load();
    if(action==='run')controller.run();
    if(action==='cancel')controller.cancel();
    if(action==='close')onClose();
  });
  return state=>{
    const busy=['loading','running'].includes(state.status);
    const select=$('#simulation-circuit');
    if(catalog!==state.catalog && state.catalog){
      catalog=state.catalog;
      select.innerHTML='<option value="">Select a circuit…</option>'+catalog.networks.map(n=>`<option value="${esc(n.circuit_key)}">${esc(n.circuit_key)}${n.name?` · ${esc(n.name)}`:''}${n.available?'':' · unavailable'}</option>`).join('');
    }
    if(state.catalogStatus==='error' && !catalog)select.innerHTML='<option value="">Catalog unavailable. Reopen to retry.</option>';
    select.disabled=state.catalogStatus!=='ready';select.value=state.selectedKey;
    const network=state.catalog?.networks.find(n=>n.circuit_key===state.selectedKey);
    $('[data-simulation-action="load"]').disabled=!network?.available || busy;
    $('[data-simulation-action="run"]').disabled=!state.geometry || state.loadedKey!==state.selectedKey || busy;
    $('[data-simulation-action="load"]').textContent=state.status==='loading'?'Loading…':'Load network';
    $('[data-simulation-action="run"]').innerHTML=state.status==='running'?'Running…':`${icon('bolt')} Run power flow`;
    $('#simulation-topology').value=state.topology;
    $('#simulation-topology option[value="gis"]').disabled=Boolean(state.geometry&&!state.geometry.gis?.features?.length);
    $('#simulation-visible').checked=state.visible;$('#simulation-visible').disabled=!state.geometry;
    const status=$('#simulation-status');status.textContent=network?.available===false?network.error:state.message;status.dataset.state=state.status;
    $('[data-simulation-action="cancel"]').hidden=!busy;
    const provenance=state.geometry?.provenance;
    $('#simulation-detail').innerHTML=provenance?`<p class="simulation-stats">${provenance.physical_buses.toLocaleString()} buses · ${provenance.physical_edges.toLocaleString()} connections · one map layer</p>
      ${provenance.circuit_link?`<p>GIS circuit ${esc(provenance.circuit_link.circuit_no)} · ${esc(provenance.circuit_link.name)}</p>`:'<p>Partial GIS reference: no complete circuit route record.</p>'}
      <p class="simulation-provenance">${(provenance.gis_route_parts||0).toLocaleString()} recorded route parts · ${(provenance.gis_equipment||0).toLocaleString()} GIS equipment locations · ${provenance.physical_lines||0} electrical model lines.</p>
      <p class="simulation-provenance">${esc(provenance.coordinate_note||'')}</p>
      ${provenance.height_note?`<p class="simulation-provenance">${esc(provenance.height_note)}</p>`:''}
      ${state.topology==='gis'?'<p>Showing the recorded route at ground level. Select GIS network for raised conductors and equipment.</p>':''}
      ${state.result?`<p class="simulation-provenance">${esc(provenance.result_note||'Steady conductor glow indicates solve status.')}</p>`:''}
      ${state.result?`<p>${state.result.iterations} iterations · ${state.result.seconds.toFixed(2)} s · WebAssembly${state.result.solved?`<br>Voltage ${state.result.voltage_min?.toFixed(3)??'—'}–${state.result.voltage_max?.toFixed(3)??'—'} pu`:''}</p>`:''}`:'<p class="simulation-provenance">Multiconductor power flow runs locally in WebAssembly. The map uses GIS reference routes and equipment locations.</p>';
  };
}
