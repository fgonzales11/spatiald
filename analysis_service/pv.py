"""ResNet34 U-Net and georeferenced tiled PV inference. No random-weight predictions."""
import json
from pathlib import Path
import numpy as np
from .models import pv_capacity
from .spatial import metrics, feature


def build_model(pretrained=False):
    import torch
    from torch import nn
    from torchvision.models import resnet34, ResNet34_Weights

    class Block(nn.Module):
        def __init__(self, incoming, outgoing):
            super().__init__()
            self.layers = nn.Sequential(nn.Conv2d(incoming, outgoing, 3, padding=1), nn.BatchNorm2d(outgoing), nn.ReLU(),
                                        nn.Conv2d(outgoing, outgoing, 3, padding=1), nn.BatchNorm2d(outgoing), nn.ReLU())
        def forward(self, value):
            return self.layers(value)

    class UNet(nn.Module):
        def __init__(self):
            super().__init__()
            encoder = resnet34(weights=ResNet34_Weights.DEFAULT if pretrained else None)
            self.stem = nn.Sequential(encoder.conv1, encoder.bn1, encoder.relu)
            self.pool = encoder.maxpool
            self.encoders = nn.ModuleList([encoder.layer1, encoder.layer2, encoder.layer3, encoder.layer4])
            self.decoders = nn.ModuleList([Block(512 + 256, 256), Block(256 + 128, 128), Block(128 + 64, 64), Block(64 + 64, 32)])
            self.head = nn.Conv2d(32, 1, 1)
        def forward(self, value):
            size = value.shape[-2:]
            skip = [self.stem(value)]
            x = self.pool(skip[0])
            for block in self.encoders:
                x = block(x)
                skip.append(x)
            for block, y in zip(self.decoders, reversed(skip[:-1])):
                x = torch.nn.functional.interpolate(x, size=y.shape[-2:], mode="bilinear", align_corners=False)
                x = block(torch.cat([x, y], dim=1))
            return torch.nn.functional.interpolate(self.head(x), size=size, mode="bilinear", align_corners=False)
    return UNet()


def infer(path, checkpoint, card_path, efficiency=.2, tilt=0., threshold=.5, check=lambda *_: None):
    import torch
    import rasterio
    from rasterio.features import shapes
    from rasterio.warp import transform_geom
    from rasterio.windows import Window
    from shapely.geometry import shape
    from shapely.ops import unary_union
    if not Path(checkpoint).is_file() or not Path(card_path).is_file():
        raise ValueError("PV model is not trained/configured. Run the documented training workflow and install its checkpoint and model card.")
    from .rasters import raster_metadata
    metadata = raster_metadata(path)
    if metadata['groundSampleDistanceM'] > .6:
        raise ValueError('Imagery is too coarse for rooftop PV screening. Supply a native-resolution orthophoto with ground sample distance at most 0.6 m.')
    card = json.loads(Path(card_path).read_text())
    if not card.get("training") or card.get("architecture") != "resnet34-unet":
        raise ValueError("PV checkpoint requires a model card with training provenance")
    model = build_model()
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()
    torch.set_num_threads(2)
    if not 0 < float(threshold) < 1:
        raise ValueError("Segmentation threshold must be between 0 and 1")
    with rasterio.open(path) as ds:
        if ds.count < 3 or ds.crs is None:
            raise ValueError("PV detection requires georeferenced RGB imagery")
        if ds.width * ds.height > 25_000_000:
            raise ValueError("PV inference is limited to 25 million pixels per job; crop to a smaller AOI")
        scores = np.zeros((ds.height, ds.width), dtype=np.float32)
        weights = np.zeros_like(scores)
        windows = [(x, y) for y in range(0, ds.height, 192) for x in range(0, ds.width, 192)]
        with torch.no_grad():
            for i, (x, y) in enumerate(windows):
                check(i / len(windows))
                width, height = min(256, ds.width - x), min(256, ds.height - y)
                rgb = ds.read([1, 2, 3], window=Window(x, y, width, height), out_dtype="float32")
                valid = ds.dataset_mask(window=Window(x, y, width, height)) > 0
                if not np.any(valid):
                    continue
                if ds.dtypes[0] != "uint8":
                    raise ValueError("Provide 8-bit RGB imagery; implicit radiometric rescaling is not supported")
                padded = np.pad(rgb / 255., ((0, 0), (0, 256 - height), (0, 256 - width)), mode="edge")
                normalized = (padded - np.array([.485, .456, .406], dtype=np.float32)[:, None, None]) / np.array([.229, .224, .225], dtype=np.float32)[:, None, None]
                prediction = torch.sigmoid(model(torch.from_numpy(normalized)[None]))[0, 0].numpy()[:height, :width]
                scores[y:y+height, x:x+width] += prediction * valid
                weights[y:y+height, x:x+width] += valid
        scores = np.divide(scores, weights, out=np.zeros_like(scores), where=weights > 0)
        bits = (scores >= threshold) & (weights > 0)
        pieces = [shape(transform_geom(ds.crs, 4326, g)) for g, value in shapes(bits.astype("uint8"), mask=bits, transform=ds.transform) if value]
        union = unary_union(pieces)
        polygons = list(union.geoms) if union.geom_type == "MultiPolygon" else [] if union.is_empty else [union]
        output = []
        for i, polygon in enumerate(polygons):
            sizing = pv_capacity(metrics(polygon)["areaM2"], float(efficiency), float(tilt))
            from rasterio.features import geometry_mask
            region = geometry_mask([transform_geom(4326, ds.crs, polygon.__geo_interface__)], out_shape=scores.shape, transform=ds.transform, invert=True)
            output.append(feature(polygon, {**sizing, "modelScore": float(scores[region].mean()),
                          "reviewStatus": "unreviewed", "modelVersion": card.get("version"), "status": "experimental"}, f"pv-{i}"))
    return {"data": {"type": "FeatureCollection", "features": output}, "rows": [{"arrayId": f["id"], **f["properties"]} for f in output],
            "modelCard": card, "assumptions": {"threshold": threshold, "efficiency": efficiency, "tiltDegrees": tilt,
                                               "tiltIsAssumed": tilt == 0, "buildingAssociation": "Not inferred"}}
