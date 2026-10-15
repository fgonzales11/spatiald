import { downloadBlob } from './api.js';

export function chartSpecification(rows, { type = 'bar', x = 'assetType', y = 'lengthM', color = '', unit = '', aggregate = 'none', numerator, denominator } = {}) {
  if (!rows.length) throw new Error('This dataset has no rows to plot.');
  if (y === 'value' && new Set(rows.map(r=>r.unit).filter(Boolean)).size > 1) throw new Error('Filter to one measurement unit before plotting values.');
  if (aggregate === 'sum' && /median|rate|share|saidi|saifi/i.test(y)) throw new Error('Rates, reliability indices, and medians cannot be summed. Use a count-based rate or show individual values.');
  let data = rows;
  if (aggregate === 'ratio') {
    if (!numerator || !denominator) throw new Error('Select numerator and denominator fields for the rate.');
    const groups = new Map();
    for (const row of rows) {
      const key = String(row[x]);
      if (row[numerator] === null || row[denominator] === null || !Number.isFinite(Number(row[numerator])) || !Number.isFinite(Number(row[denominator]))) continue;
      const group = groups.get(key) || { [x]: row[x], numerator: 0, denominator: 0 };
      group.numerator += Number(row[numerator]); group.denominator += Number(row[denominator]); groups.set(key, group);
    }
    data = [...groups.values()].map(r => ({ ...r, rate: r.denominator > 0 ? r.numerator / r.denominator : null }));
    y = 'rate';
  }
  const quantitative = field => data.some(r => typeof r[field] === 'number');
  const fieldType = field => quantitative(field) ? 'quantitative' : data.some(r => /^\d{4}-\d{2}-\d{2}T/.test(String(r[field]))) ? 'temporal' : 'nominal';
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 'container', height: 300,
    background: 'transparent', data: { values: data },
    config: { axis: { labelColor: '#88a2b3', titleColor: '#88a2b3', gridColor: '#253a4b' }, legend: { labelColor: '#88a2b3', titleColor: '#88a2b3' }, view: { stroke: null } },
    params: [{ name: 'assetSelection', select: { type: 'point', fields: [aggregate==='none' && data.some(r=>r.assetId) ? 'assetId' : x] } }],
    encoding: { x: { field: x, type: fieldType(x) }, y: { field: y, type: 'quantitative', title: `${y}${unit ? ` (${unit})` : ''}`, ...(aggregate === 'sum' ? { aggregate: 'sum' } : {}) },
      tooltip: [{ field: x, type: fieldType(x) }, { field: y, type: 'quantitative' }, { field: 'assetId', type: 'nominal' }] },
    mark: { type: type === 'time-series' || type === 'forecast-band' ? 'line' : type === 'scatter' ? 'point' : 'bar', color: '#38c6ed', tooltip: true,
      ...(['time-series','forecast-band'].includes(type) ? { invalid: 'break-paths-show-domains' } : {}) },
  };
  if (color) spec.encoding.color = { field: color, type: 'nominal' };
  if (['time-series','forecast-band'].includes(type) && data.some(r=>'scenario' in r)) spec.encoding.detail = [{field:'scenario',type:'nominal'},{field:'vehicle',type:'nominal'}];
  if (type === 'histogram') {
    spec.encoding = { x: { field: y, type: 'quantitative', bin: true, title: `${y} (${unit || 'original units'})` }, y: { aggregate: 'count', title: 'Records' } };
  }
  if (type === 'forecast-band') {
    spec.layer = [
      { mark: { type: 'area', opacity: .15, color: '#38c6ed' }, encoding: { ...spec.encoding, y: { field: 'lower', type: 'quantitative' }, y2: { field: 'upper' } } },
      { mark: { type: 'line', color: '#38c6ed', tooltip: true, invalid: 'break-paths-show-domains' }, encoding: spec.encoding },
    ];
    delete spec.mark; delete spec.encoding;
  }
  if (type === 'scenario-difference') {
    spec.transform = [{ fold: ['baseline', 'alternative'], as: ['scenario', 'count'] }];
    spec.encoding.y = { field: 'count', type: 'quantitative', title: 'Exposed assets' };
    spec.encoding.xOffset = { field: 'scenario' }; spec.encoding.color = { field: 'scenario', type: 'nominal' };
  }
  return spec;
}

export async function mountChart(host, spec, onSelect) {
  const { default: embed } = await import('vega-embed');
  const result = await embed(host, spec, { actions: false, renderer: 'svg' });
  result.view.addSignalListener('assetSelection', (_name, value) => {
    const field=spec.params?.[0]?.select.fields?.[0];
    const values=value?.[field];
    if(values?.length)onSelect?.(field==='assetId'?values[0]:{field,values});
  });
  return result.view;
}

export async function exportChart(view, format) {
  if (!view) throw new Error('Generate a chart first.');
  if (format === 'svg') downloadBlob(new Blob([await view.toSVG()], { type: 'image/svg+xml' }), 'geobound-chart.svg');
  else {
    const url = await view.toImageURL('png', 2);
    downloadBlob(await (await fetch(url)).blob(), 'geobound-chart.png');
  }
}
