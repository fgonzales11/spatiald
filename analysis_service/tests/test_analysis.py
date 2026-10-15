import copy
import io
import json
import time
import zipfile
from pathlib import Path
import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from shapely.geometry import box, mapping, Point, LineString, Polygon
from analysis_service.app import create_app
from analysis_service.storage import Repository
from analysis_service.spatial import exposure, metrics, compare_snapshots, spatial_operation
from analysis_service.models import forecast_ev, pv_capacity
from analysis_service.rasters import flood_footprint, zonal_statistics

ROOT = Path(__file__).resolve().parents[2]
AOI = mapping(box(-82.6,27.8,-82.3,28.1))


@pytest.fixture
def bundle():
    value = json.loads((ROOT / 'public/data/workspace.json').read_text())
    value['datasets'] = [dict(id='test', workspaceId=value['workspace']['id'], sourceId=value['sources'][0]['id'], name='Isolated test data', version='1', acquiredAt='2026-10-12T00:00:00Z', isSynthetic=True, bounds=[-82.6,27.8,-82.3,28.1], crs='EPSG:4326', schemaVersion=1)]
    value['assets'] = [dict(id='a', externalId='a', workspaceId=value['workspace']['id'], datasetId='test', utilityType='electric', assetType='transmission_line', name='Line', status='unknown', attributes={},geometry=mapping(LineString([(-82.59,27.95),(-82.31,27.95)]))),
                       dict(id='b', externalId='b', workspaceId=value['workspace']['id'], datasetId='test', utilityType='electric', assetType='substation', name='Station', status='unknown', attributes={'criticality':'high'},geometry=mapping(Point(-82.4,28.05)))]
    return json.loads(json.dumps(value))


def snap(bundle, complete=True):
    return dict(id='snapshot',bundle=bundle,complete=complete,coverageGeometry=AOI,capturedAt='2026-10-12T00:00:00Z')


def hazard(g=None, complete=True):
    return dict(id='flood',hazardType='flood',data={'type':'FeatureCollection','features':[{'type':'Feature','id':'h','geometry':g or mapping(box(-82.5,27.9,-82.4,28.0)),'properties':{}}]},complete=complete,coverageGeometry=AOI)


def wait(client, job):
    deadline=time.monotonic()+10
    while job['status'] in ('queued','running','cancelling') and time.monotonic()<deadline:
        time.sleep(.02);job=client.get('/api/analysis/jobs/'+job['id']).json()
    return job


def test_overlapping_hazards_deduplicate_lengths_and_unknown_criticality(bundle):
    result=exposure(snap(bundle),[hazard(),{**hazard(),'id':'second'}],AOI)
    assert result['summary']['exposed']==1
    line=next(r for r in result['rows'] if r['assetId']=='a')
    expected=metrics(LineString([(-82.5,27.95),(-82.4,27.95)]))['lengthM']
    assert line['lengthM']==pytest.approx(expected,rel=1e-9)
    assert len(line['hazards'])==2
    assert next(r for r in result['rows'] if r['assetId']=='b')['criticality']=='Unknown'


def test_incomplete_coverage_and_holes_are_not_silent_negative_evidence(bundle):
    outer=box(-82.6,27.8,-82.3,28.1)
    hole=box(-82.42,28.02,-82.38,28.08)
    result=exposure(snap(bundle),[hazard(mapping(outer.difference(hole)),False)],AOI)
    assert next(r for r in result['rows'] if r['assetId']=='b')['status']=='not_assessed'
    result=exposure(snap(bundle),[hazard(mapping(outer.difference(hole)),True)],AOI)
    assert next(r for r in result['rows'] if r['assetId']=='b')['status']=='not_exposed'


def test_fault_crossing_and_metric_buffer(bundle):
    fault={**hazard(mapping(LineString([(-82.5,27.8),(-82.5,28.1)]))),'hazardType':'fault'}
    crossing=exposure(snap(bundle),[fault],AOI)
    assert crossing['summary']['exposed']==1 and crossing['summary']['exposedLengthM']==0
    buffered=exposure(snap(bundle),[fault],AOI,100)
    assert buffered['summary']['exposedLengthM']==pytest.approx(200,rel=.01)
    assert spatial_operation('buffer',fault['data'],distance=100)['rows'][0]['areaM2']>0


