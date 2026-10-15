import math
import numpy as np
from scipy.optimize import minimize
from scipy.special import softmax


def forecast_ev(records, end_year=2035, fleet_growth=0., check=lambda *_: None):
    """Multinomial shares, chronological selection, and empirical backtest errors."""
    records = sorted(records, key=lambda r: int(r["year"]))
    if len(records) < 6:
        raise ValueError("Insufficient history: at least six comparable annual observations are required. Import a separately labeled parent-area series.")
    years = np.array([int(r["year"]) for r in records])
    if np.any(np.diff(years) != 1):
        raise ValueError("History must have consecutive, unique years; reporting gaps cannot be filled silently")
    if len({(r.get("geographyId"), r.get("geographyLevel")) for r in records}) != 1:
        raise ValueError("Select one geographic series; do not pool counties or geographic levels")
    if any(r.get("reportingBreak") or r.get("suppressed") for r in records):
        raise ValueError("Remove or reconcile reporting breaks/suppressed observations before forecasting")
    fleet = np.array([float(r["total"]) for r in records])
    bev, phev = np.array([float(r["bev"]) for r in records]), np.array([float(r["phev"]) for r in records])
    if not np.all(np.isfinite(np.concatenate([fleet, bev, phev]))) or np.any(fleet <= 0) or np.any(bev < 0) or np.any(phev < 0) or np.any(bev + phev > fleet):
        raise ValueError("Vehicle counts must be finite, nonnegative, and not exceed their matching total")
    counts = np.column_stack([bev, phev, fleet - bev - phev])
    end_year = int(end_year)
    if end_year <= years[-1] or end_year > 2050 or not -0.2 <= float(fleet_growth) <= 0.2:
        raise ValueError("Forecast year must follow history and be at most 2050; fleet growth must be between -20% and 20%")

    def fit(n):
        # Use all supplied comparable years. A small ridge penalty stabilizes zero classes.
        x = np.column_stack([np.ones(n), years[:n] - years[0]])
        c = counts[:n]
        def objective(flat):
            beta = flat.reshape(2, 2)
            logits = np.column_stack([x @ beta, np.zeros(n)])
            probs = np.clip(softmax(logits, axis=1), 1e-12, 1.)
            return -float(np.sum(c * np.log(probs)) / fleet[:n].sum()) + 1e-5 * float(np.sum(beta[1] ** 2))
        result = minimize(objective, np.array([[-4., -4.], [0.1, 0.1]]).ravel(), method="BFGS")
        if not np.all(np.isfinite(result.x)):
            raise ValueError("EV trend fitting failed")
        return result.x.reshape(2, 2)

    errors = {"multinomial_trend": [], "last_observed_share": []}
    backtests = []
    for n in range(4, len(records)):
        check(n / len(records))
        beta = fit(n)
        for horizon in range(1, min(3, len(records) - n) + 1):
            j = n + horizon - 1
            predictions = {
                "multinomial_trend": softmax(np.r_[np.array([1., years[j] - years[0]]) @ beta, 0.]),
                "last_observed_share": counts[n - 1] / fleet[n - 1],
            }
            for model, shares in predictions.items():
                residual = counts[j, :2] - shares[:2] * fleet[j]
                errors[model].append((residual / fleet[j]).tolist())
                backtests.append({"model": model, "trainThrough": int(years[n - 1]), "year": int(years[j]),
                                  "horizon": horizon, "actualBev": float(bev[j]), "actualPhev": float(phev[j]),
                                  "predictedBev": float(shares[0] * fleet[j]), "predictedPhev": float(shares[1] * fleet[j])})
    scores = {k: float(np.mean(np.abs(v))) for k, v in errors.items()}
    selected = min(scores, key=lambda k: (scores[k], k))
    beta = fit(len(records))
    residuals = np.abs(np.asarray(errors[selected]))
    width = np.quantile(residuals, .8, axis=0) if len(residuals) >= 5 else None
    rows = []
    for year in range(int(years[-1]) + 1, end_year + 1):
        h = year - years[-1]
        future_fleet = float(fleet[-1] * (1 + float(fleet_growth)) ** h)
        for scenario, multiplier in (("slower", .75), ("baseline", 1.), ("faster", 1.25)):
            if selected == "multinomial_trend":
                logits = np.array([1., years[-1] - years[0]]) @ beta + h * multiplier * beta[1]
                shares = softmax(np.r_[logits, 0.])
            else:
                shares = counts[-1] / fleet[-1]
            for index, vehicle in enumerate(("BEV", "PHEV", "OTHER")):
                value = float(shares[index] * future_fleet)
                row = {"year": year, "scenario": scenario, "vehicle": vehicle, "count": value,
                       "share": float(shares[index]), "total": future_fleet, "kind": "forecast", "geographyId": records[-1].get("geographyId"),
                       "intervalInterpretation": "Extrapolated beyond validated horizons" if h > 3 else "Empirical backtest error envelope; not a calibrated probability interval"}
                if width is not None and index < 2:
                    spread = float(width[index] * future_fleet * math.sqrt(h))
                    row.update(lower=max(0., value - spread), upper=min(future_fleet, value + spread))
                rows.append(row)
    history = [{"year": int(y), "vehicle": v, "count": float(counts[i, j]), "share": float(counts[i, j] / fleet[i]),
                "total": float(fleet[i]), "kind": "observed", "scenario": "observed", "geographyId": records[i].get("geographyId")} for i, y in enumerate(years) for j, v in enumerate(("BEV", "PHEV", "OTHER"))]
    return {"rows": history + rows, "backtests": backtests, "model": selected, "selectionErrors": scores,
            "assumptions": {"fleetGrowth": float(fleet_growth), "endYear": end_year, "trendMultipliers": [.75, 1., 1.25],
                            "geography": records[-1].get("geographyLevel"), "chargingDemand": "Not inferred"},
            "modelCard": {"status": "experimental", "method": "Multinomial time trend versus last-observed-share, rolling 1–3 year holdouts",
                          "trainingYears": years.tolist(), "sources": [r.get("sourceUrl") for r in records if r.get("sourceUrl")],
                          "uncertainty": "Error envelopes describe historical errors; 2035 values are scenario extrapolations"}}


def pv_capacity(area, efficiency=.2, tilt=0.):
    if not all(math.isfinite(float(x)) for x in (area, efficiency, tilt)) or area < 0 or not 0 < efficiency <= 1 or not 0 <= tilt < 85:
        raise ValueError("PV area, efficiency, or tilt is invalid")
    module_area = area / math.cos(math.radians(tilt))
    return {"projectedAreaM2": area, "moduleAreaM2": module_area, "estimatedKwDc": module_area * efficiency,
            "assumptions": {"efficiency": efficiency, "tiltDegrees": tilt, "irradianceWm2": 1000,
                            "capacityBasis": "DC estimate, not reported nameplate or AC capacity"},
            "efficiencySensitivityKwDc": {"at15Percent": module_area * .15, "at23Percent": module_area * .23}}
