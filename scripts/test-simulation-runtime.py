"""Run with the numerical Python environment; tests the same runtime as WASM."""
from pathlib import Path
import gzip
import importlib.util
import json
import sys
import unittest

BASE=Path(__file__).resolve().parents[1]/'public/simulation'
sys.path.insert(0,str(BASE/'multiconductor.zip'))
spec=importlib.util.spec_from_file_location('solver_runtime',BASE/'solver_runtime.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_controller_series_retains_multiindex_values_names_and_dtype(self):
        value={'__series__':[.1,.2],'index':[{'__tuple__':[5,0]},{'__tuple__':[5,1]}],
               'index_names':['index','circuit'],'name':'sn_mva','dtype':'float64'}
        result=runtime.decode(value)
        self.assertEqual(result.index.names,['index','circuit'])
        self.assertEqual(result.at[(5,1)],.2)
        self.assertEqual(str(result.dtype),'float64')

    def test_fresh_solve_with_inverter_controllers(self):
        text=gzip.decompress((BASE/'models/CKT_1002_15515.json.gz').read_bytes()).decode()
        result=json.loads(runtime.run_document(text,{}))
        self.assertTrue(result['solved'],result['message'])
        self.assertEqual(result['circuit_key'],'CKT_1002_15515')
        self.assertTrue(result['tables']['res_line'])
        self.assertTrue(result['parameters']['run_control'])

    def test_one_iteration_does_not_reuse_a_saved_converged_flag(self):
        text=gzip.decompress((BASE/'models/CKT_1001_15510.json.gz').read_bytes()).decode()
        converged=json.loads(runtime.run_document(text,{}))
        failed=json.loads(runtime.run_document(text,{'MaxIter':1}))
        self.assertTrue(converged['solved'])
        self.assertFalse(failed['solved'])
        self.assertFalse(failed['tables'])


if __name__=='__main__':unittest.main()
