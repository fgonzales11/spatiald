import {environmentPreferences} from '../spatial/environment-settings.js';
export function renderEnvironmentControls(state) {
  if (state.mapMode !== "3d") return "";
  const {cloudsEnabled,cloudCoverage}=environmentPreferences(state.environment);
  return `<div class="environment-heading layers-heading"><strong>Atmosphere</strong></div>
<div id="environment-options">
  <label class="environment-toggle"><input id="clouds-enabled" type="checkbox" aria-label="Clouds" ${cloudsEnabled?'checked':''}><span>Clouds</span><small>Low quality</small></label>
  <label class="cloud-coverage" for="cloud-coverage"><span>Cloud coverage</span><output id="cloud-coverage-value">${Math.round(cloudCoverage*100)}%</output></label>
  <input id="cloud-coverage" type="range" aria-label="Cloud coverage" min="0" max="1" step="0.05" value="${cloudCoverage}" ${cloudsEnabled?'':'disabled'}>
  <p class="layer-foot">Illustrative atmosphere over Google Photorealistic 3D Tiles.</p>
</div>`;
}
