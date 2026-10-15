import { esc, icon, pretty, dateLabel } from '../components/ui.js';
import { renderInspector } from '../components/inspector.js';
import { analysisRequest as api, analysisUpload, waitForAnalysisJob, boundsPolygon, PILOTS, ANALYSIS_TABS } from './api.js';
import { collectStudyAssets } from './collection.js';
import { PUBLIC_WORKSPACE_ID } from '../data/public-layers.js';
import { chartSpecification, mountChart, exportChart } from './charts.js';

const options = (items, selected = '') => items.map(([id,label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
const number = value => value === null || value === undefined ? 'Unknown' : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : esc(String(value));
const input = (name, label, value = '', type = 'text', extra = '') => type === 'hidden' ? `<input name="${name}" type="hidden" value="${esc(value)}">` : `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const select = (name, label, items, selected) => `<label>${esc(label)}<select name="${name}">${options(items, selected)}</select></label>`;
const button = (action, label, extra = '') => `<button type="button" class="secondary" data-analysis-action="${action}" ${extra}>${esc(label)}</button>`;
const link = (url, label) => `<a class="text-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
const table = (rows, columns, limit = 100) => `<div class="table-scroll"><table><thead><tr>${columns.map(([key,label]) => `<th>${esc(label || pretty(key))}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,limit).map(r => `<tr>${columns.map(([key]) => `<td>${typeof r[key] === 'object' && r[key] !== null ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(r[key],null,2))}</pre></details>` : number(r[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > limit ? `<p class="small muted">Showing ${limit} of ${rows.length.toLocaleString()} records. Export includes all records.</p>` : ''}`;

export function createAnalysisController({ getContext, notify }) {
  const state = { health: null, error: '', studies: [], loaded: null, tab: 'Exposure', activeRunId: '', snapshotId: '', selectedAssetId: '',
    selectedLayers: new Set(), featureFilters: {}, layerMetrics: {}, boundary: boundsPolygon(PILOTS.tampa.bounds), mapCamera: null, query: '', drawing: false, points: [], job: null, charts: null, cameras: [], cameraId: null, replayIndex: null, connecting: false, attempted: false };
  let host, map, chartView, hls, video, imageTimer, requestEpoch = 0, mapEpoch = 0, collectionAbort, busy = false;
  const entities = kind => state.loaded?.entities[kind] || [];
  const currentStudy = () => state.loaded?.study;
  const snapshot = () => entities('snapshot').find(s => s.id === state.snapshotId) || entities('snapshot').at(-1);
  const currentRun = () => entities('run').find(r => r.id === state.activeRunId) || entities('run').at(-1);
  const selectedLayers = () => entities('layer').filter(l => state.selectedLayers.has(l.id));
  const rows = () => (currentRun()?.result.rows || []).filter(r => (!state.query || JSON.stringify(r).toLowerCase().includes(state.query.toLowerCase())) && (!state.chartFilter || state.chartFilter.values.includes(r[state.chartFilter.field])));
  const formData = form => Object.fromEntries(new FormData(form));

  async function refresh() {
    if (!currentStudy()) return;
    state.loaded = await api(`/studies/${currentStudy().id}`);
    const ids = new Set(entities('layer').map(l => l.id));
    state.selectedLayers = new Set([...state.selectedLayers].filter(id => ids.has(id)));
    if (!entities('snapshot').some(s => s.id === state.snapshotId)) state.snapshotId = entities('snapshot').at(-1)?.id || '';
  }

  async function connect() {
    if(state.connecting)return;
    state.connecting=true;state.attempted=true;render();
    try {
      state.health = await api('/health'); state.error = '';
      state.studies = await api('/studies');
      state.cameras = await api('/cameras').catch(() => []);
      let saved;
      try { saved = localStorage.getItem('geobound.analysis-study'); } catch {}
      const study = state.studies.find(s => s.id === saved);
      if (study && !state.loaded) { state.loaded = await api(`/studies/${study.id}`); state.boundary = study.aoi; state.snapshotId = entities('snapshot').at(-1)?.id || ''; }
      else if(state.loaded) await refresh();
    } catch (error) { state.health = null; state.error = error.message; }
    state.connecting=false;render();
  }

  async function task(callback) {
    if (busy) return;
    busy = true; state.error = ''; render();
    try { await callback(); }
    catch (error) { state.error = error.message; notify?.(error.message, true); }
    finally { busy = false; state.job = null; await refresh().catch(() => {}); render(); }
  }

  async function run(kind, parameters) {
    if (!currentStudy()) throw new Error('Create or select a study first.');
    if (state.health?.enabledJobKinds && !state.health.enabledJobKinds.includes(kind)) throw new Error('This capability is disabled in the current release configuration.');
    const job = await api(`/studies/${currentStudy().id}/jobs`, { method: 'POST', body: { kind, parameters } });
    state.job = job;
    const completed = await waitForAnalysisJob(job, { onProgress: j => {
      state.job = j;
      const node = host?.querySelector('[data-job-status]');
      if (node) node.textContent = `${pretty(j.kind)} · ${j.status} · ${Math.round(j.progress * 100)}%`;
    } });
    state.activeRunId = completed.runId;state.chartSettings=null;state.charts=null;state.chartFilter=null;await refresh(); return currentRun();
  }

  async function add(kind, body) { return api(`/studies/${currentStudy().id}/entities/${kind}`, { method: 'POST', body }); }

  function captureBody(bundle, complete = false) {
    return { bundle, complete, coverageGeometry: currentStudy().aoi, capturedAt: new Date().toISOString(),
      name: `Captured snapshot · ${new Date().toLocaleString()}`, mapViewpoint: map?.capture() || state.mapCamera || getContext().camera,
      interpretation: complete ? 'Complete collection of selected public source inventories in this study area' : 'Captured browser inventory; full source coverage is not certified' };
  }

  async function captureIfActive(bundle) {
    if (!currentStudy() || !state.health || currentStudy().workspaceId !== bundle.workspace.id) return;
    try {
      const latest = entities('snapshot').at(-1);
      if (latest && JSON.stringify(latest.bundle) === JSON.stringify(bundle)) return;
      await add('snapshot', captureBody(bundle, false)); await refresh();
      if (host?.isConnected && !busy && !host.contains(document.activeElement)) render();
    } catch (error) { notify?.(`Study snapshot could not be saved: ${error.message}`, true); }
  }

  function stopMedia() { hls?.destroy(); hls = null; if (video) { video.pause(); video.removeAttribute('src'); video.load(); } video = null; clearInterval(imageTimer); }

  function nearbyCameras(asset) {
    const points = [];
    function visit(c) { if (Array.isArray(c) && typeof c[0] === 'number') points.push(c); else if (Array.isArray(c)) c.forEach(visit); }
    visit(asset.geometry.coordinates);
    const rad = x => x * Math.PI / 180;
    const distance = (p, c) => {
      const dlat = rad(c.latitude-p[1]), dlon = rad(c.longitude-p[0]);
      const a = Math.sin(dlat/2)**2 + Math.cos(rad(p[1])) * Math.cos(rad(c.latitude)) * Math.sin(dlon/2)**2;
      return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0,1-a)));
    };
    // Include segment projections so long infrastructure spans are not measured only at endpoints.
    return state.cameras.map(c => {
      const candidates = [...points];
      function segments(coords) {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0]?.[0] === 'number') for (let i=1; i<coords.length; i++) {
          const a=coords[i-1], b=coords[i], sx=Math.cos(rad(c.latitude));
          const dx=(b[0]-a[0])*sx, dy=b[1]-a[1];
          const t=Math.max(0,Math.min(1,((c.longitude-a[0])*sx*dx+(c.latitude-a[1])*dy)/(dx*dx+dy*dy||1)));
          candidates.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
        } else coords.forEach(segments);
      }
      if (asset.geometry.type !== 'MultiPoint') segments(asset.geometry.coordinates);
      return { ...c, distanceM: Math.min(...candidates.map(p => distance(p,c))) };
    }).filter(c => c.distanceM <= Number(state.cameraRadius || 1000)).sort((a,b) => a.distanceM-b.distanceM || a.id.localeCompare(b.id)).slice(0,5);
  }

  function contextPanel() {
    const asset = snapshot()?.bundle.assets.find(a => a.id === state.selectedAssetId);
    if (!asset) return '';
    const evidence = rows().find(r => r.assetId === asset.id);
    const finding = entities('finding').find(f => f.assetId === asset.id && f.snapshotId === snapshot().id);
    const clipped=currentRun()?.result.data?.features.find(f=>f.properties?.assetId===asset.id)?.geometry;
    const cameras = nearbyCameras(clipped?.coordinates?{...asset,geometry:clipped}:asset);
    const camera = state.cameras.find(c => c.id === state.cameraId);
    return `<section class="panel analysis-context"><div class="panel-title"><h2>${esc(asset.name)}</h2>${button('close-asset','Close')}</div>
      <div class="analysis-form"><p class="mono">${esc(asset.id)}</p><p>Criticality: <b>${esc(evidence?.criticality || (asset.attributes.criticalityVerified ? asset.attributes.criticality : 'Unknown'))}</b> · ${esc(evidence?.status || 'Not assessed')}</p>
      <details><summary>Original asset attributes and provenance</summary>${renderInspector(snapshot().bundle,asset).replaceAll('data-action="clear-selection"','data-analysis-action="close-asset"').replace(/data-select="([^"]+)"/g,'data-analysis-action="select-asset" data-id="$1"').replace(/data-measure="([^"]+)"/g,'data-analysis-action="asset-measurements" data-id="$1"')}</details>
      ${evidence ? `<details open><summary>Decision checklist</summary><dl>${Object.entries(evidence.checklist || {}).filter(([k]) => k !== 'sources').map(([k,v]) => `<dt>${esc(pretty(k))}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl><p class="small muted">Publisher time and collection time are distinct. Community context does not establish who this asset serves.</p></details>` : ''}
      <form data-analysis-form="finding">${input('assetId','Asset ID',asset.id,'hidden')}${input('id','Finding ID',finding?.id || '', 'hidden')}
      ${select('priority','Review priority',['Unassigned','High','Normal','Deferred'].map(x=>[x,x]),finding?.priority || 'Unassigned')}${input('reason','Reason for priority',finding?.reason || '')}
      ${select('status','Review status',['open','reviewed','completed'].map(x=>[x,pretty(x)]),finding?.status || 'open')}
      <label>Annotations<textarea name="annotations">${esc(finding?.annotations || '')}</textarea></label><label>Proposed actions<textarea name="proposedActions">${esc(finding?.proposedActions || '')}</textarea></label>
      <button class="primary" ${busy ? 'disabled' : ''}>Save finding</button></form>
      <h3>Nearby cameras</h3><label>Search radius (metres)<input name="camera-radius" type="number" min="1" max="10000" value="${state.cameraRadius || 1000}" data-analysis-camera-radius></label>
      <p class="small muted">Nearest five by map distance; proximity does not establish visibility. Feeds show current conditions during historical replay.</p>
      ${cameras.length ? cameras.map(c => `<div class="analysis-camera"><strong>${esc(c.name)}</strong><p>${esc(c.provider)} · ${number(c.distanceM)} m · ${esc(c.direction || 'Direction not supplied')} · ${c.inService ? 'Published in service' : 'Published out of service'}</p>${button('camera', c.videoAvailable ? 'Inspect camera' : 'Inspect image', `data-id="${esc(c.id)}"`)} ${link(c.sourceUrl,'Open provider')}</div>`).join('') : '<p class="muted">No published cameras within this radius.</p>'}
      ${camera ? `<div class="analysis-camera-player"><p>${esc(camera.name)}</p><video controls playsinline muted aria-label="Current highway camera"></video>${camera.snapshot ? `<img alt="Current camera snapshot" data-camera-image src="${esc(camera.snapshot)}">${button('camera-image','Refresh image')}` : ''}<p data-camera-status class="small muted">Live availability depends on the provider.</p></div>` : ''}</div></section>`;
  }

  function importForm() {
    return `<details class="panel analysis-import"><summary>Import hazards, context, history, or imagery</summary><form class="analysis-form" data-analysis-form="upload">
      ${input('name','Dataset name','','text','required')}${select('hazardType','Layer purpose',[['','Context / table / imagery'],...['flood','landslide','debris_flow','liquefaction','fault','weather'].map(x=>[x,pretty(x)])])}
      ${input('sourceUrl','Source link')}${input('sourceRights','Attribution / source rights')}${input('captureDate','Imagery / source capture date','','date')}
      ${input('vintage','Boundary/data vintage')}${input('unit','Value unit')}${input('verticalReference','Raster vertical reference')}
      <label><input type="checkbox" name="complete"> I can certify this dataset assesses the whole study area</label>
      <label>Data file<input name="file" type="file" accept=".geojson,.json,.csv,.tif,.tiff,.gpkg,.zip,.xlsx" required></label>
      <p class="small muted">GeoJSON / GeoPackage / zipped shapefile, CSV, RGB or flood-depth GeoTIFF, canonical snapshot JSON, or CEC workbook. Original imagery is excluded from study packages.</p>
      <button class="primary" ${busy ? 'disabled' : ''}>Import dataset</button></form></details>`;
  }

  function sourceForm() {
    return `<details class="panel analysis-import"><summary>Load a public dataset</summary><form class="analysis-form" data-analysis-form="source">
      ${select('sourceId','Source',(state.health?.sources || []).map(s=>[s.id,s.name]),state.sourceId || 'fema')}
      <div data-source-parameters>${sourceParameters(state.sourceId || 'fema')}</div>
      <p class="small muted">A failed update retains the previous successful source version. Static hazard maps are distinct from current alerts and supplied scenarios.</p>
      <button class="primary" ${busy ? 'disabled' : ''}>Load source for study area</button></form></details>`;
  }

  function sourceParameters(id) {
    if (id === 'nws') return select('state','State',[['FL','Florida'],['CA','California']], currentStudy()?.aoi.coordinates?.[0]?.[0]?.[0] < -100 ? 'CA' : 'FL');
    if (id === 'acs' || id === 'census-blocks') return `${input('state','State FIPS',currentStudy()?.aoi.coordinates?.[0]?.[0]?.[0] < -100 ? '06' : '12')}${input('county','County FIPS',currentStudy()?.aoi.coordinates?.[0]?.[0]?.[0] < -100 ? '037' : '057')}<p class="small muted">Census API key is configured on the local service. Counts use 2020 blocks; ACS estimates use matching 2024 block groups.</p>`;
    if (id === 'eia-reliability') return `${input('utilityId','EIA utility number','','text','required')}${input('startYear','First year',2013,'number','min="2013"')}${input('endYear','Last published year',2024,'number')}<p class="small muted">Utility/reporting-scope indices remain separate by method and major-event basis. Territory geometry can be imported separately.</p>`;
    if (id === 'cec-ev') return input('countyName','California county','Los Angeles');
    if (id === 'afdc-ev') return `${input('stateName','State name','Florida')}${input('startYear','First year',2016,'number')}${input('endYear','Last published year',2025,'number')}`;
    if (id === 'naip') return `${input('captureDate','Verified imagery capture date','','date','required')}${input('sourceRights','Verified imagery rights / attribution','','text','required')}<p class="small muted">Downloads a 2048 × 2048 georeferenced study-area crop. Pixel resolution must be suitable for PV segmentation.</p>`;
    return '';
  }

  function layerList() {
    const layers = entities('layer');
    const selectedContext=entities('layer').find(l=>l.id===state.contextFeature?.layerId);
    const contextFeature=selectedContext?.data.features.find(f=>String(f.id)===state.contextFeature.featureId);
    return `<section class="panel analysis-layers"><div class="panel-title"><h2>Study evidence</h2><span>${layers.length} versions</span></div><div class="analysis-form">${layers.length ? layers.map(l => `<div class="analysis-layer"><label><input type="checkbox" data-analysis-layer="${esc(l.id)}" ${state.selectedLayers.has(l.id) ? 'checked' : ''}> <strong>${esc(l.name)}</strong></label><p class="small muted">${esc(pretty(l.hazardType || l.geographyLevel || 'Context'))} · ${number(l.data?.features.length || l.rows?.length || 0)} records · ${l.complete ? 'Retrieval certified' : 'Coverage not certified'}</p><p class="small muted">Publisher: ${esc(l.sourceUpdatedAt || 'Not supplied')}<br>Collected: ${esc(l.fetchedAt || 'Not supplied')}</p>${l.interpretation ? `<p class="small muted">${esc(l.interpretation)}</p>` : ''}${l.coverageError ? `<p class="small analysis-warning">Boundary join unavailable: ${esc(l.coverageError)}</p>` : ''}${l.hazardType && l.data?.features.length ? select(`feature-${l.id}`,'Hazard feature',[['','All features in this version'],...l.data.features.slice(0,200).map(f=>[String(f.id), String(f.properties?.event || f.properties?.name || f.properties?.FLD_ZONE || f.id)])],state.featureFilters[l.id] || '') : ''}${metricControl(l)}${l.sourceUrl ? link(l.sourceUrl,'Source') : ''}</div>`).join('') : '<p class="muted">Load a public source or import a dataset to begin.</p>'}${contextFeature ? `<details open><summary>Selected map evidence · ${esc(selectedContext.name)}</summary><pre>${esc(JSON.stringify(contextFeature.properties,null,2))}</pre><p class="small muted">These attributes describe the source geography and period, not customer impact.</p></details>` : ''}</div></section>`;
  }

  function metricControl(layer) {
    if(layer.hazardType || !layer.data.features.length)return '';
    const sample=layer.data.features.slice(0,200);
    const keys=[...new Set(sample.flatMap(f=>Object.keys(f.properties || {})))].filter(k=>sample.some(f=>typeof f.properties?.[k]==='number')&&!/OBJECTID|Shape_|latitude|longitude/i.test(k));
    const key=state.layerMetrics[layer.id];
    const values=key?layer.data.features.map(f=>f.properties?.[key]).filter(v=>typeof v==='number'&&Number.isFinite(v)):[];
    return select(`metric-${layer.id}`,'Map value',[['','Outline / source geometry'],...keys.map(k=>[k,pretty(k)])],key || '')+(values.length?`<p class="small muted">${number(Math.min(...values))} – ${number(Math.max(...values))} · ${esc(layer.unit || (key==='saidi'?'minutes/customer/year':key==='saifi'?'interruptions/customer/year':'original source units'))} · pale blue to muted red; gray means unknown.</p>`:'');
  }

  function snapshotSelect(name = 'snapshotId', label = 'Frozen asset snapshot', selected = state.snapshotId) {
    return select(name,label,entities('snapshot').map(s=>[s.id,`${s.name || 'Captured snapshot'} · ${s.bundle.assets.length} assets${s.complete ? ' · complete AOI collection' : ' · coverage not certified'}`]),selected);
  }

  function tabContent() {
    const layers = entities('layer'), snapshots = entities('snapshot'), runRecord = currentRun();
    if (state.tab === 'Exposure') return `<section class="panel"><div class="panel-title"><h2>Hazard exposure</h2></div><form class="analysis-form" data-analysis-form="exposure">${snapshotSelect()}${input('faultBufferM','Fault proximity buffer (metres)',0,'number','min="0" step="1"')}<p>Select hazard versions in Study evidence. Click a hazard on the map or choose a feature to restrict a version. Zero buffer means actual fault-trace intersections.</p><button class="primary" ${busy || !snapshots.length ? 'disabled' : ''}>Analyze exposure</button></form></section>`;
    if (state.tab === 'Replay') {
      const ordered = [...snapshots].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));
      const index = state.replayIndex ?? Math.max(0,ordered.findIndex(s=>s.id===state.snapshotId));
      const active = ordered[index];
      const time = state.replayAt || active?.capturedAt;
      const measurements = active?.bundle.observations.filter(o=>o.observedAt<=time) || [];
      const events = active?.bundle.events.filter(e=>e.startedAt<=time) || [];
      return `<section class="panel"><div class="panel-title"><h2>Replay captured history</h2></div><div class="analysis-form"><label>Captured snapshot<input type="range" data-analysis-replay min="0" max="${Math.max(0,ordered.length-1)}" value="${index}" ${ordered.length ? '' : 'disabled'}></label>${input('replayAt','Measurement / event cutoff (UTC)',(time || '').replace('Z','').slice(0,19),'datetime-local','data-analysis-cutoff')}<p>Map capture: ${esc(active?.capturedAt || 'Not available')} · Cutoff: ${esc(time || 'No captured history')} · ${measurements.length} observations · ${events.length} events</p><p class="small muted">Earlier measurement history does not establish an earlier asset map state. Current cameras and basemaps are not historical footage.</p>
        ${active ? table(events, [['type','Event'],['startedAt','Started'],['endedAt','Ended'],['severity','Severity']],15) : ''}
        <form data-analysis-form="replay">${snapshotSelect('beforeId','Before snapshot',ordered[0]?.id)}${snapshotSelect('afterId','After snapshot',active?.id)}<button class="primary" ${busy || ordered.length<2 ? 'disabled' : ''}>Compare snapshots</button></form>
        ${active ? `<form data-analysis-form="measurements">${select('seriesId','Measurement series',active.bundle.series.map(s=>[s.id,`${s.quantity} · ${s.unit}${s.phase?' · '+s.phase:''}`]))}<button class="secondary" ${busy||!active.bundle.series.length?'disabled':''}>Plot selected measurement series</button></form><details><summary>Measurements at this capture</summary>${table(measurements,[['seriesId','Series'],['observedAt','Observed'],['value','Original value'],['quality','Quality']],50)}</details>` : ''}</div></section>`;
    }
    if (state.tab === 'Scenarios') return `<section class="panel"><div class="panel-title"><h2>Compare supplied scenarios</h2></div><form class="analysis-form" data-analysis-form="scenario">${input('name','Scenario name','','text','required')}${snapshotSelect()}${select('alternativeId','Alternative hazard or flood-depth raster',layers.filter(l=>l.hazardType).map(l=>[l.id,l.name]))}<label>Supplied asset relocations (optional GeoJSON)<input name="relocations" type="file" accept=".json,.geojson"></label><label>Mitigation assumptions<textarea name="assumptions" placeholder="Describe the supplied scenario and proposed mitigation."></textarea></label><p class="small muted">Checked hazard versions form the baseline. The comparison uses the same frozen assets and area. An annotation alone cannot reduce exposure.</p><button class="primary" ${busy || !snapshots.length ? 'disabled' : ''}>Compare baseline and alternative</button></form></section>`;
    if (state.tab === 'PV') return `<section class="panel"><div class="panel-title"><h2>PV array detection</h2><span class="badge warning">Experimental</span></div><form class="analysis-form" data-analysis-form="pv">${select('imageryId','Georeferenced RGB imagery',layers.filter(l=>l.bands>=3).map(l=>[l.id,l.name]))}${input('efficiency','Module efficiency (%)',20,'number','min="1" max="100" step="0.1"')}${input('tilt','Supplied tilt (degrees); 0° if unknown',0,'number','min="0" max="84"')}${input('threshold','Segmentation threshold',.5,'number','min="0.01" max="0.99" step="0.01"')}${input('minAreaM2','Minimum detected area (m²); 0 disables filter',1,'number','min="0" step="0.1"')}
      <p class="small muted">Detects visible array area and estimates DC capacity. Imagery must be 8-bit RGB with ground sample distance at most 0.6 m. Efficiency and tilt sensitivity are assumptions, distinct from model uncertainty. Reported capacity and modeled operating power remain separate.</p>${state.health?.pvModelCard ? `<details><summary>Model card and measured validation</summary><pre>${esc(JSON.stringify(state.health.pvModelCard,null,2))}</pre></details>` : ''}${state.health?.capabilities.pv ? '' : '<p class="analysis-warning">A trained checkpoint and model card are required. Install the model produced by the documented local training workflow; random-weight predictions are never shown.</p>'}<button class="primary" ${busy || !state.health?.capabilities.pv ? 'disabled' : ''}>Detect PV arrays</button></form>
      <div class="analysis-form"><form data-analysis-form="pv-review">${select('runId','PV detection run',entities('run').filter(r=>r.kind==='pv').map(r=>[r.id,`${r.createdAt} · ${r.result.rows.length} arrays`]))}${input('arrayId','Detected array ID',state.selectedAssetId || '')}${select('status','Review decision',[['accepted','Accept'],['rejected','Reject'],['corrected','Correct polygon']])}<label>Corrected polygon (optional GeoJSON file)<input name="polygon" type="file" accept=".json,.geojson"></label>${input('efficiency','Correction efficiency (%)',20,'number')}${input('tilt','Correction tilt (degrees)',0,'number')}<button class="secondary" ${busy ? 'disabled' : ''}>Save array review</button></form></div></section>`;
    if (state.tab === 'EV Forecasts') return `<section class="panel"><div class="panel-title"><h2>EV adoption through 2035</h2><span class="badge warning">Experimental</span></div><form class="analysis-form" data-analysis-form="ev">${select('historyId','Published registration history',layers.filter(l=>l.rows?.some(r=>'bev' in r && 'phev' in r && 'total' in r)).map(l=>[l.id,l.name]))}${input('geographyId','Geographic series (leave empty for a single series)')}${input('fleetGrowth','Annual total fleet growth (%)',0,'number','min="-20" max="20" step="0.1"')}<p class="small muted">Requires six consecutive comparable annual observations. BEV and PHEV stay distinct. The latest total fleet is held constant by default; adoption is not translated into feeder load.</p><button class="primary" ${busy ? 'disabled' : ''}>Generate forecast and backtests</button></form></section>`;
    if (state.tab === 'Charts') {
      const plotRows = rows(), keys = [...new Set(plotRows.flatMap(r=>Object.keys(r)))].filter(k=>plotRows.some(r=>typeof r[k]!=='object' || r[k]===null));
      return `<section class="panel"><div class="panel-title"><h2>Plots and spatial tools</h2></div><div class="analysis-form"><form data-analysis-form="spatial">${select('leftId','Input vector layer',layers.filter(l=>l.data.features.length).map(l=>[l.id,l.name]))}${select('operation','Operation',['intersection','clip','buffer','nearest','spatial_join','dissolve','metrics','zonal_statistics'].map(x=>[x,pretty(x)]))}${select('rightId','Second layer / raster',[['','None'],...layers.map(l=>[l.id,l.name])])}${input('distanceM','Buffer distance (metres)',1000,'number','min="0"')}<button class="primary" ${busy ? 'disabled' : ''}>Run spatial analysis</button></form>
      <form data-analysis-form="table">${select('layerId','Plot an imported table or context layer',layers.map(l=>[l.id,l.name]))}<button class="secondary" ${busy ? 'disabled' : ''}>Use dataset for charts</button></form>
      <form data-analysis-form="chart">${select('type','Chart type',['bar','time-series','histogram','scatter','forecast-band','scenario-difference'].map(x=>[x,pretty(x)]))}${select('x','Horizontal field',keys.map(x=>[x,pretty(x)]),keys.includes('year')?'year':keys.includes('assetType')?'assetType':keys[0])}${select('y','Value field',keys.map(x=>[x,pretty(x)]),keys.includes('count')?'count':keys.includes('lengthM')?'lengthM':keys.find(k=>plotRows.some(r=>typeof r[k]==='number')))}${select('color','Group / color',[['','None'],...keys.map(x=>[x,pretty(x)])],keys.includes('vehicle')?'vehicle':'')}${input('unit','Value unit',plotRows[0]?.unit || '')}${select('aggregate','Aggregation',[['none','Individual values'],['sum','Sum additive quantities'],['ratio','Rate from numerator / denominator']])}${select('numerator','Rate numerator',[['','Choose when calculating a rate'],...keys.map(x=>[x,pretty(x)])])}${select('denominator','Rate denominator',[['','Choose when calculating a rate'],...keys.map(x=>[x,pretty(x)])])}<button class="primary" ${busy || !plotRows.length ? 'disabled' : ''}>Generate chart</button></form>
      <div class="analysis-chart" data-analysis-chart></div><div class="analysis-actions">${button('save-chart','Save chart to review')}${button('chart-svg','Export SVG')}${button('chart-png','Export PNG')}${button('clear-chart-filter','Clear chart selection')}</div><p class="small muted">Plots use the filtered results below. Null values remain missing; medians and reliability indices cannot be summed.</p></div></section>`;
    }
    return `<section class="panel"><div class="panel-title"><h2>Resilience review package</h2></div><div class="analysis-form"><p>Save asset findings from the result table. Packages preserve IDs, frozen inputs, source dates, assumptions, annotations, proposed actions, viewpoints, and saved charts.</p><div class="analysis-actions">${link(`/api/analysis/studies/${currentStudy().id}/report`,'Open meeting report')}${link(`/api/analysis/studies/${currentStudy().id}/package`,'Export study ZIP')}</div><p class="small muted">Credentials, Google imagery, live footage, and raw rasters are excluded. Reimport raw rasters locally to recompute raster-based analyses.</p>${table(entities('finding'),[['assetId','Asset'],['priority','Priority'],['reason','Reason'],['status','Status'],['proposedActions','Proposed actions']])}<h3>Source health</h3>${table(entities('sourceHealth'),[['id','Source'],['status','Status'],['lastSuccessAt','Last success'],['error','Latest error']])}<h3>Saved charts</h3>${table(entities('chart'),[['name','Chart'],['createdAt','Saved'],['runId','Analysis run']])}</div></section>`;
  }

  function resultsPanel() {
    const record = currentRun();
    if (!record) return '<section class="panel empty"><h2>Evidence-backed results</h2><p>Capture assets, select hazard evidence, then run an analysis.</p></section>';
    const output = record.result;
    const filtered = rows();
    const summary = output.summary || output.alternative?.summary;
    const columns = record.kind === 'exposure' ? [['name','Asset'],['assetType','Type'],['status','Assessment'],['lengthM','Exposed length (m)'],['criticality','Criticality']] :
      [...new Set(filtered.flatMap(r=>Object.keys(r)))].slice(0,10).map(k=>[k,pretty(k)]);
    return `<section class="panel analysis-results"><div class="panel-title"><h2>${esc(pretty(record.kind))} results</h2><span>${filtered.length.toLocaleString()} records</span></div><div class="analysis-form">
      ${select('activeRun','Analysis run',entities('run').map(r=>[r.id,`${pretty(r.kind)} · ${r.createdAt}`]),record.id)}
      <label>Filter map and results<input data-analysis-query value="${esc(state.query)}" placeholder="Asset ID, type, status, geography…"></label>
      ${summary ? `<div class="chart-metrics"><div><small>Exposed assets</small><b>${summary.exposed}</b></div><div><small>Not exposed</small><b>${summary.not_exposed}</b></div><div><small>Not assessed</small><b>${summary.not_assessed}</b></div><div><small>Insufficient data</small><b>${summary.insufficient_data || 0}</b></div><div><small>Exposed length</small><b>${number(summary.exposedLengthM)} m</b></div></div>` : ''}
      ${record.kind === 'scenario' ? `<p>Entering exposure: ${output.entering.length} · Leaving exposure: ${output.leaving.length} · Length difference: ${number(output.exposedLengthDeltaM)} m</p>${output.comparisonUnassessed?.length ? `<p class="analysis-warning">${output.comparisonUnassessed.length} assets lack complete comparison coverage. Entering/leaving lists require an assessed negative result; length differences alone do not establish a reduction.</p>` : ''}<p class="small muted">${esc(output.depthInterpretation)}</p>` : ''}
      ${record.kind === 'ev' ? `<p>Selected model: ${esc(pretty(output.model))}</p><details><summary>Chronological validation and assumptions</summary><pre>${esc(JSON.stringify({errors:output.selectionErrors,modelCard:output.modelCard,assumptions:output.assumptions},null,2))}</pre>${table(output.backtests,[['model','Model'],['year','Year'],['horizon','Horizon'],['actualBev','Actual BEV'],['predictedBev','Predicted BEV']],30)}</details>` : ''}
      ${record.kind === 'replay' ? `<p>Removals assessed: ${output.removalsAssessed ? 'Yes, complete matching areas' : 'No, incomplete or different coverage'}</p>` : ''}
      ${table(filtered,columns)}
      ${record.kind === 'exposure' ? `<div class="analysis-asset-buttons">${filtered.slice(0,100).map(r=>button('select-asset',r.name,`data-id="${esc(r.assetId)}"`)).join('')}</div>` : ''}
      <div class="analysis-actions">${link(`/api/analysis/studies/${currentStudy().id}/runs/${record.id}/export/csv`,'Export all rows CSV')}${output.data ? `${link(`/api/analysis/studies/${currentStudy().id}/runs/${record.id}/export/geojson`,'Export GeoJSON')} ${link(`/api/analysis/studies/${currentStudy().id}/runs/${record.id}/export/gpkg`,'Export GeoPackage')}` : ''}</div>
      <p class="small muted">Run ${esc(record.id)} · ${esc(record.createdAt)} · Inputs frozen independently of displayed layers. Source/model limitations remain attached to results.</p></div></section>`;
  }

  function render() {
    if (!host?.isConnected) return;
    ++requestEpoch;
    if (map) { state.mapCamera = map.capture(); map.dispose(); map = null; }
    chartView?.finalize(); chartView = null; stopMedia();
    const study = currentStudy();
    host.innerHTML = `<div class="analysis-workbench"><div class="page-heading"><div><div class="eyebrow">Infrastructure resilience, with evidence</div><h1>Analysis workbench</h1><p>Select a hazard, review exposed assets, and build a reproducible planning package.</p></div>${button('connect','Reconnect')}</div>
      ${state.error ? `<p class="analysis-warning" role="alert">${esc(state.error)}</p>` : ''}
      ${!state.health ? state.connecting || !state.attempted ? '<section class="panel empty" role="status"><h2>Connecting to analysis service…</h2></section>' : `<section class="panel empty"><h2>Analysis service unavailable</h2><p>Reconnect to the hosted analysis service to create studies and run models. Your spatial map, assets, and imports remain available.</p>${button('connect','Check connection')}</section>` : `
      <section class="panel"><div class="analysis-form"><div class="analysis-actions">${select('studyPicker','Study',[['','Create a study'],...state.studies.map(s=>[s.id,s.name])],study?.id || '')}<span data-job-status role="status">${busy ? state.job ? `${pretty(state.job.kind)} · ${state.job.status}` : 'Working…' : 'Analysis service ready'}</span>${busy ? button('cancel','Cancel current job') : ''}</div>
      ${!study ? `<form data-analysis-form="create">${input('name','Study name','Resilience planning review','text','required')}${select('pilot','Boundary preset',[['tampa','Tampa Bay'],['losAngeles','Los Angeles County'],['current','Current spatial map extent'],['drawn','Drawn / imported boundary']])}${input('bounds','West, south, east, north',PILOTS.tampa.bounds.join(', '))}<label>Boundary GeoJSON (optional)<input name="boundary" type="file" accept=".json,.geojson"></label><div class="analysis-actions">${button('draw','Draw boundary on map')}${button('finish-draw','Finish boundary')}<button class="primary" ${busy ? 'disabled' : ''}>Create study</button></div></form>` : `<p><strong>${esc(study.name)}</strong> · ${entities('snapshot').length} immutable snapshots · ${entities('run').length} saved runs</p><div class="analysis-actions">${button('capture','Capture current browser assets')}${button('collect','Collect complete public assets for study area')}${button('new-study','New study')}</div><p class="small muted">Manual captures do not certify full source coverage. Public collection requests detailed records regardless of map visibility or nationwide display tiles.</p>`}</div></section>
      <section class="panel analysis-map-panel"><div data-analysis-map class="analysis-map" aria-label="Study boundary, assets, and analytical overlays"></div><p data-map-status class="small muted">Loading 2D analytical map…</p>${state.drawing ? '<p class="small">Click to add boundary vertices, then choose Finish boundary.</p>' : ''}</section>
      ${study ? `<div class="analysis-tabs" role="tablist">${ANALYSIS_TABS.map(t=>`<button type="button" role="tab" aria-selected="${state.tab===t}" class="${state.tab===t?'active':''}" data-analysis-action="tab" data-tab="${t}">${t}</button>`).join('')}</div><div class="analysis-layout"><aside>${sourceForm()}${importForm()}${layerList()}</aside><div>${tabContent()}${contextPanel()}${resultsPanel()}</div></div>` : ''}
      <details class="panel analysis-import"><summary>Import a saved study package</summary><form class="analysis-form" data-analysis-form="package"><label>Study ZIP<input name="file" type="file" accept=".zip" required></label><button class="secondary" ${busy?'disabled':''}>Import package</button></form></details>`}</div>`;
    if (state.health) mountMap();
    if (state.tab === 'Charts' && state.charts && host.querySelector('[data-analysis-chart]')) {
      const epoch = ++requestEpoch;
      if(state.chartSettings){try{state.charts=chartSpecification(rows(),state.chartSettings);}catch(error){host.querySelector('[data-analysis-chart]').textContent=error.message;return;}}
      mountChart(host.querySelector('[data-analysis-chart]'),state.charts,id=>{if(typeof id==='object')state.chartFilter=id;else state.selectedAssetId=id;render();}).then(view=>{if(epoch!==requestEpoch) view.finalize();else chartView=view;}).catch(e=>{ const node=host.querySelector('[data-analysis-chart]');if(node)node.textContent=e.message; });
    }
    if (state.cameraId) void startCamera();
  }

  async function mountMap() {
    const root = host.querySelector('[data-analysis-map]');
    const epoch = ++mapEpoch;
    const result = currentRun()?.result;
    const filteredIds = new Set(rows().map(r=>r.assetId).filter(Boolean));
    const output = result?.data ? { ...result.data, features: result.data.features.filter(f=>(!state.query || filteredIds.has(f.properties?.assetId) || JSON.stringify(f.properties).toLowerCase().includes(state.query.toLowerCase())) && (!state.chartFilter || state.chartFilter.values.includes(f.properties?.[state.chartFilter.field]))) } : undefined;
    try {
      const { createAnalysisMap } = await import('./map.js');
      if (epoch !== mapEpoch || !root.isConnected) return;
      map = createAnalysisMap(root, { camera: state.mapCamera, aoi: currentStudy()?.aoi || state.boundary,
        assets: snapshot()?.bundle.assets.filter(a=>!(state.query||state.chartFilter) || filteredIds.has(a.id)) || [], selectedAssetId:state.selectedAssetId, layers: selectedLayers().filter(l=>l.data.features.length||l.rasterArtifact).map(l=>({...l,metric:state.layerMetrics[l.id]})), output,
        onSelect: id=>{state.selectedAssetId=id;render();}, onHazard:(layerId,featureId)=>{state.featureFilters[layerId]=featureId;state.contextFeature={layerId,featureId};render();},
        onDrawPoint: point=>{state.points.push(point);map?.points(state.points);},
        onStatus: message=>{if(!root.isConnected)return;const n=host.querySelector('[data-map-status]');if(n)n.textContent=message;} });
      if(state.drawing)map.draw(true);
    } catch { root.innerHTML='<p class="analysis-form">Map rendering is unavailable on this device. Study boundaries and analytical tables remain available.</p>'; }
  }

  async function startCamera() {
    const camera = state.cameras.find(c=>c.id===state.cameraId);
    video=host.querySelector('video');
    if(!video||!camera) return;
    const image=host.querySelector('[data-camera-image]');
    if(image)imageTimer=setInterval(()=>{if(image.isConnected)image.src=`${camera.snapshot}?_=${Date.now()}`;},30000);
    const targetVideo=video;
    const fail=()=>{const n=host.querySelector('[data-camera-status]');if(n)n.textContent='Video unavailable. The current provider image is shown when available.';};
    if(!camera.videoAvailable)return;
    if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=camera.stream;video.addEventListener('error',fail,{once:true});return;}
    const {default:Hls}=await import('hls.js');
    if(video!==targetVideo||!targetVideo.isConnected)return;
    if(Hls.isSupported()){hls=new Hls();hls.on(Hls.Events.ERROR,(_e,d)=>{if(d.fatal)fail();});hls.loadSource(camera.stream);hls.attachMedia(video);}else fail();
  }

  async function submit(event) {
    const form=event.target.closest('[data-analysis-form]');if(!form)return;
    event.preventDefault(); const kind=form.dataset.analysisForm, data=formData(form), files=new FormData(form);
    await task(async()=>{
      if(kind==='create') {
        let aoi=state.boundary;
        const file=files.get('boundary');
        if(file?.size){const d=JSON.parse(await file.text());aoi=d.type==='FeatureCollection'?d.features[0]?.geometry:d.type==='Feature'?d.geometry:d;}
        else if(data.pilot!=='drawn')aoi=boundsPolygon(data.bounds.split(',').map(Number));
        const s=await api('/studies',{method:'POST',body:{name:data.name,aoi,workspaceId:getContext().bundle.workspace.id,timezone:getContext().bundle.workspace.timezone}});
        state.loaded=await api(`/studies/${s.id}`);state.studies.push(s);state.boundary=aoi;state.mapCamera=null;
        try{localStorage.setItem('geobound.analysis-study',s.id);}catch{}
      } else if(kind==='upload') {
        const file=files.get('file');
        const meta={...data,complete:data.complete==='on',coverageGeometry:data.complete==='on'?currentStudy().aoi:undefined,sourceId:file.name.endsWith('.xlsx')?'cec-ev':undefined};delete meta.file;
        const value=await analysisUpload(file,{studyId:currentStudy().id,metadata:meta,resumable:state.health?.resumableUploads});
        if(value.bundle)state.snapshotId=value.id;else state.selectedLayers.add(value.id);
      } else if(kind==='source') {
        const record=await run('source',data);if(record.result.layerId)state.selectedLayers.add(record.result.layerId);
      } else if(kind==='exposure') {
        state.snapshotId=data.snapshotId;
        await run('exposure',{snapshotId:data.snapshotId,layerIds:selectedLayers().filter(l=>l.hazardType).map(l=>l.id),featureFilters:state.featureFilters,faultBufferM:Number(data.faultBufferM)});
      } else if(kind==='replay')await run('replay',data);
      else if(kind==='measurements'){
        const record=await run('measurements',{snapshotId:snapshot().id,seriesId:data.seriesId,asOf:state.replayAt || snapshot().capturedAt});
        state.charts=chartSpecification(record.result.rows,{type:'time-series',x:'observedAt',y:'value',unit:record.result.series.unit});state.tab='Charts';
      }
      else if(kind==='scenario') {
        const relocation=files.get('relocations');let overrides=[];
        if(relocation?.size){const geo=JSON.parse(await relocation.text());overrides=(geo.features||[geo]).map(f=>({assetId:f.properties?.assetId||f.id,geometry:f.geometry}));}
        const scenario=await add('scenario',{name:data.name,snapshotId:data.snapshotId,layerIds:[data.alternativeId],assetOverrides:overrides,assumptions:data.assumptions});
        state.snapshotId=data.snapshotId;await run('scenario',{snapshotId:data.snapshotId,scenarioId:scenario.id,layerIds:selectedLayers().filter(l=>l.hazardType).map(l=>l.id)});
      } else if(kind==='pv')await run('pv',{imageryId:data.imageryId,efficiency:Number(data.efficiency)/100,tilt:Number(data.tilt),threshold:Number(data.threshold),minAreaM2:Number(data.minAreaM2)});
      else if(kind==='pv-review') {
        const polygon=files.get('polygon');let g;
        if(polygon?.size){const geo=JSON.parse(await polygon.text());g=geo.type==='FeatureCollection'?geo.features[0]?.geometry:geo.type==='Feature'?geo.geometry:geo;}
        if(data.status==='corrected'&&!g)throw new Error('Supply a corrected polygon for a correction review.');
        await add('pvReview',{runId:data.runId,arrayId:data.arrayId,status:data.status,geometry:g,efficiency:Number(data.efficiency)/100,tilt:Number(data.tilt)});
      } else if(kind==='ev')await run('ev',{historyId:data.historyId,geographyId:data.geographyId,endYear:2035,fleetGrowth:Number(data.fleetGrowth)/100});
      else if(kind==='spatial')await run('spatial',{...data,distanceM:Number(data.distanceM)});
      else if(kind==='table')await run('table',{layerId:data.layerId});
      else if(kind==='chart'){state.chartSettings=data;state.charts=chartSpecification(rows(),data);}
      else if(kind==='finding') {
        if(!data.id)delete data.id;
        await add('finding',{...data,snapshotId:snapshot().id,mapViewpoint:map?.capture() || state.mapCamera,runId:currentRun()?.id,sourceDates:entities('layer').map(l=>({layerId:l.id,fetchedAt:l.fetchedAt,sourceUpdatedAt:l.sourceUpdatedAt}))});
      } else if(kind==='package') {
        const s=await analysisUpload(files.get('file'),{purpose:'package',resumable:state.health?.resumableUploads});state.studies.push(s);state.loaded=await api(`/studies/${s.id}`);state.boundary=s.aoi;state.snapshotId=entities('snapshot').at(-1)?.id||'';state.mapCamera=null;
      }
    });
  }

  async function click(event) {
    const node=event.target.closest('[data-analysis-action]');if(!node)return;
    const action=node.dataset.analysisAction;
    if(action==='connect')return connect();
    if(busy && ['capture','collect','new-study','draw','finish-draw','save-chart'].includes(action))return;
    if(action==='tab'){state.tab=node.dataset.tab;state.cameraId=null;return render();}
    if(action==='clear-chart-filter'){state.chartFilter=null;return render();}
    if(action==='select-asset'){state.selectedAssetId=node.dataset.id;return render();}
    if(action==='asset-measurements'){state.tab='Replay';return render();}
    if(action==='close-asset'){state.selectedAssetId='';state.cameraId=null;return render();}
    if(action==='camera'){state.cameraId=node.dataset.id;return render();}
    if(action==='camera-image'){const image=host.querySelector('[data-camera-image]');if(image){const camera=state.cameras.find(c=>c.id===state.cameraId);image.src=`${camera.snapshot}?_=${Date.now()}`;}return;}
    if(action==='new-study'){state.loaded=null;state.mapCamera=null;state.activeRunId='';state.snapshotId='';state.selectedLayers.clear();return render();}
    if(action==='draw'){state.drawing=true;state.points=[];map?.draw(true);return;}
    if(action==='finish-draw'){if(state.points.length<3){state.error='Add at least three boundary vertices.';return render();}state.boundary={type:'Polygon',coordinates:[[...state.points,state.points[0]]]};state.drawing=false;render();const select=host.querySelector('[name="pilot"]');if(select)select.value='drawn';return;}
    if(action==='cancel'){collectionAbort?.abort();if(state.job)await api(`/jobs/${state.job.id}/cancel`,{method:'POST',body:{}});return;}
    if(action==='chart-svg'||action==='chart-png')return exportChart(chartView,action.endsWith('svg')?'svg':'png').catch(e=>notify(e.message,true));
    if(action==='save-chart'){
      // Capture generated SVG before task() re-renders and finalizes the chart view.
      if(!chartView||!state.charts)return notify('Generate a chart first.',true);
      const svg=await chartView.toSVG();return task(()=>add('chart',{name:`${state.charts.mark?.type || 'Comparison'} chart`,runId:currentRun().id,spec:state.charts,svg,filters:{query:state.query},mapViewpoint:map?.capture() || state.mapCamera}));
    }
    if(action==='capture')return task(async()=>{const saved=await add('snapshot',captureBody(getContext().bundle,false));state.snapshotId=saved.id;});
    if(action==='collect')return task(async()=>{
      const context=getContext();if(context.bundle.workspace.id!==PUBLIC_WORKSPACE_ID)throw new Error('Complete public collection is available in the United States public workspace. Capture imported workspaces separately.');
      const all=[];function walk(c){if(typeof c[0]==='number')all.push(c);else c.forEach(walk);}walk(currentStudy().aoi.coordinates);
      const bounds=[Math.min(...all.map(p=>p[0])),Math.min(...all.map(p=>p[1])),Math.max(...all.map(p=>p[0])),Math.max(...all.map(p=>p[1]))];
      collectionAbort=new AbortController();
      const bundle=await collectStudyAssets(context.bundle,bounds,{signal:collectionAbort.signal,onProgress:message=>{const n=host.querySelector('[data-job-status]');if(n)n.textContent=message;}});
      const saved=await add('snapshot',captureBody(bundle,true));state.snapshotId=saved.id;collectionAbort=null;
    });
  }

  function change(event) {
    const node=event.target;
    if(node.dataset.analysisLayer){if(node.checked)state.selectedLayers.add(node.dataset.analysisLayer);else state.selectedLayers.delete(node.dataset.analysisLayer);return render();}
    if(node.name?.startsWith('feature-')){state.featureFilters[node.name.slice(8)]=node.value;return;}
    if(node.name?.startsWith('metric-')){state.layerMetrics[node.name.slice(7)]=node.value;return render();}
    if(node.name==='sourceId'){state.sourceId=node.value;const n=host.querySelector('[data-source-parameters]');if(n)n.innerHTML=sourceParameters(node.value);return;}
    if(node.name==='studyPicker')return task(async()=>{if(!node.value){state.loaded=null;return;}state.loaded=await api(`/studies/${node.value}`);state.boundary=currentStudy().aoi;state.snapshotId=entities('snapshot').at(-1)?.id||'';state.selectedLayers.clear();state.activeRunId='';state.mapCamera=null;try{localStorage.setItem('geobound.analysis-study',node.value);}catch{}});
    if(node.name==='activeRun'){state.activeRunId=node.value;const record=currentRun();state.snapshotId=record?.inputs.parameters.snapshotId || state.snapshotId;state.query='';state.chartFilter=null;state.chartSettings=null;state.charts=null;return render();}
    if(node.name==='pilot'){const b=node.value==='current'?getContext().bounds:PILOTS[node.value]?.bounds;if(b){host.querySelector('[name="bounds"]').value=b.join(', ');state.boundary=boundsPolygon(b);state.mapCamera=null;map?.focus(state.boundary);}return;}
    if(node.hasAttribute('data-analysis-query')){state.query=node.value;return render();}
    if(node.hasAttribute('data-analysis-cutoff')){state.replayAt=node.value?new Date(node.value+'Z').toISOString():snapshot()?.capturedAt;return render();}
    if(node.hasAttribute('data-analysis-camera-radius')){state.cameraRadius=Math.min(10000,Math.max(1,Number(node.value)));return render();}
    if(node.hasAttribute('data-analysis-replay')){state.replayIndex=Number(node.value);const ordered=[...entities('snapshot')].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));state.snapshotId=ordered[state.replayIndex]?.id || '';state.replayAt=ordered[state.replayIndex]?.capturedAt;return render();}
  }

  return {
    mount(node) { if(host!==node){host=node;host.addEventListener('submit',submit);host.addEventListener('click',click);host.addEventListener('change',change);}if(!host.querySelector('.analysis-workbench'))render();if(!state.attempted)void connect(); },
    sourceStatusHTML() { return `<section class="panel analysis-source-summary"><div class="panel-title"><h2>Analytical sources</h2></div><div class="analysis-form"><p>${state.health?'Analytical service connected':'Open Analysis to connect to the service.'}</p>${table(entities('sourceHealth'),[['id','Source'],['status','Status'],['lastSuccessAt','Last success'],['error','Latest error']])}<a class="text-button" href="#analysis">Open resilience workbench</a></div></section>`; },
    captureIfActive,
    leave() { stopMedia();map?.dispose();map=null;chartView?.finalize();chartView=null;++requestEpoch;++mapEpoch; },
  };
}
