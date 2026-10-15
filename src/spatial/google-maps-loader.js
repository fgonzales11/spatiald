let loading;
let authHookInstalled = false;
const authListeners = new Set();
const AUTH_ERROR = 'Google Maps rejected map access. Check billing, Maps JavaScript API access, and the website restrictions for this site.';

export function onGoogleAuthFailure(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

// Share one SDK load across map-mode switches. Failed loads can be retried.
export function loadGoogleMaps3D(apiKey) {
  if (!apiKey?.trim()) return Promise.reject(new Error('Google photorealistic 3D needs a configured GOOGLE_API_KEY.'));
  if (loading) return loading;
  if (!authHookInstalled) {
    authHookInstalled = true;
    const previousAuthFailure = window.gm_authFailure;
    window.gm_authFailure = () => {
      for (const listener of authListeners) listener(AUTH_ERROR);
      previousAuthFailure?.();
    };
  }
  loading = (async () => {
    if (!window.google?.maps?.importLibrary) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const callback = '__geoboundGoogleMapsReady';
        const params = new URLSearchParams({ key: apiKey.trim(), v: 'weekly', loading: 'async', callback });
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          script.onerror = null;
          // Keep the callback callable if a slow request returns after timeout.
          window[callback] = () => {};
          if (error) { script.remove(); reject(new Error(error)); }
          else resolve();
        };
        const unsubscribe = onGoogleAuthFailure(finish);
        const timeout = setTimeout(() => finish('Google Maps did not load. Check your connection and retry 3D.'), 20000);
        window[callback] = () => finish();
        script.async = true;
        script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        script.onerror = () => finish('Google Maps could not connect. Check your connection or content blocker and retry 3D.');
        document.head.append(script);
      });
    }
    // This is Google's photorealistic mesh renderer, not google.maps.Map with tilt.
    let timer;
    const library = await Promise.race([
      window.google.maps.importLibrary('maps3d'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Google 3D library did not load. Check your connection and retry 3D.')), 20000); }),
    ]).finally(() => clearTimeout(timer));
    if (!library.Map3DElement) throw new Error('Google photorealistic 3D is unavailable. Reload and retry.');
    return library;
  })().catch(error => { loading = null; throw error; });
  return loading;
}
