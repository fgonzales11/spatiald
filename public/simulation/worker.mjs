// Adapted from di-app-athon's bundled Pyodide powerflow_worker.mjs.
// All numerical execution occurs in this WebAssembly worker, off the map thread.
let runtime, busy = false;
const base = new URL('./', import.meta.url);
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const status = (id, message) => self.postMessage({type:'status', id, message});
async function resource(path, expected) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw Error(`Solver resource unavailable (${response.status}): ${path}`);
  const bytes = await response.arrayBuffer();
  if (expected && await sha(bytes) !== expected) throw Error('Solver integrity check failed. Reload the application.');
  return bytes;
}
async function initialize(id, catalog) {
  status(id, 'Loading WebAssembly and numerical libraries…');
  const vendor = new URL('vendor/', base);
  const config = JSON.parse(new TextDecoder().decode(await resource('vendor/solver.json')));
  const indexURL = new URL('pyodide/', vendor).href;
  const {loadPyodide} = await import(indexURL+'pyodide.mjs');
  const py = await loadPyodide({indexURL});
  await py.loadPackage(config.packages);
  status(id, 'Preparing the multiconductor engine…');
  py.globals.set('_wheels',JSON.stringify(config.wheels.map(path=>new URL(path,vendor).href)));
  await py.runPythonAsync("import json, micropip\nawait micropip.install(json.loads(_wheels), deps=False, reinstall=True)");
  py.globals.delete('_wheels');
  py.unpackArchive(await resource('multiconductor.zip',catalog.solver_sha256),'zip',{extractDir:'/home/pyodide'});
  py.FS.writeFile('/home/pyodide/solver_runtime.py',new Uint8Array(await resource('solver_runtime.py',catalog.runtime_sha256)));
  await py.runPythonAsync('from solver_runtime import run_document');
  return py;
}
self.onmessage = async ({data}) => {
  const {id} = data;
  if (busy) { self.postMessage({type:'error',id,message:'The solver is already running.'}); return; }
  busy = true;
  try {
    const bytes = new Uint8Array(data.model);
    if (await sha(bytes) !== data.network.model_sha256) throw Error('Network model integrity check failed. Load the network again.');
    const py = await (runtime ??= initialize(id,data.catalog).catch(error=>{runtime=undefined;throw error;}));
    py.globals.set('_network_json',new TextDecoder().decode(bytes));
    py.globals.set('_options',JSON.stringify(data.parameters || {}));
    status(id,`Running power flow · ${data.network.circuit_key}…`);
    try {
      const result = JSON.parse(await py.runPythonAsync('run_document(_network_json, json.loads(_options))'));
      self.postMessage({type:'result',id,circuit_key:data.network.circuit_key,result});
    } finally {py.globals.delete('_network_json');py.globals.delete('_options');}
  } catch(error) {
    self.postMessage({type:'error',id,message:error.message || 'The WebAssembly solver could not start.'});
  } finally {busy=false;}
};
