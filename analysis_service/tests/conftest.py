"""Keep test initialization away from the user's local study database."""
import os
import shutil
import tempfile

_root = tempfile.mkdtemp(prefix='geobound-test-bootstrap-')
os.environ['ANALYSIS_DATA_DIR'] = _root


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_root, ignore_errors=True)
