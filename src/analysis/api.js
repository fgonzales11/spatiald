export const ANALYSIS_TABS = ['Exposure', 'Replay', 'Scenarios', 'PV', 'EV Forecasts', 'Charts', 'Reviews'];
export const PILOTS = {
  tampa: { name: 'Tampa Bay', bounds: [-82.60, 27.85, -82.32, 28.08] },
  losAngeles: { name: 'Los Angeles County', bounds: [-118.67, 33.70, -117.65, 34.82] },
};

export function boundsPolygon([w, s, e, n]) {
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) throw new Error('Provide valid west, south, east, north bounds.');
  return { type: 'Polygon', coordinates: [[[w,s], [e,s], [e,n], [w,n], [w,s]]] };
}

export async function analysisRequest(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`/api/analysis${path}`, { method, signal,
    ...(body instanceof FormData ? { body } : body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : value.error || 'Analysis request failed.');
  return value;
}

export async function analysisUpload(file, { studyId, metadata = {}, purpose = 'dataset', resumable = false, signal } = {}) {
  if (resumable && file.size > 24 * 1024 ** 2) {
    const session = await analysisRequest('/upload-sessions', { method: 'POST', signal,
      body: { studyId, filename: file.name, size: file.size, metadata, purpose } });
    const response = await fetch(session.uploadUrl, { method: 'PUT', body: file, signal, credentials: 'omit',
      headers: { 'Content-Type': 'application/octet-stream' } });
    if (!response.ok) throw new Error('Dataset upload failed. Please retry.');
    return analysisRequest(`/upload-sessions/${session.id}/complete`, { method: 'POST', signal });
  }
  const body = new FormData(); body.append('file', file);
  if (purpose === 'dataset') body.append('metadata', JSON.stringify(metadata));
  return analysisRequest(purpose === 'package' ? '/packages/import' : `/upload/${studyId}`, { method: 'POST', body, signal });
}

export async function waitForAnalysisJob(job, { signal, onProgress = () => {} } = {}) {
  while (['queued', 'running', 'cancelling'].includes(job.status)) {
    onProgress(job);
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timeout = setTimeout(done, 750);
      function done() { signal?.removeEventListener('abort', abort); resolve(); }
      function abort() { clearTimeout(timeout); reject(signal.reason); }
      signal?.addEventListener('abort', abort, { once: true });
    });
    job = await analysisRequest(`/jobs/${job.id}`, { signal });
  }
  if (job.status !== 'completed') throw new Error(job.error || `Analysis ${job.status}.`);
  return job;
}

export function downloadBlob(blob, name) {
  const href = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = href; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
