import { Popup } from 'maplibre-gl';
import { createSolarPvPopup } from '../components/solar-pv.js';

export const SOLAR_PV_LAYER_IDS = ['tb-pv-buildings', 'tb-pv-outlines'];

export function createSolarPvLayer(map, { onStatus, idPrefix='tb-pv', dataFile='teco-pv-buildings.json',
  createPopup=createSolarPvPopup, underLayer } = {}) {
  const sourceId=`${idPrefix}-buildings-source`;
  const layerIds=[`${idPrefix}-buildings`,`${idPrefix}-outlines`];
  let data, loading, disposed = false, visible = true, popup;
  const abort = new AbortController();
  let sites = new Map(), features = new Map();
  const close = () => { popup?.remove(); popup = null; };
  function attach() {
    if(disposed || !data || !map.getLayer('tb-boundary')) return;
    if(!map.getSource(sourceId)) map.addSource(sourceId,{type:'geojson',data:data.buildings});
    const before = underLayer && map.getLayer(underLayer) ? underLayer : map.getLayer('tb-area') ? 'tb-area' : undefined;
    for(const layer of [
      {id:layerIds[0],type:'fill',source:sourceId,minzoom:13,
        paint:{'fill-color':['get','color'],'fill-opacity':0.94}},
      {id:layerIds[1],type:'line',source:sourceId,minzoom:13,
        paint:{'line-color':['get','color'],'line-width':1,'line-opacity':0.95}},
    ]) if(!map.getLayer(layer.id)) map.addLayer({...layer,layout:{visibility:visible ? 'visible':'none'}},before);
  }
  async function load() {
    if(data) { attach(); return; }
    if(loading || disposed) return;
    onStatus?.({status:'loading'});
    loading = (async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}data/solar/${dataFile}`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(20000)])});
        if(!response.ok) throw new Error(`Public solar data could not load (${response.status}).`);
        const value = await response.json();
        if(value.schemaVersion !== 1 || value.sites.length !== value.summary.totalSites || value.siteMatches.length !== value.sites.length)
          throw new Error('Public solar data is incomplete.');
        if(disposed) return;
        data = value;
        sites = new Map(data.sites.map(site => [site.site_id,site]));
        features = new Map(data.buildings.features.map(feature => [feature.properties.key,feature]));
        const bounds = data.summary.osmBounds;
        attach();
        onStatus?.({status:'ready',summary:data.summary,bounds});
      } catch(error) {
        if(!disposed) onStatus?.({status:'error',error:error.message || 'Public solar data could not load.'});
      } finally { loading = null; }
    })();
    await loading;
  }
  function setVisible(value) {
    visible = value !== false;
    for(const id of layerIds) if(map.getLayer(id) && map.getLayoutProperty(id,'visibility') !== (visible ? 'visible':'none')) map.setLayoutProperty(id,'visibility',visible ? 'visible':'none');
    if(!visible) close();
  }
  return {
    attach() { attach(); void load(); },
    setVisible,
    retry:load,
    layerIds:() => layerIds.filter(id => map.getLayer(id)),
    show(rendered, lngLat) {
      if(!visible) return false;
      const feature = features.get(rendered.properties.key);
      if(!feature) return false;
      close();
      popup = new Popup({maxWidth:'340px',className:'solar-pv-map-popup'})
        .setLngLat(lngLat).setDOMContent(createPopup(feature,sites,{onZoom:center => map.easeTo({center,zoom:17,duration:350})})).addTo(map);
      return true;
    },
    close,
    dispose() { disposed = true; abort.abort(); close(); },
  };
}
