import {
  assertBundle,
  boundsOf,
  validateBundle,
  isTimestamp,
} from "../domain/model.js";

export function parseCSV(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    afterQuote = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        afterQuote = true;
      } else if (c === undefined)
        throw new Error("CSV contains an unclosed quoted field.");
      else field += c;
      continue;
    }
    if (afterQuote && c !== "," && c !== "\n" && c !== "\r" && c !== undefined)
      throw new Error("CSV has characters after a closing quote.");
    if (c === '"') {
      if (field) throw new Error("CSV quote must start a field.");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r" || c === undefined) {
      row.push(field);
      field = "";
      afterQuote = false;
      if (c !== ",") {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else field += c;
  }
  if (rows.length < 2)
    throw new Error("CSV must include a header and at least one data row.");
  const headers = rows.shift().map((h) => h.trim());
  if (new Set(headers).size !== headers.length)
    throw new Error("CSV has duplicate column names.");
  return rows.map((values, index) => {
    if (values.length !== headers.length)
      throw new Error(
        `CSV row ${index + 2}: expected ${headers.length} columns.`,
      );
    return {
      rowNumber: index + 2,
      ...Object.fromEntries(headers.map((h, i) => [h, values[i].trim()])),
    };
  });
}

export function fingerprint(bundle) {
  const input = JSON.stringify(bundle);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${input.length}:${hash >>> 0}`;
}

const makeId = () => globalThis.crypto.randomUUID();
function sourceForFile(id, name, format) {
  return {
    id,
    name,
    custodian: "Local file import",
    categories: [
      format === "CSV"
        ? "Time-Series & Historical Data"
        : "Infrastructure & Operational Data",
    ],
    location: null,
    format,
    attribution: "User-supplied data",
    licenseUrl: "",
    authentication: "none",
    configurationState: "configured",
    adapterStatus: "implemented",
    description: "Imported into this browser. No remote data connection.",
  };
}

/** Pure preview: never writes. Each preview is bound to the workspace it was built against. */
export function previewImport({
  text,
  filename,
  current,
  id = makeId(),
  now = new Date().toISOString(),
}) {
  const errors = [];
  let candidate,
    kind,
    newWorkspace = false;
  try {
    if (text.length > 20 * 1024 * 1024)
      throw new Error("Import is limited to 20 MB.");
    if (filename.toLowerCase().endsWith(".csv")) {
      kind = "Observation CSV";
      if (!current)
        throw new Error("Open a workspace before importing observations.");
      candidate = structuredClone(current);
      const rows = parseCSV(text);
      const required = ["asset_id", "quantity", "unit", "observed_at", "value"];
      if (required.some((key) => !(key in rows[0])))
        throw new Error(`Required columns: ${required.join(", ")}.`);
      const assets = new Set(candidate.assets.map((a) => a.id));
      for (const row of rows) {
        if (!assets.has(row.asset_id)) {
          errors.push(
            `Row ${row.rowNumber}: unknown asset ${row.asset_id}. Use the internal asset ID shown in the inspector.`,
          );
          continue;
        }
        if (!row.quantity || !row.unit) {
          errors.push(`Row ${row.rowNumber}: quantity and unit are required.`);
          continue;
        }
        if (
          !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(row.observed_at) ||
          !isTimestamp(row.observed_at)
        ) {
          errors.push(
            `Row ${row.rowNumber}: timestamp must be valid and include a timezone.`,
          );
          continue;
        }
        const t = Date.parse(row.observed_at);
        if (!Number.isFinite(t)) {
          errors.push(`Row ${row.rowNumber}: invalid timestamp.`);
          continue;
        }
        const value = row.value === "" ? null : Number(row.value);
        if (value !== null && !Number.isFinite(value)) {
          errors.push(`Row ${row.rowNumber}: value must be numeric or blank.`);
          continue;
        }
        let series = candidate.series.find(
          (s) =>
            s.assetId === row.asset_id &&
            s.quantity === row.quantity &&
            s.unit === row.unit &&
            (s.phase || "") === (row.phase || ""),
        );
        if (!series) {
          series = {
            id: `series-${id}-${candidate.series.length}`,
            assetId: row.asset_id,
            datasetId: id,
            quantity: row.quantity,
            unit: row.unit,
            ...(row.phase ? { phase: row.phase } : {}),
          };
          candidate.series.push(series);
        }
        candidate.observations.push({
          seriesId: series.id,
          observedAt: new Date(t).toISOString(),
          value,
          quality: value === null ? "missing" : row.quality || "unknown",
          datasetId: id,
        });
      }
      candidate.sources.push(sourceForFile(`file-${id}`, filename, "CSV"));
      candidate.datasets.push({
        id,
        workspaceId: current.workspace.id,
        sourceId: `file-${id}`,
        name: filename,
        version: "1",
        acquiredAt: now,
        isSynthetic: false,
        bounds: boundsOf(current.assets),
        crs: "EPSG:4326",
        schemaVersion: 1,
      });
    } else {
      const input = JSON.parse(text);
      if (input.type === "FeatureCollection") {
        kind = "Asset GeoJSON";
        if (!current)
          throw new Error("Open a workspace before importing assets.");
        if (!Array.isArray(input.features) || !input.features.length)
          throw new Error("GeoJSON must contain at least one feature.");
        if (input.crs)
          throw new Error(
            "GeoJSON must use WGS84 longitude/latitude without a legacy CRS declaration.",
          );
        candidate = structuredClone(current);
        const added = input.features.map((feature, i) => {
          const p = feature.properties;
          if (
            feature.type !== "Feature" ||
            !p ||
            ["id", "name", "utilityType", "assetType"].some(
              (k) => typeof p[k] !== "string" || !p[k].trim(),
            )
          )
            throw new Error(
              `Feature ${i + 1}: id, name, utilityType, and assetType must be nonempty strings.`,
            );
          return {
            id: p.id,
            workspaceId: current.workspace.id,
            datasetId: id,
            externalId: p.externalId || p.id,
            utilityType: p.utilityType,
            assetType: p.assetType,
            name: p.name,
            geometry: feature.geometry,
            status: p.status || "unknown",
            attributes: p.attributes || {},
          };
        });
        candidate.assets.push(...added);
        candidate.sources.push(
          sourceForFile(`file-${id}`, filename, "GeoJSON"),
        );
        candidate.datasets.push({
          id,
          workspaceId: current.workspace.id,
          sourceId: `file-${id}`,
          name: filename,
          version: "1",
          acquiredAt: now,
          isSynthetic: false,
          bounds: boundsOf(added),
          crs: "EPSG:4326",
          schemaVersion: 1,
        });
      } else {
        kind = "Workspace JSON";
        newWorkspace = true;
        assertBundle(input);
        candidate = structuredClone(input);
        candidate.workspace.id = `workspace-${id}`;
        candidate.workspace.name = `${input.workspace.name} · imported`;
        for (const key of ["datasets", "networks", "assets", "nodes", "events"])
          for (const record of candidate[key])
            record.workspaceId = candidate.workspace.id;
      }
    }
    errors.push(...validateBundle(candidate).errors);
  } catch (error) {
    errors.push(error.message);
  }
  return {
    id,
    filename,
    kind: kind || "Unknown format",
    candidate: errors.length ? null : candidate,
    errors,
    newWorkspace,
    baseWorkspaceId: current?.workspace.id,
    baseFingerprint: current ? fingerprint(current) : null,
    summary: candidate
      ? {
          assets: newWorkspace
            ? candidate.assets.length
            : candidate.assets.length - current.assets.length,
          observations: newWorkspace
            ? candidate.observations.length
            : candidate.observations.length - current.observations.length,
          bounds: newWorkspace
            ? boundsOf(candidate.assets)
            : candidate.datasets.find((d) => d.id === id)?.bounds,
        }
      : null,
  };
}

export function withoutDataset(bundle, datasetId) {
  const next = structuredClone(bundle);
  const removedAssets = new Set(
    next.assets.filter((a) => a.datasetId === datasetId).map((a) => a.id),
  );
  const removedNodes = new Set(
    next.nodes.filter((n) => n.datasetId === datasetId).map((n) => n.id),
  );
  const removedTerminals = new Set(
    next.terminals.filter((t) => removedAssets.has(t.assetId)).map((t) => t.id),
  );
  const removedSeries = new Set(
    next.series
      .filter(
        (s) =>
          s.datasetId === datasetId ||
          removedAssets.has(s.assetId) ||
          removedTerminals.has(s.terminalId),
      )
      .map((s) => s.id),
  );
  const removedEvents = new Set(
    next.events.filter((e) => e.datasetId === datasetId).map((e) => e.id),
  );
  next.datasets = next.datasets.filter((d) => d.id !== datasetId);
  next.assets = next.assets.filter((a) => !removedAssets.has(a.id));
  next.nodes = next.nodes.filter((n) => !removedNodes.has(n.id));
  next.terminals = next.terminals
    .filter((t) => !removedTerminals.has(t.id))
    .map((t) => (removedNodes.has(t.nodeId) ? { ...t, nodeId: undefined } : t));
  next.series = next.series.filter((s) => !removedSeries.has(s.id));
  next.observations = next.observations.filter(
    (o) => o.datasetId !== datasetId && !removedSeries.has(o.seriesId),
  );
  next.networkMemberships = next.networkMemberships.filter(
    (m) => !removedAssets.has(m.assetId),
  );
  next.events = next.events.filter((e) => !removedEvents.has(e.id));
  next.eventAssets = next.eventAssets.filter(
    (e) => !removedEvents.has(e.eventId) && !removedAssets.has(e.assetId),
  );
  const usedSources = new Set(next.datasets.map((d) => d.sourceId));
  next.sources = next.sources.filter(
    (s) => !s.id.startsWith("file-") || usedSources.has(s.id),
  );
  return assertBundle(next);
}
