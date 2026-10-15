export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// Keep workspace labels current for names already saved in browser storage.
export const workspaceLabel = (workspace) =>
  workspace.name.replaceAll("Tampa Bay", "United States");

const paths = {
  "map-flat": "m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5zM9 3v16M15 5v16",
  "map-tron": "m2 19 5-9h10l5 9H2zM7 10l5 9 5-9M5 14h14M12 10V3m-4 3 4-3 4 3",
  "map-cube": "m12 2 9 5v10l-9 5-9-5V7l9-5zM3 7l9 5 9-5M12 12v10",
  camera: "M3 6h12v12H3zM15 10l6-4v12l-6-4",
  layers: "m12 3 10 5-10 5L2 8l10-5zM2 12l10 5 10-5M2 16l10 5 10-5",
  globe:
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c5 6 5 14 0 20-5-6-5-14 0-20",
  assets: "M4 3h16v18H4zM8 7h8M8 11h8M8 15h5",
  chart: "M3 3v18h18M6 15l4-6 4 4 6-9",
  source:
    "M20 6c0 2-16 2-16 0s16-2 16 0M4 6v12c0 3 16 3 16 0V6M4 12c0 3 16 3 16 0",
  settings:
    "m12 3 2 3 4-1 1 4 3 3-3 3-1 4-4-1-2 3-2-3-4 1-1-4-3-3 3-3 1-4 4 1 2-3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M20 14A8 8 0 0 1 10 4 8 8 0 1 0 20 14",
  target: "M12 2v4m0 12v4M2 12h4m12 0h4M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  pin: "M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 0 1 14 0M14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  download: "M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5",
  upload: "M12 15V3m-5 5 5-5 5 5M3 16v5h18v-5",
  network: "M12 3v6m0 0-7 5m7-5 7 5M5 14v7m14-7v7M2 21h6m8 0h6M9 3h6",
  check: "m5 12 4 4 10-10",
  alert: "m12 3 10 18H2L12 3zm0 6v5m0 3v1",
  info: "M12 11v6m0-10v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  bolt: "m13 2-9 12h7l-1 8 10-13h-8l1-7",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
};
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.info}"/></svg>`;
export const pretty = (value) =>
  String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export function dateLabel(value, timezone, compact = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    ...(compact
      ? {}
      : { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
  }).format(new Date(value));
}
export const badge = (value, cls = "") =>
  `<span class="badge ${esc(cls)}">${esc(value)}</span>`;

export function trendSVG(
  observations,
  series,
  timezone,
  { compact = false } = {},
) {
  const values = observations.filter((o) => o.value !== null);
  if (!values.length)
    return '<div class="empty small">No numeric observations in this series.</div>';
  const w = 640,
    h = compact ? 130 : 245,
    left = 48,
    right = 18,
    top = 22,
    bottom = 38;
  const low = Math.min(...values.map((o) => o.value)),
    high = Math.max(...values.map((o) => o.value));
  const pad = Math.max((high - low) * 0.2, Math.abs(high) * 0.025, 1);
  const min = low - pad,
    max = high + pad;
  const start = Date.parse(observations[0].observedAt),
    end = Date.parse(observations.at(-1).observedAt);
  const x = (t) =>
    left + ((t - start) / Math.max(end - start, 1)) * (w - left - right);
  const y = (v) => top + ((max - v) / (max - min)) * (h - top - bottom);
  let path = "",
    open = false,
    previous = null;
  for (const o of observations) {
    const t = Date.parse(o.observedAt);
    if (o.value === null) {
      open = false;
      previous = t;
      continue;
    }
    if (
      previous !== null &&
      series.sampleIntervalSeconds &&
      t - previous > series.sampleIntervalSeconds * 1500
    )
      open = false;
    path += `${open ? "L" : "M"}${x(t).toFixed(1)},${y(o.value).toFixed(1)} `;
    open = true;
    previous = t;
  }
  const marks = [0, 0.25, 0.5, 0.75, 1];
  const label = (t) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(t);
  return `<svg class="trend" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(series.quantity)} historical chart in ${esc(series.unit)}${series.phase ? `, phase ${esc(series.phase)}` : ""}. Missing values are gaps.">
    ${marks.map((f) => `<path class="gridline" d="M${left},${top + f * (h - top - bottom)}H${w - right}"/><text x="${left - 9}" y="${top + f * (h - top - bottom) + 4}" text-anchor="end">${(max - f * (max - min)).toFixed(1)}</text>`).join("")}
    <path class="trend-line" d="${path}"/>
    ${marks.map((f) => `<text x="${left + f * (w - left - right)}" y="${h - 12}" text-anchor="middle">${esc(label(start + f * (end - start)))}</text>`).join("")}
    <text x="${left}" y="12">${esc(series.unit)}</text>
  </svg>`;
}

export function downloadText(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
