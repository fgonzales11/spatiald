import {
  assetNetworks,
  connectedAssets,
  assetEvents,
} from "../domain/model.js";
import { icon, esc, pretty, badge, dateLabel, trendSVG } from "./ui.js";
import { lineHeightNote } from '../spatial/line-elevation.js';

export function renderInspector(bundle, asset, { section = "spatial" } = {}) {
  if (!asset)
    return `<div class="inspector-empty">${icon("pin")}<h2>Every asset has a place.</h2><p>Select an asset on the map or search the network to explore its details and connections.</p><button data-action="browse-assets" class="text-button">Browse asset inventory ${icon("arrow")}</button></div>`;
  const connected = connectedAssets(bundle, asset.id);
  const networks = assetNetworks(bundle, asset.id);
  const terminals = bundle.terminals.filter((t) => t.assetId === asset.id);
  const topologyAvailable = terminals.some((t) => t.nodeId);
  const dataset = bundle.datasets.find((d) => d.id === asset.datasetId);
  const source = bundle.sources.find((s) => s.id === dataset?.sourceId);
  const series = bundle.series.filter((s) => s.assetId === asset.id);
  const first = series[0];
  const observations = first
    ? bundle.observations
        .filter((o) => o.seriesId === first.id)
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    : [];
  const events = assetEvents(bundle, asset.id);
  return `<div class="inspector-heading"><div><div class="eyebrow">${esc(asset.utilityType)} · ${esc(pretty(asset.assetType))}</div><h2>${esc(asset.name)}</h2></div><button class="icon-button" data-action="clear-selection" aria-label="Close asset inspector">${icon("close")}</button></div>
    <div class="inspector-body">
      <div class="asset-status">${badge(pretty(dataset?.isRemote ? asset.attributes.publishedStatus || "unknown" : asset.status), asset.status)}${dataset?.isRemote ? badge("Public source") : dataset?.isSynthetic ? badge("Synthetic", "demo") : badge("Imported")}</div>
      ${dataset?.isRemote ? '<p class="small muted">Published reference geometry and status. Live telemetry and explicit network topology are not supplied.</p>' : ""}
      <dl class="detail-list"><dt>Asset ID</dt><dd class="mono">${esc(asset.id)}</dd><dt>Source ID</dt><dd class="mono">${esc(asset.externalId)}</dd><dt>Network</dt><dd>${networks.map((n) => esc(n.name)).join("<br>") || "Unassigned"}</dd></dl>
      ${section !== "spatial" ? `<button class="secondary full" data-focus="${esc(asset.id)}">${icon("pin")} Locate on map</button>` : ""}
      ${lineHeightNote(asset) ? `<section class="inspector-section"><h3>3D display height</h3><p class="small muted">${esc(lineHeightNote(asset))}</p></section>` : ""}
      <section class="inspector-section"><h3>Asset attributes</h3><dl class="detail-list">${
        Object.entries(asset.attributes)
          .filter(([key]) => key !== "sourceAttributes")
          .map(
            ([key, value]) =>
              `<dt>${esc(
                key
                  .replace(/([A-Z])/g, " $1")
                  .replace(/\bV$/, "(V)")
                  .replace(/\bKva$/, "(kVA)"),
              )}</dt><dd>${esc(Array.isArray(value) ? value.join(" · ") : typeof value === "object" ? JSON.stringify(value) : value)}</dd>`,
          )
          .join("") || "<dt>Attributes</dt><dd>Not supplied</dd>"
      }</dl>${
        asset.attributes.sourceAttributes
          ? `<details class="source-record"><summary>Original source attributes</summary><dl class="detail-list">${Object.entries(
              asset.attributes.sourceAttributes,
            )
              .map(
                ([key, value]) =>
                  `<dt>${esc(key)}</dt><dd>${esc(value ?? "Not supplied")}</dd>`,
              )
              .join("")}</dl></details>`
          : ""
      }</section>
      <section class="inspector-section"><div class="section-label"><h3>Recorded connectivity</h3>${badge(`${connected.length} adjacent`)}</div><p class="small muted">${topologyAvailable ? "Connections from supplied terminals and nodes." : "Connectivity unavailable. Geometry does not establish a connection."}</p>
        ${terminals.map((t) => `<div class="terminal-row"><span>${esc(t.label)}</span><span class="mono">${esc(t.nodeId || "Unconnected")}</span></div>`).join("")}
        <div class="connected-list">${connected
          .slice(0, 12)
          .map(
            (a) =>
              `<button data-select="${esc(a.id)}">${icon(a.assetType.includes("line") || a.assetType.includes("cable") ? "network" : "bolt")}<span>${esc(a.name)}<small>${esc(pretty(a.assetType))}</small></span>${icon("chevron")}</button>`,
          )
          .join("")}</div>
        ${connected.length > 12 ? `<p class="small muted">${connected.length - 12} additional recorded connections.</p>` : ""}
      </section>
      <section class="inspector-section"><div class="section-label"><h3>Measurement history</h3>${first ? badge(first.unit) : ""}</div>
        ${first ? `<p class="small muted">${esc(first.quantity)}${first.phase ? ` · Phase ${esc(first.phase)}` : ""} · ${dateLabel(observations[0]?.observedAt, bundle.workspace.timezone, true)}</p>${trendSVG(observations, first, bundle.workspace.timezone, { compact: true })}<button class="text-button" data-measure="${esc(asset.id)}">Explore ${series.length} series ${icon("arrow")}</button>` : '<p class="small muted">No measurement series supplied for this asset.</p>'}
      </section>
      ${events.length ? `<section class="inspector-section"><h3>Historical events</h3>${events.map((e) => `<div class="event"><div>${badge(e.type, e.severity)}<small>${esc(e.status)}</small></div><p>${esc(e.description)}</p><time>${dateLabel(e.startedAt, bundle.workspace.timezone)}</time></div>`).join("")}</section>` : ""}
      <section class="inspector-section provenance"><h3>Source provenance</h3><p>${esc(source?.name || "Unknown source")}</p><p class="small muted">${esc(dataset?.name)} · v${esc(dataset?.version)}</p><p class="small muted">Acquired ${dateLabel(dataset?.acquiredAt, bundle.workspace.timezone)}</p>${dataset?.sourceUpdatedAt ? `<p class="small muted">Source metadata update: ${esc(dataset.sourceUpdatedAt.slice(0, 10))}</p>` : ""}${source?.location?.startsWith("https://") ? `<a class="text-button" href="${esc(source.location)}" target="_blank" rel="noopener noreferrer">Open source ${icon("arrow")}</a>` : ""}<p class="small muted">WGS84 · elevation ${asset.geometry.coordinates?.length === 3 && asset.geometry.type === "Point" ? "supplied" : "not supplied"}</p></section>
    </div>`;
}