def test_unresolved_alerts_are_insufficient_and_expired_alerts_are_not_current(bundle):
    unresolved={**hazard(),'hazardType':'weather','data':{'type':'FeatureCollection','features':[{'type':'Feature','id':'missing','geometry':None,'properties':{}}]}}
    result=exposure(snap(bundle),[unresolved],AOI)
    assert result['summary']['insufficient_data']==2
    expired={**hazard(AOI),'hazardType':'weather'}
    expired['data']['features'][0]['properties']={'effective':'2026-10-10T00:00:00Z','expires':'2026-10-11T00:00:00Z'}
    assert exposure(snap(bundle),[expired],AOI)['summary']['not_exposed']==2


def test_repaired_source_geometry_stays_in_immutable_layer_without_result_duplication(bundle):
    layer=hazard();layer['data']['features'][0]['properties']={'sourceGeometry':AOI,'geometryRepair':{'method':'GEOS make_valid'}}
    result=exposure(snap(bundle),[layer],AOI)
    assert 'sourceGeometry' not in result['rows'][0]['hazards'][0]['properties']
    assert layer['data']['features'][0]['properties']['sourceGeometry']==AOI


def test_snapshot_removals_require_equal_complete_coverage(bundle):
    before=snap(bundle);after=copy.deepcopy(before);after['bundle']['assets'].pop();after['id']='after'
    assert compare_snapshots(before,after)['rows'][0]['change']=='removed'
    after['complete']=False
    assert compare_snapshots(before,after)['rows'][0]['change']=='not_assessed'
    after['complete']=True;after['coverageGeometry']=mapping(box(-82.6,27.8,-82.3,28.0))
    assert not compare_snapshots(before,after)['removalsAssessed']


def test_metric_area_subtracts_holes():
    exterior=box(0,0,.01,.01);hole=box(.002,.002,.008,.008)
    assert metrics(exterior.difference(hole))['areaM2']==pytest.approx(metrics(exterior)['areaM2']-metrics(hole)['areaM2'],rel=1e-8)


def test_ev_chronological_backtests_bounded_shares_and_no_leakage():
    records=[dict(year=2018+i,bev=100+i*100,phev=50+i*20,total=10000,geographyId='county',geographyLevel='county') for i in range(8)]
    result=forecast_ev(records)
    future=[r for r in result['rows'] if r['kind']=='forecast']
    assert max(r['year'] for r in future)==2035
    assert all(0<=r['count']<=r['total'] and 0<=r['share']<=1 for r in future)
    assert all(r['trainThrough']<r['year'] for r in result['backtests'])
    assert {r['vehicle'] for r in future} == {'BEV','PHEV','OTHER'}
    for year in {r['year'] for r in future}:
        for scenario in {'slower','baseline','faster'}:
            group=[r for r in future if r['year']==year and r['scenario']==scenario]
            assert sum(r['count'] for r in group)==pytest.approx(group[0]['total'])
    assert result['model']=='last_observed_share'  # Linear count growth should not force an overpredicting logit trend.
    for r in future:
        other=next(x for x in future if x['year']==r['year'] and x['scenario']==r['scenario'] and x['vehicle']!=r['vehicle'])
        assert r['share']+other['share']<=1.000001
    with pytest.raises(ValueError,match='six'):forecast_ev(records[:5])
    with pytest.raises(ValueError,match='consecutive'):forecast_ev(records[:3]+records[4:])
    records[0]['bev']=20000
    with pytest.raises(ValueError,match='not exceed'):forecast_ev(records)


def test_pv_sizing_dc_basis_and_tilt_assumptions():
    assert pv_capacity(100)['estimatedKwDc']==20
    assert pv_capacity(100,.2,60)['estimatedKwDc']==pytest.approx(40)
    with pytest.raises(ValueError):pv_capacity(100,.2,90)


def test_integer_depth_raster_nodata_and_zonal_stats(tmp_path):
    path=tmp_path/'flood.tif'
    with rasterio.open(path,'w',driver='GTiff',width=2,height=2,count=1,dtype='int16',crs='EPSG:4326',transform=rasterio.transform.from_origin(-82.5,28,.01,.01),nodata=-9999) as ds:
        ds.write(np.array([[2,0],[-9999,3]],dtype='int16'),1)
    wet,covered=flood_footprint(path)
    assert covered.area>wet.area
    stats=zonal_statistics(path,[{'id':'all','geometry':mapping(box(-82.5,27.98,-82.48,28))}])['rows'][0]
    assert stats['count']==3 and stats['mean']==pytest.approx(5/3)
    from analysis_service.rasters import equipment_depths
    asset={'id':'equipment','geometry':mapping(Point(-82.495,27.995)),'attributes':{'elevationM':1.5,'groundElevationM':0,'heightReference':'NAVD88','groundHeightReference':'NAVD88'}}
    assert equipment_depths(path,[asset],'NAVD88','m')[0]['equipmentInundationDepthM']==.5
    assert equipment_depths(path,[asset],'ellipsoid','m')[0]['equipmentInundationDepthM'] is None


