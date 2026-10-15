# Import and export formats

Open **Data Sources → Choose a data file**. The import preview shows counts, bounds, destination, and validation errors before any write occurs. **Confirm import** writes the complete candidate in one IndexedDB transaction. Files are limited to 20 MB and remain in this browser.

## Asset GeoJSON

Use a FeatureCollection with nonempty string properties `id`, `name`, `utilityType`, and `assetType` on each Feature. Optional properties are `externalId`, `status`, and `attributes`. IDs cannot collide with existing assets. `utilityType` is electric, water, or gas; asset types come from the [registered types](data-model.md).

```json
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [-82.459, 27.94]},
    "properties": {
      "id": "my-meter-001",
      "name": "Imported meter 001",
      "utilityType": "electric",
      "assetType": "meter",
      "attributes": {"nominalVoltageV": 240}
    }
  }]
}
```

The import adds a dataset and file-source provenance to the current workspace. Unspecified status is `unknown`. Geometry does not create network memberships or connectivity. Use a canonical workspace bundle to supply explicit topology. Legacy CRS declarations are rejected; transform source data to WGS84 first. A [downloadable template](../public/templates/assets.geojson) is included in the app.

## Observation CSV

Required columns: `asset_id,quantity,unit,observed_at,value`. Optional columns: `phase,quality`.

```csv
asset_id,quantity,unit,observed_at,value,phase,quality
f1-tx0,Temperature,C,2026-09-19T12:00:00Z,35,,good
f1-tx0,Temperature,C,2026-09-19T12:15:00Z,36,,good
f1-tx0,Temperature,C,2026-09-19T12:30:00Z,,,missing
```

`asset_id` is the internal asset ID displayed in the inspector, not an external meter identifier. Every asset must already exist. Numeric values may be blank for missing readings. An explicit timestamp timezone is required; offsets are converted to UTC. Quoted fields, escaped quotes, UTF-8 BOM, and CRLF are supported. Duplicate observations are rejected rather than overwritten.

Rows join an existing series with the same asset, quantity, unit, and phase, or create a new series. Each imported observation retains its new dataset provenance. Values without a quality column default to `unknown`; blank values always use `missing`. A [template](../public/templates/observations.csv) is included.

## Canonical workspace JSON

**Export workspace** downloads the full version 1 bundle with sources, datasets, assets, topology, measurements, and events. Importing it creates a separate workspace with a new workspace ID and an `imported` name suffix. Entity IDs, external IDs, and their relationships are preserved; workspace foreign keys are updated to the new workspace.

Exports exclude map imagery, browser preferences, and the Google API key. Imports require valid schema shape, geometries, timestamps, identities, utility-type compatibility, and resolvable references.

## Failures and removal

An invalid preview never writes. A failed save keeps the current workspace unchanged. A preview created before another tab changes the workspace is rejected on commit; reload and preview again. Browser quota or storage errors are reported with an export option.

Removing an imported dataset requires an in-app confirmation and removes its dependent assets, terminals, series, observations, events, and associations. Remaining terminals whose nodes were removed become unconnected. Export first to retain a copy. Managed public datasets offer **Hide layer** instead; **Settings → Restore layers** re-enables the three public sources and refreshes the current map area. This does not replace imported records or workspaces.
