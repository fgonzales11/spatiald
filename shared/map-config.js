// This is a browser credential, delivered at runtime, never a server API proxy.
// Restrict it in Google Cloud to this website and the Maps JavaScript API.
export function mapConfig(env = {}) {
  const key = [env.GOOGLE_API_KEY, env.VITE_GOOGLE_MAPS_API_KEY]
    .find(value => typeof value === 'string' && value.trim());
  return { googleMapsApiKey: key?.trim() || '' };
}
