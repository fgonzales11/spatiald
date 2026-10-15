"""Reproducible PV training with city-separated public reference imagery or pilot labels.

Run: python -m analysis_service.train_pv --public --epochs 10
Pilot adaptation: --manifest labels.json --initialize .analysis-data/models/pv.pt
Manifest: [{"image":"/path/rgb.tif","labels":"/path/reviewed.geojson","city":"Tampa","split":"train|validation|test"}]
"""
import argparse
import hashlib
import json
import random
from pathlib import Path
import numpy as np
import pandas as pd
import httpx
import rasterio
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from PIL import Image
from shapely.geometry import Polygon
from .pv import build_model
from .storage import now


def download(url, path):
    if path.is_file():
        return
    print(f"Downloading {path.name}", flush=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        with httpx.stream("GET", url, timeout=120, follow_redirects=True) as response:
            response.raise_for_status()
            with temporary.open("wb") as target:
                for chunk in response.iter_bytes():
                    target.write(chunk)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def public_manifest(root):
    root.mkdir(parents=True, exist_ok=True)
    metadata_path, vertices_path = root / "arrays.csv", root / "vertices.csv"
    download("https://ndownloader.figshare.com/files/24115682", metadata_path)
    download("https://ndownloader.figshare.com/files/24115688", vertices_path)
    meta, vertices = pd.read_csv(metadata_path), pd.read_csv(vertices_path)
    print("Public array labels loaded:", len(vertices), flush=True)
    entries = []
    for city, article, split in [("Fresno", 3385828, "train"), ("Oxnard", 3385807, "validation"), ("Stockton", 3385804, "test")]:
        files = httpx.get(f"https://api.figshare.com/v2/articles/{article}", timeout=60).json()["files"]
        available = {Path(f["name"]).stem.lower(): f for f in files if f["name"].lower().endswith(".tif")}
        counts = meta[meta.city == city].groupby("image_name").size().sort_values(ascending=False)
        chosen = next((name for name in counts.index if name.lower() in available), None)
        if chosen is None:
            raise ValueError(f"No public imagery matches {city} labels")
        item = available[chosen.lower()]
        image = root / item["name"]
        download(item["download_url"], image)
        md5 = hashlib.md5(image.read_bytes()).hexdigest()
        if item.get("computed_md5") and md5 != item["computed_md5"]:
            raise ValueError("Public image checksum mismatch")
        ids = set(meta[meta.image_name == chosen].polygon_id)
        entry = {"image": str(image), "city": city, "split": split, "pixelLabels": vertices[vertices.polygon_id.isin(ids)],
                 "source": f"https://doi.org/10.6084/m9.figshare.{article}", "imageMd5": md5,
                 "labelSource": "https://doi.org/10.6084/m9.figshare.3385780.v4", "rights": "CC0 public reference dataset"}
        entries.append(entry)
    return entries


def patches(entry, rng, per_image=128):
    with rasterio.open(entry["image"]) as ds:
        if ds.count < 3 or ds.dtypes[0] != "uint8":
            raise ValueError("Training requires 8-bit RGB imagery")
        rgb = ds.read([1,2,3]).transpose(1,2,0)
        if "pixelLabels" in entry:
            frame = entry["pixelLabels"]
            polys = [Polygon([(float(r[f'lon{i}']),float(r[f'lat{i}'])) for i in range(1,int(r['number_vertices'])+1)]) for _,r in frame.iterrows() if r['number_vertices']>=3]
            mask = rasterize([(p,1) for p in polys if p.is_valid], out_shape=(ds.height,ds.width), transform=rasterio.Affine.identity(), dtype="uint8")
        else:
            labels = json.loads(Path(entry["labels"]).read_text())
            polys = [transform_geom(4326,ds.crs,f["geometry"]) for f in labels["features"]]
            mask = rasterize([(p,1) for p in polys], out_shape=(ds.height,ds.width), transform=ds.transform, dtype="uint8")
        from scipy.ndimage import label, center_of_mass
        labels, count = label(mask)
        centers = center_of_mass(mask,labels,range(1,count+1))
        rng.shuffle(centers)
        crops, used = [], set()
        for cy,cx in centers:
            x0 = min(max(int(cx)-128,0),ds.width-256)
            y0 = min(max(int(cy)-128,0),ds.height-256)
            tile = (x0//128,y0//128)
            if tile in used: continue
            used.add(tile)
            crops.append((rgb[y0:y0+256,x0:x0+256].copy(),mask[y0:y0+256,x0:x0+256].copy()))
            if len(crops)>=per_image:break
        negatives=0
        for _ in range(per_image*20):
            if negatives>=max(1,len(crops)//2):break
            x0,y0=rng.randrange(0,ds.width-256),rng.randrange(0,ds.height-256)
            m=mask[y0:y0+256,x0:x0+256]
            if m.any():continue
            crops.append((rgb[y0:y0+256,x0:x0+256].copy(),m.copy()));negatives+=1
    return crops


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public",action="store_true")
    parser.add_argument("--manifest")
    parser.add_argument("--initialize")
    parser.add_argument("--epochs",type=int,default=10)
    parser.add_argument('--evaluate-only',action='store_true')
    parser.add_argument("--samples",type=int,default=128)
    parser.add_argument("--output",default=".analysis-data/models")
    args=parser.parse_args()
    import torch
    from torch.utils.data import Dataset,DataLoader
    torch.manual_seed(42);np.random.seed(42);random.seed(42);torch.set_num_threads(2)
    rng=random.Random(42)
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    manifest=public_manifest(out / "reference-data") if args.public else json.loads(Path(args.manifest).read_text()) if args.manifest else None
    if not manifest:raise ValueError("Choose public reference data or a labeled pilot manifest")
    groups={split:[e for e in manifest if e["split"]==split] for split in ("train","validation","test")}
    if any(not entries for entries in groups.values()):raise ValueError("Separate train, validation, and test geography groups are required")
    identities=[str(Path(e['image']).resolve()) for e in manifest]
    if len(identities)!=len(set(identities)):raise ValueError("An image cannot occur in multiple splits")
    class Samples(Dataset):
        def __init__(self, entries, augment=False):
            self.samples=[p for e in entries for p in patches(e,rng,args.samples)]
            self.augment=augment
        def __len__(self):return len(self.samples)
        def __getitem__(self,index):
            image,mask=self.samples[index]
            if self.augment:
                flip=rng.choice([None,0,1])
                if flip is not None:image,mask=np.flip(image,flip),np.flip(mask,flip)
            image=image.copy().transpose(2,0,1).astype('float32')/255.
            image=(image-np.array([.485,.456,.406],dtype='float32')[:,None,None])/np.array([.229,.224,.225],dtype='float32')[:,None,None]
            return torch.from_numpy(image.copy()),torch.from_numpy(mask.copy().astype('float32'))[None]
    sets={k:Samples(v,k=='train') for k,v in groups.items()}
    print("Samples:",{k:len(v) for k,v in sets.items()},flush=True)
    if any(len(v)==0 for v in sets.values()):raise ValueError("Empty training/evaluation split")
    model=build_model(pretrained=not bool(args.initialize))
    if args.initialize:model.load_state_dict(torch.load(args.initialize,map_location='cpu',weights_only=True))
    opt=torch.optim.Adam(model.parameters(),lr=1e-4)
    loss_fn=torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor([12.]))
    loader=DataLoader(sets['train'],batch_size=4,shuffle=True,num_workers=0)
    def evaluate(split):
        model.eval();tp=fp=fn=0;area_errors=[]
        with torch.no_grad():
            for image,target in DataLoader(sets[split],batch_size=4):
                pred=torch.sigmoid(model(image))>.5;truth=target>.5
                tp+=int((pred & truth).sum());fp+=int((pred & ~truth).sum());fn+=int((~pred & truth).sum())
                for p,t in zip(pred,truth):
                    actual=int(t.sum())
                    if actual:area_errors.append(abs(int(p.sum())-actual)/actual)
        return dict(pixelPrecision=tp/(tp+fp or 1),pixelRecall=tp/(tp+fn or 1),dice=2*tp/(2*tp+fp+fn or 1),iou=tp/(tp+fp+fn or 1),
                    medianPositivePatchAreaRelativeError=float(np.median(area_errors)) if area_errors else None,
                    areaMetricInterpretation='Total segmented module area per positive crop; not a verified per-system nameplate error')
    history=[];best=-1
    if args.evaluate_only and (out/'pv-model-card.json').is_file():history=json.loads((out/'pv-model-card.json').read_text()).get('history',[])
    for epoch in range(0 if args.evaluate_only else args.epochs):
        model.train();total=0.
        for image,target in loader:
            opt.zero_grad();logits=model(image);probs=torch.sigmoid(logits)
            dice=1-(2*(probs*target).sum()+1)/(probs.sum()+target.sum()+1)
            loss=loss_fn(logits,target)+dice;loss.backward();opt.step();total+=float(loss.detach())
        validation=evaluate('validation');record=dict(epoch=epoch+1,loss=total/len(loader),validation=validation);history.append(record);print(json.dumps(record),flush=True)
        if validation['dice']>best:
            best=validation['dice'];torch.save(model.state_dict(),out/'pv.pt')
    model.load_state_dict(torch.load(out/'pv.pt',map_location='cpu',weights_only=True))
    card={"architecture":"resnet34-unet","version":now(),"status":"experimental", "seed":42,
          "training":[{k:v for k,v in e.items() if k!='pixelLabels'} for e in manifest],"samples":{k:len(v) for k,v in sets.items()},
          "validation":evaluate('validation'),"test":evaluate('test'),"history":history,
          "regionalValidation": {"Tampa": "Not independently validated" if args.public else "See supplied manifest", "Los Angeles": "Not independently validated" if args.public else "See supplied manifest"},
          "limits":["California reference imagery does not establish Tampa or Los Angeles performance", "Pixel score is not calibrated confidence", "DC sizing uses editable efficiency and tilt assumptions", "Nameplate capacity errors are not validated without verified DC records"]}
    card['checkpointSha256']=hashlib.sha256((out/'pv.pt').read_bytes()).hexdigest()
    temporary=out/'pv-model-card.tmp';temporary.write_text(json.dumps(card,indent=2));temporary.replace(out/'pv-model-card.json')
    print('Checkpoint and model card saved to',out,flush=True)


if __name__=='__main__':main()
