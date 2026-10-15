"""Join model devices to nearby public solar records as spatial candidates."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "data/solar/teco-models"
PUBLIC_DIR = ROOT / "data/solar/panelcensus/teco"


def compare():
    model = json.loads((MODEL_DIR / "teco-asymmetric-sgen.json").read_text())
    index = json.loads((PUBLIC_DIR / "listing-index.json").read_text())
    assert index["endOfPaginationReached"]
    sites = []
    for listing in index["results"]:
        site = json.loads((PUBLIC_DIR / "sites" / f"{listing['siteId']}.json").read_text())
        assert site["siteId"] == listing["siteId"] and site["sourceUrl"] == listing["sourceUrl"]
        assert site["httpStatus"] == 200 or (site.get("pageVerified") and site.get("readMethod") == "in-app browser")
        if site["latitude"] is not None and site["longitude"] is not None:
            sites.append(site)
    # Actual published coordinates, no geocoding or inferred system capacity.
    coordinates = np.radians([[s["latitude"], s["longitude"]] for s in sites])
    merged, statuses = [], Counter()
    for row in model["records"]:
        lat, lon = np.radians([row["latitude"], row["longitude"]])
        a = np.sin((coordinates[:, 0] - lat) / 2) ** 2 + np.cos(lat) * np.cos(coordinates[:, 0]) * np.sin((coordinates[:, 1] - lon) / 2) ** 2
        distances = 6371008.8 * 2 * np.arctan2(np.sqrt(np.clip(a, 0, 1)), np.sqrt(np.clip(1 - a, 0, 1)))
        nearest_index = int(np.argmin(distances))
        nearest = sites[nearest_index]
        near_ids = sorted(sites[i]["siteId"] for i in np.flatnonzero(distances <= 50))
        status = "multiple spatial candidates within 50m" if len(near_ids) > 1 else "one spatial candidate within 50m" if near_ids else "no public site within 50m"
        statuses[status] += 1
        merged.append({**row,
            "nearest_public_site_id": nearest["siteId"],
            "nearest_public_site_name": nearest["siteName"],
            "nearest_public_latitude": nearest["latitude"],
            "nearest_public_longitude": nearest["longitude"],
            "nearest_public_distance_m": float(distances[nearest_index]),
            "nearest_public_system_size_kw": nearest["systemSizeKw"],
            "nearest_public_capacity_basis": nearest["capacityBasis"],
            "nearest_public_source_url": nearest["sourceUrl"],
            "public_sites_within_50m": len(near_ids),
            "public_site_ids_within_50m": "; ".join(near_ids),
            "comparison_status": status,
        })
    result = {"compared_utc": datetime.now(timezone.utc).isoformat(),
              "summary": {"model_devices": len(merged), "public_sites_read": len(index["results"]),
                          "public_sites_with_coordinates": len(sites), "candidate_radius_m": 50,
                          "earth_radius_m": 6371008.8, "comparison_status_counts": dict(statuses),
                          "scope": "Only the supplied 63 feeder models; public search covers the operator more broadly.",
                          "identity_verification": "Spatial candidates only; numeric model IDs are not linked to public permit IDs.",
                          "capacity_comparison": "Model p_mw is operating power; no installed capacity or technology is available for confirmation."},
              "model_source_sha256": hashlib.sha256((MODEL_DIR / "teco-asymmetric-sgen.json").read_bytes()).hexdigest(),
              "records": merged}
    (MODEL_DIR / "teco-crossvalidation.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    compare()
