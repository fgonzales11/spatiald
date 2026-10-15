/**
 * Version 1 public domain contracts. Geometry is location, not inferred topology.
 * @typedef {'electric'|'water'|'gas'} UtilityType
 * @typedef {{id:string,name:string,timezone:string,serviceArea:object}} Workspace
 * @typedef {{id:string,workspaceId:string,datasetId:string,externalId:string,utilityType:UtilityType,assetType:string,name:string,geometry:object,status:string,attributes:object}} Asset
 * @typedef {{id:string,assetId:string,nodeId?:string,label:string,phases?:string[]}} Terminal
 * @typedef {{id:string,assetId:string,terminalId?:string,datasetId:string,quantity:string,unit:string,phase?:string}} MeasurementSeries
 * @typedef {{seriesId:string,observedAt:string,value:number|null,quality:string,datasetId:string}} Observation
 * @typedef {{schemaVersion:1,workspace:Workspace,sources:object[],datasets:object[],networks:object[],assets:Asset[],networkMemberships:object[],nodes:object[],terminals:Terminal[],series:MeasurementSeries[],observations:Observation[],events:object[],eventAssets:object[]}} TwinBundle
 *
 * DataProvider (asynchronous): listWorkspaces(), loadWorkspace(id), saveWorkspace(bundle),
 * queryAssets(workspaceId, filters), getAsset(workspaceId, id), getSeries(workspaceId, assetId),
 * getObservations(workspaceId, seriesId), queryEvents(workspaceId, assetId),
 * importDataset(preview), exportWorkspace(id), removeDataset(workspaceId, datasetId).
 *
 * SpatialView: update({assets,selectedId,connectedIds,context?}), focusAsset(asset), focusBounds(bounds), captureCamera(),
 * restoreCamera(camera), resize(), zoom(delta), reset(), dispose(). Factory callbacks:
 * 3D views also support setEnvironment({cloudsEnabled,cloudCoverage}).
 * onSelect(assetId), onSelectContext(osmFeatureId), onViewChange({bounds,center,zoom?}), onPointer({longitude,latitude}), onStatus(message), onFatal(message).
 */

export const ASSET_TYPES = {
  electric: [
    "substation",
    "transmission_line",
    "overhead_line",
    "underground_cable",
    "pole",
    "transformer",
    "switch",
    "meter",
  ],
  water: ["reservoir", "pump", "water_main", "valve", "hydrant", "water_meter"],
  gas: ["gas_main", "regulator", "gas_valve", "gas_meter", "compressor"],
};
export const TYPE_LABELS = {
  substation: "Substations",
  transmission_line: "Electric transmission",
  overhead_line: "Overhead lines",
  underground_cable: "Underground cables",
  pole: "Poles",
  transformer: "Transformers",
  switch: "Switches",
  meter: "Meters",
  reservoir: "Reservoirs",
  pump: "Pumps",
  water_main: "Water mains",
  valve: "Valves",
  hydrant: "Hydrants",
  water_meter: "Water meters",
  gas_main: "Natural gas pipelines",
  regulator: "Regulators",
  gas_valve: "Gas valves",
  gas_meter: "Gas meters",
  compressor: "Compressors",
};
export const TYPE_COLORS = {
  substation: "#f4bd64",
  transmission_line: "#39d99c",
  overhead_line: "#39d99c",
  underground_cable: "#af8cf5",
  pole: "#85a5ba",
  transformer: "#f4bd64",
  switch: "#f08c72",
  meter: "#37c6ef",
  water_main: "#37c6ef",
  gas_main: "#f08c72",
};
export const CATEGORIES = [
  "Foundational Geospatial Data",
  "3D & Elevation Data",
  "Real-Time Sensor Data",
  "Time-Series & Historical Data",
  "Infrastructure & Operational Data",
  "Environmental & Climate Data",
  "Regulatory & Compliance Data",
  "Demographic & Socio-Economic Data",
  "Predictive & Simulation Data",
];
