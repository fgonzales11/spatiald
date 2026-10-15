import { mapConfig } from '../shared/map-config.js';

export function createMapConfigMiddleware(env = process.env) {
  return (req, res, next) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/map-config') return next();
    const allowed = req.method === 'GET';
    res.writeHead(allowed ? 200 : 405, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...(allowed ? {} : { Allow: 'GET' }),
    });
    res.end(JSON.stringify(allowed ? mapConfig(env) : { detail: 'Only GET is supported' }));
  };
}
