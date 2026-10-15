// Google Maps JavaScript uses a browser key. Resolve only that named setting at runtime;
// other Site secrets are never included in this configuration endpoint.
export async function googleMapsKey(fallback='',fetchImpl=fetch) {
  try {
    const response=await fetchImpl('/api/map-config',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!response.ok)return fallback;
    const value=await response.json();
    return typeof value.googleMapsApiKey==='string'&&value.googleMapsApiKey.trim()?value.googleMapsApiKey.trim():fallback;
  }catch{return fallback;}
}
