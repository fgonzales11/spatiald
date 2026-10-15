"""Fresh phase-aware solves for data-only SCE models, in native Python or Pyodide.

The engine archive and worker setup originate in di-app-athon/public/powerflow.
Catalog JSON replaces executable pickles. No saved model/results are reused.
"""
import importlib
import json
import logging
import math
import time
import numpy as np
import pandas as pd
import multiconductor as mc

CLASSES = {
    'multiconductor.control.shunt_controller.MulticonductorBinaryShuntController',
    'multiconductor.control.line_drop_control.LineDropControlExtended',
    'multiconductor.control.volt_var_control.QVCurve',
    'multiconductor.control.volt_var_control.QModelQVCurve',
    'multiconductor.control.volt_var_control.VoltVarController',
}


def decode(v):
    if isinstance(v,list):return [decode(x) for x in v]
    if not isinstance(v,dict):return v
    if '__float__' in v:return float(v['__float__'])
    if '__complex__' in v:return complex(*[decode(x) for x in v['__complex__']])
    if '__ndarray__' in v:return np.array(decode(v['__ndarray__']),dtype=v['dtype']).reshape(v['shape'])
    if '__tuple__' in v:return tuple(decode(x) for x in v['__tuple__'])
    if '__set__' in v:return set(decode(x) for x in v['__set__'])
    if '__mapping__' in v:return {decode(k):decode(x) for k,x in v['__mapping__']}
    if '__series__' in v:
        labels=decode(v['index']);names=v.get('index_names')
        multi=(names and len(names)>1) or (labels and isinstance(labels[0],tuple))
        index=(pd.MultiIndex.from_tuples(labels,names=names) if labels else pd.MultiIndex.from_arrays([[] for _ in names],names=names)) if multi else pd.Index(labels,name=names[0] if names else None)
        return pd.Series(decode(v['__series__']),index=index,name=decode(v.get('name')),dtype=v['dtype'])
    if '__index__' in v:
        labels=decode(v['__index__']);names=v.get('names',[None])
        return pd.MultiIndex.from_tuples(labels,names=names) if len(names)>1 else pd.Index(labels,name=names[0])
    if '__class__' in v:
        name=v['__class__'];state=decode(v.get('state',{}))
        if name=='logging.Logger':return logging.getLogger(state.get('name'))
        if name not in CLASSES:raise ValueError('Unsupported model controller: '+name)
        module,cls=name.rsplit('.',1);typ=getattr(importlib.import_module(module),cls)
        obj=typ.__new__(typ);obj.__dict__.update(state);return obj
    return {k:decode(x) for k,x in v.items()}


def network_from_document(document):
    if document.get('format')!=1:raise ValueError('Unsupported network format')
    net=mc.create_empty_network(add_stdtypes=False)
    for key,value in document['meta'].items():net[key]=decode(value)
    for key,frame in document['tables'].items():
        names=frame['index_names'];indices=frame['index']
        if len(names)>1:
            index=pd.MultiIndex.from_tuples([tuple(v) for v in indices],names=names) if indices else pd.MultiIndex.from_arrays([[] for _ in names],names=names)
        else:index=pd.Index(indices,name=names[0])
        data=decode(frame['data']);df=pd.DataFrame(data,columns=frame['columns'],index=index)
        for column,dtype in zip(frame['columns'],frame['dtypes']):
            df[column]=df[column].astype(dtype)
        net[key]=df
    # Explicit fresh initialization; serialized convergence flags never establish success.
    net['converged']=False;net.pop('model',None)
    return net


def run_document(text, options):
    started=time.perf_counter();document=json.loads(text)
    parameters={'tol_vmag_pu':1e-5,'tol_vang_rad':1e-5,'MaxIter':100,'run_control':True}
    if options:parameters.update(options)
    if not isinstance(parameters['MaxIter'],int) or not 1<=parameters['MaxIter']<=1000:raise ValueError('Invalid maximum iterations')
    for key in ('tol_vmag_pu','tol_vang_rad'):
        if not math.isfinite(parameters[key]) or not 1e-12<=parameters[key]<=.1:raise ValueError('Invalid voltage tolerance')
    net=network_from_document(document)
    try:
        mc.run_pf(net,**parameters)
        solved=bool(net.get('model',{}).get('solved',False))
        message='Power flow converged.' if solved else 'Power flow did not converge.'
    except Exception as exc:
        numerical_failure=(type(exc).__name__ in {'LoadflowNotConverged','ControllerNotConverged','NetCalculationNotConverged'}
                           or isinstance(exc,np.linalg.LinAlgError)
                           or (isinstance(exc,RuntimeError) and 'singular' in str(exc).lower()))
        if not numerical_failure:
            raise RuntimeError('The model could not be evaluated: '+type(exc).__name__+': '+str(exc)) from exc
        solved=False;message=type(exc).__name__+': '+str(exc)
    model=net.get('model',{})
    result={'solved':solved,'circuit_key':document['circuit_key'],'seconds':time.perf_counter()-started,
            'iterations':int(model.get('iterations',0)),'parameters':parameters,'message':message,'tables':{}}
    if solved:
        for name in ('res_bus','res_line','res_trafo'):
            if name in net:result['tables'][name]=json.loads(net[name].reset_index().to_json(orient='records',double_precision=12))
        bus=net.res_bus
        active=bus.loc[bus.index.get_level_values('phase').isin([1,2,3]),'vm_pu']
        energized=active[np.isfinite(active)&(active>0)]
        result.update(voltage_min=float(energized.min()) if len(energized) else None,
                      voltage_max=float(energized.max()) if len(energized) else None,
                      unenergized_phase_terminals=int(len(active)-len(energized)))
    return json.dumps(result,allow_nan=False)
