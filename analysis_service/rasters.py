import math
import numpy as np
import rasterio
from rasterio.features import geometry_mask, shapes
from rasterio.warp import transform_geom
from shapely.geometry import shape, mapping
from .spatial import geometry, metrics, feature


def raster_metadata(path):
    with rasterio.open(path) as ds:
        if ds.crs is None or ds.transform == rasterio.Affine.identity():
            raise ValueError("Raster must have a CRS and georeferenced pixel transform")
        if ds.width * ds.height > 400_000_000:
            raise ValueError("Raster exceeds the local POC limit of 400 million pixels; provide an AOI crop")
        from rasterio.warp import transform_bounds
        w, s, e, n = transform_bounds(ds.crs, 4326, *ds.bounds)
        from rasterio.warp import transform as transform_points
        from .spatial import GEOD
        x0,y0 = ds.transform * (ds.width/2,ds.height/2)
        x1,y1 = ds.transform * (ds.width/2+1,ds.height/2)
        x2,y2 = ds.transform * (ds.width/2,ds.height/2+1)
        lon,lat = transform_points(ds.crs,4326,[x0,x1,x2],[y0,y1,y2])
        gsd = max(GEOD.inv(lon[0],lat[0],lon[1],lat[1])[2],GEOD.inv(lon[0],lat[0],lon[2],lat[2])[2])
        from shapely.geometry import box
        return {"sourceCrs": ds.crs.to_string(), "resolution": list(ds.res), "width": ds.width,
                "height": ds.height, "bands": ds.count, "groundSampleDistanceM":gsd, "pvSuitability": 'array_screening' if gsd<=.6 else 'too_coarse_for_rooftop_arrays', "coverageGeometry": mapping(box(w, s, e, n)),
                "nodata": ds.nodata if ds.nodata is None or math.isfinite(ds.nodata) else None}


def zonal_statistics(path, features, check=lambda *_: None):
    rows = []
    with rasterio.open(path) as ds:
        from rasterio.mask import mask
        for i, f in enumerate(features):
            check(i / max(len(features), 1))
            g = transform_geom(4326, ds.crs, f["geometry"])
            try:
                data, _ = mask(ds, [g], crop=True, indexes=1, filled=False)
                valid = data.compressed()
                valid = valid[np.isfinite(valid)]
            except ValueError:
                valid = np.array([])
            rows.append({"featureId": f.get("id", i), "count": len(valid),
                         "minimum": float(valid.min()) if len(valid) else None,
                         "maximum": float(valid.max()) if len(valid) else None,
                         "mean": float(valid.mean()) if len(valid) else None,
                         "status": "assessed" if len(valid) else "insufficient_data"})
    return {"rows": rows, "interpretation": "Raster statistics over supplied geometry; nodata excluded"}


def equipment_depths(path, assets, reference, unit, check=lambda *_: None):
    """Depth above ground minus surveyed equipment clearance; never use display offsets."""
    rows = zonal_statistics(path,[feature(geometry(a['geometry']),identity=a['id']) for a in assets],check)['rows']
    by_id = {a['id']:a for a in assets}
    factor = {'m':1.,'metres':1.,'meters':1.,'ft':.3048}.get(unit)
    for row in rows:
        asset = by_id[row['featureId']]
        attrs = asset.get('attributes',{})
        compatible = bool(reference and attrs.get('heightReference')==reference and attrs.get('groundHeightReference')==reference)
        known = all(isinstance(attrs.get(k),(int,float)) for k in ('elevationM','groundElevationM'))
        row.update(rasterUnit=unit,verticalReference=reference,equipmentInundationDepthM=None,equipmentElevationStatus='unknown_or_incompatible')
        if asset['geometry']['type']=='Point' and compatible and known and factor and row['maximum'] is not None:
            clearance = attrs['elevationM']-attrs['groundElevationM']
            row.update(equipmentInundationDepthM=max(0.,row['maximum']*factor-clearance),equipmentElevationStatus='supplied_compatible',
                       equipmentClearanceM=clearance,rasterToMetresFactor=factor)
    return rows


def flood_footprint(path, check=lambda *_: None):
    """Polygonize positive depths window by window, excluding nodata."""
    from shapely.ops import unary_union
    wet, valid_parts = [], []
    with rasterio.open(path) as ds:
        if ds.crs is None:
            raise ValueError("Flood raster has no CRS")
        for i, (_, window) in enumerate(ds.block_windows(1)):
            check(min(.9, i / max(1, (ds.width * ds.height) / 65536)))
            data = ds.read(1, window=window, masked=True)
            valid = ~np.ma.getmaskarray(data) & np.isfinite(data.astype(float).filled(np.nan))
            mask = valid & (data.filled(0) > 0)
            for bits, output in ((valid, valid_parts), (mask, wet)):
                for g, value in shapes(bits.astype("uint8"), mask=bits, transform=ds.window_transform(window)):
                    if value:
                        output.append(shape(transform_geom(ds.crs, 4326, g)))
    return unary_union(wet), unary_union(valid_parts)