def test_api_persistence_immutable_scenarios_findings_and_package_roundtrip(tmp_path,bundle):
    app=create_app(tmp_path)
    with TestClient(app) as client:
        response=client.post('/api/analysis/studies',json={'name':'Isolated regression study','aoi':AOI})
        assert response.status_code==201
        sid=response.json()['id'];base='/api/analysis/studies/'+sid
        snapshot=client.post(base+'/entities/snapshot',json=snap(bundle)).json()
        layer=client.post(base+'/entities/layer',json=hazard()).json()
        job=wait(client,client.post(base+'/jobs',json={'kind':'exposure','parameters':{'snapshotId':snapshot['id'],'layerIds':[layer['id']]}}).json())
        assert job['status']=='completed',job
        scenario=client.post(base+'/entities/scenario',json={'snapshotId':snapshot['id'],'layerIds':[layer['id']],'assetOverrides':[{'assetId':'a','geometry':mapping(LineString([(-82.58,28.05),(-82.32,28.05)]))}]}).json()
        compared=wait(client,client.post(base+'/jobs',json={'kind':'scenario','parameters':{'snapshotId':snapshot['id'],'layerIds':[layer['id']],'scenarioId':scenario['id']}}).json())
        assert compared['status']=='completed',compared
        completed=client.get(base).json()['entities']['run'][-1]['result']
        assert completed['leaving']==['a']
        incomplete=client.post(base+'/entities/layer',json={**hazard(mapping(box(-82.58,28.02,-82.32,28.08)),False),'id':'partial'}).json()
        incomplete_scenario=client.post(base+'/entities/scenario',json={'snapshotId':snapshot['id'],'layerIds':[incomplete['id']]}).json()
        comparison=wait(client,client.post(base+'/jobs',json={'kind':'scenario','parameters':{'snapshotId':snapshot['id'],'layerIds':[layer['id']],'scenarioId':incomplete_scenario['id']}}).json())
        assert comparison['status']=='completed'
        incomplete_result=client.get(base).json()['entities']['run'][-1]['result']
        assert incomplete_result['leaving']==[] and 'a' in incomplete_result['comparisonUnassessed']
        finding={'assetId':'a','snapshotId':snapshot['id'],'priority':'High','reason':''}
        assert client.post(base+'/entities/finding',json=finding).status_code==422
        finding['reason']='Verified flood intersection'
        assert client.post(base+'/entities/finding',json=finding).status_code==201
        old=client.get(base).json()
        assert old['entities']['snapshot'][0]['bundle']==bundle
        archive=client.get(base+'/package').content
        imported=client.post('/api/analysis/packages/import',files={'file':('study.zip',archive,'application/zip')})
        assert imported.status_code==201,imported.text
        new=client.get('/api/analysis/studies/'+imported.json()['id']).json()
        assert new['entities']['run'][0]['resultChecksum']==old['entities']['run'][0]['resultChecksum']
        assert new['entities']['layer'][0]['checksum']==old['entities']['layer'][0]['checksum']
        assert new['entities']['snapshot'][0]['checksum']==snapshot['checksum']
        assert client.get(base+'/runs/'+job['runId']+'/export/gpkg').status_code==200
        # Tampering with one immutable record rejects the complete import.
        source=zipfile.ZipFile(io.BytesIO(archive));stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as target:
            for info in source.infolist():
                body=source.read(info.filename)
                if info.filename.startswith('records/00000'):body=body.replace(b'Isolated',b'Altered')
                target.writestr(info.filename,body)
        assert client.post('/api/analysis/packages/import',files={'file':('tampered.zip',stream.getvalue())}).status_code==422
    restarted=Repository(tmp_path)
    assert restarted.get(sid,'snapshot',snapshot['id'])['bundle']==bundle


def test_restart_marks_unfinished_jobs_interrupted(tmp_path):
    repo=Repository(tmp_path);j=repo.add_job('study','exposure',{})
    assert Repository(tmp_path).job(j['id'])['status']=='interrupted'
