import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { HIGHWAY_CAMERAS } from '../src/data/highway-cameras.js';

export function createAnalysisMiddleware({ endpoint = process.env.ANALYSIS_URL || 'http://127.0.0.1:5181', fetchImpl = fetch } = {}) {
  let caltrans;
  async function catalog() {
    if (!caltrans) {
      try { caltrans = JSON.parse(await readFile(new URL('../data/camera-catalogs/caltrans-camera-feeds.json', import.meta.url), 'utf8')).cameras; }
      catch { caltrans = []; }
    }
    return caltrans;
  }
  return async (req, res, next) => {
    const request = new URL(req.url, 'http://localhost');
    if (!request.pathname.startsWith('/api/analysis/')) return next();
    const failure = (status, detail) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); if (!res.destroyed) res.end(JSON.stringify({ detail })); };
    try {
      if (request.pathname === '/api/analysis/cameras') {
        if (req.method !== 'GET') return failure(405, 'Only GET is supported');
        const cameras = [
          ...HIGHWAY_CAMERAS.features.map(f => ({ id: `fdot-${f.properties.id}`, provider: 'FDOT', name: f.properties.name, longitude: f.geometry.coordinates[0], latitude: f.geometry.coordinates[1], direction: f.properties.direction,
            inService: true, videoAvailable: f.properties.videoAvailable, stream: `/api/highway-cameras/${f.properties.id}/stream`, snapshot: f.properties.snapshotUrl ? `/api/highway-cameras/${f.properties.id}/snapshot` : null, sourceUrl: 'https://fl511.com/' })),
          ...(await catalog()).map(c => ({ id: `caltrans-${c.id}`, provider: 'Caltrans', name: c.name, longitude: c.longitude, latitude: c.latitude, direction: c.direction, inService: c.inService, sourceUpdatedAt: c.sourceUpdatedAt,
            videoAvailable: Boolean(c.videoUrl), stream: `/api/analysis/caltrans/${encodeURIComponent(c.id)}/stream`, snapshot: c.snapshotUrl ? `/api/analysis/caltrans/${encodeURIComponent(c.id)}/snapshot` : null, sourceUrl: c.quickmapUrl })),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(cameras));
      }
      const match = /^\/api\/analysis\/caltrans\/([^/]+)\/(stream|snapshot)$/.exec(request.pathname);
      if (match) {
        if (req.method !== 'GET') return failure(405, 'Only GET is supported');
        const camera = (await catalog()).find(c => String(c.id) === decodeURIComponent(match[1]));
        if (!camera) return failure(404, 'Camera not found');
        const address = match[2] === 'snapshot' ? camera.snapshotUrl : camera.videoUrl;
        if (!address) return failure(404, 'Camera resource not available');
        const base = new URL(address), directory = new URL('.', base).pathname;
        const upstream = new URL(request.searchParams.get('path') || base.href, base);
        const allowed = u => u.protocol === 'https:' && u.origin === base.origin && u.pathname.startsWith(directory) && !u.username && !u.password;
        if (!allowed(upstream) || (match[2] === 'snapshot' && request.searchParams.has('path'))) return failure(400, 'Invalid camera resource');
        const response = await fetchImpl(upstream, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) return failure(502, 'Provider camera unavailable');
        const type = response.headers.get('content-type') || 'application/octet-stream';
        if (match[2] === 'snapshot' && !type.startsWith('image/')) return failure(502, 'Invalid provider image');
        let body;
        if (/\.m3u8$/i.test(upstream.pathname)) {
          const text = await response.text();
          if (!text.startsWith('#EXTM3U')) return failure(502, 'Invalid provider playlist');
          const rewrite = uri => {
            const url = new URL(uri, upstream);
            if (!allowed(url)) throw new Error('Playlist resource outside camera directory');
            return `${request.pathname}?path=${encodeURIComponent(url.pathname + url.search)}`;
          };
          body = text.split(/\r?\n/).map(line => !line.trim() ? line : line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`) : rewrite(line.trim())).join('\n');
        } else {
          body = Buffer.from(await response.arrayBuffer());
          if (body.length > 20 * 1024 * 1024) return failure(502, 'Camera resource exceeds size limit');
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(body);
      }
      const upstream = new URL(request.pathname + request.search, endpoint);
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnected);
      try {
        const headers = {};
        for (const name of ['content-type', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];
        const response = await fetchImpl(upstream, { method: req.method, headers, signal: controller.signal,
          ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
        const outputHeaders = { 'Cache-Control': 'no-store' };
        for (const name of ['content-type', 'content-disposition']) if (response.headers.has(name)) outputHeaders[name] = response.headers.get(name);
        res.writeHead(response.status, outputHeaders);
        if (response.body) await new Promise((resolve, reject) => { const stream = Readable.fromWeb(response.body); stream.on('error', reject); res.on('finish', resolve); res.on('close', resolve); stream.pipe(res); });
        else res.end();
      } finally { res.off('close', disconnected); }
    } catch { failure(503, 'Local analysis service is unavailable. Start it with npm run analysis:serve or Docker Compose, then reconnect.'); }
  };
}
