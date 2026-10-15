export const TRON_DEFAULTS = Object.freeze({transit:true, buildings:true, animated:false, interactive:true});
export function tronPreferences(value) {
  return Object.fromEntries(Object.entries(TRON_DEFAULTS).map(([key,fallback])=>[key,key==='animated'?false:typeof value?.[key]==='boolean'?value[key]:fallback]));
}
// Apply in place: settings must not reload the circuit or replace the map style.
export function applyTronSettings(map, value) {
  const settings=tronPreferences(value);
  for(const id of ['tron-transit','tron-transit-glow'])if(map.getLayer(id))map.setLayoutProperty(id,'visibility',settings.transit?'visible':'none');
  if(map.getLayer('tron-buildings'))map.setLayoutProperty('tron-buildings','visibility',settings.buildings?'visible':'none');
  for(const key of ['dragPan','dragRotate','scrollZoom','boxZoom','keyboard','doubleClickZoom','touchZoomRotate','touchPitch'])map[key]?.[settings.interactive?'enable':'disable']();
  const host=map.getContainer();
  for(const [key,value]of Object.entries(settings))host.dataset['tron'+key[0].toUpperCase()+key.slice(1)+'Enabled']=String(value);
  map.getCanvas().setAttribute('aria-label',`${settings.interactive?'Interactive':'Read-only'} TRON utility network map. Search or use the asset inventory for keyboard inspection.`);
  return settings;
}
