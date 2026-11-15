"""Raw FIRMS CSVs -> common-grid monthly tables -> harmonized calendar + validation -> web/public/data.

    python pipeline/build.py

Never pools raw counts across sensors. Each sensor is counted on the same 1 km grid as
"active cell-days" (a cell counts once per sensor per day, however many hotspots fell in it),
summed per 5 km block and calendar month. Months a sensor could not observe stay null.
"""
import calendar
import datetime as dt
import json
import pathlib

import numpy as np
import pandas as pd

import grid
import model

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "firms" / grid.REGION
OUT = ROOT / "web" / "public" / "data"
METHOD_VERSION = "firecal-2026.1"

# source -> (sensor, platform or None = from 'satellite' column, product, collection, processing)
SOURCES = {
    "MODIS_SP": ("MODIS", None, "MCD14ML", "C6.1", "SP"),
    "MODIS_NRT": ("MODIS", None, "MCD14DL", "C6.1", "NRT"),
    "VIIRS_SNPP_SP": ("VIIRS", "S-NPP", "VNP14IMGML", "C2", "SP"),
    "VIIRS_SNPP_NRT": ("VIIRS", "S-NPP", "VNP14IMGTDL_NRT", "C2", "NRT"),
    "VIIRS_NOAA20_SP": ("VIIRS", "NOAA-20", "VJ114IMGML", "C2", "SP"),
    "VIIRS_NOAA20_NRT": ("VIIRS", "NOAA-20", "VJ114IMGTDL_NRT", "C2", "NRT"),
}
MODIS_SAT = {"Terra": "Terra", "T": "Terra", "Aqua": "Aqua", "A": "Aqua"}
AQUA_START = dt.date(2002, 7, 4)       # first Aqua MODIS data
SNPP_END = dt.date(2026, 11, 2)        # S-NPP delivery ended 13:00 UTC (FIRMS, Oct 27 2026)
NOAA20_REFERENCE_FROM = (2026, 11)     # VIIRS reference platform switches to NOAA-20 this month
FIRST_MONTH = (2000, 11)


def conf_class(df):
    out = pd.Series("nominal", index=df.index)
    m = df.sensor == "MODIS"
    c = pd.to_numeric(df.confidence.where(m), errors="coerce")
    out[m & (c < 30)] = "low"
    out[m & (c >= 80)] = "high"
    v = df.confidence.astype(str).str.lower().str[0]
    out[~m & (v == "l")] = "low"
    out[~m & (v == "h")] = "high"
    return out


def load_hotspots():
    frames = []
    for src, (sensor, platform, product, coll, proc) in SOURCES.items():
        for f in sorted((RAW / src).glob("*.csv")):
            try:
                d = pd.read_csv(f, dtype={"confidence": str, "acq_time": str})
            except pd.errors.EmptyDataError:
                continue
            if d.empty:
                continue
            d["sensor"], d["product"], d["collection"], d["processing"] = sensor, product, coll, proc
            d["platform"] = platform or d.satellite.map(MODIS_SAT)
            frames.append(d)
    df = pd.concat(frames, ignore_index=True)
    if "type" not in df:
        df["type"] = np.nan
    df = df.rename(columns={"latitude": "lat", "longitude": "lon", "acq_date": "date", "acq_time": "time"})
    df["time"] = df.time.str.zfill(4)
    df = df.drop_duplicates(["sensor", "platform", "date", "time", "lat", "lon"])
    df["conf_class"] = conf_class(df)
    ix, iy = grid.cell_xy(df.lon, df.lat)
    df["cell"] = iy * grid.NX + ix
    df["block"] = grid.block_id(ix, iy)
    # Index uses vegetation/unknown-type detections that are not low confidence. NRT rows have no
    # 'type' field, so NRT detections in 1 km cells the archive flags as static sources (type 2,
    # e.g. industrial sites) are excluded too.
    static_cells = set(df.loc[df.type == 2, "cell"])
    nrt_static = df.type.isna() & df.cell.isin(static_cells)
    df["used"] = (~df.type.isin([1, 2, 3]) & ~nrt_static & (df.conf_class != "low")).astype(int)
    return df.sort_values(["date", "time"]).reset_index(drop=True)


def month_index(dates):
    d = pd.to_datetime(dates)
    return (d.dt.year - FIRST_MONTH[0]) * 12 + d.dt.month - FIRST_MONTH[1]


def coverage(days, months):
    """Fraction of each month's days present in the set `days`."""
    out = np.zeros(len(months))
    for t, (y, m) in enumerate(months):
        n = calendar.monthrange(y, m)[1]
        out[t] = sum(dt.date(y, m, d) in days for d in range(1, n + 1)) / n
    return out


def covered_days(src):
    """Days actually downloaded: each cached file covers 5 days from its start date, clipped to the
    requested end in _range.json. Missing windows stay uncovered, so gaps read as 'not observed'."""
    f = RAW / src / "_range.json"
    end = dt.date.fromisoformat(json.loads(f.read_text())["end"]) if f.exists() else dt.date.max
    days = set()
    for c in (RAW / src).glob("*.csv"):
        d = dt.date.fromisoformat(c.stem)
        days.update(x for x in (d + dt.timedelta(k) for k in range(5)) if x <= end)
    return days


def main():
    df = load_hotspots()
    days = {s: covered_days(s) for s in SOURCES}
    ranges = {s: (min(d), max(d)) if d else None for s, d in days.items()}
    obs_end = max(r[1] for r in ranges.values() if r)
    months = []
    y, m = FIRST_MONTH
    while (y, m) <= (obs_end.year, obs_end.month):
        months.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    T, shape = len(months), (len(months), grid.NBY, grid.NBX)

    modis = days["MODIS_SP"] | days["MODIS_NRT"]
    cov = {
        "terra": coverage(modis, months),
        "aqua": coverage({d for d in modis if d >= AQUA_START}, months),
        "npp": coverage({d for d in days["VIIRS_SNPP_SP"] | days["VIIRS_SNPP_NRT"] if d <= SNPP_END}, months),
        "n20": coverage(days["VIIRS_NOAA20_SP"] | days["VIIRS_NOAA20_NRT"], months),
    }

    # Active cell-days per platform group, summed to block-months.
    used = df[df.used == 1]
    groups = {"terra": used.platform == "Terra", "aqua": used.platform == "Aqua",
              "modis": used.sensor == "MODIS", "npp": used.platform == "S-NPP", "n20": used.platform == "NOAA-20"}
    arr = {}
    for g, sel in groups.items():
        cd = used.loc[sel, ["date", "cell", "block"]].drop_duplicates(["date", "cell"])
        a = np.zeros(shape)
        bt = month_index(cd.date).to_numpy()
        np.add.at(a, (bt, cd.block.to_numpy() // grid.NBX, cd.block.to_numpy() % grid.NBX), 1)
        arr[g] = a
    frp = np.zeros(shape)
    mu = used[used.sensor == "MODIS"]
    np.add.at(frp, (month_index(mu.date).to_numpy(), mu.block.to_numpy() // grid.NBX, mu.block.to_numpy() % grid.NBX),
              mu.frp.to_numpy())

    moy = np.array([mm for _, mm in months])
    t_year = np.repeat([yy for yy, _ in months], grid.NBY * grid.NBX)
    full = lambda c: np.repeat(c >= 0.999, grid.NBY * grid.NBX)
    is_n20_ref = np.array([(yy, mm) >= NOAA20_REFERENCE_FROM for yy, mm in months])

    # Training rows: months fully seen by Terra, Aqua and S-NPP.
    y = arr["npp"].ravel()
    train = full(cov["terra"]) & full(cov["aqua"]) & full(cov["npp"])
    if not train.any():
        raise SystemExit("No months fully observed by both MODIS and VIIRS S-NPP yet: download the overlap years.")
    Xf = model.features(arr["modis"], moy, {"terra": arr["terra"], "aqua": arr["aqua"], "frp": np.log1p(frp)})
    Xt = model.features(arr["terra"], moy)
    val_full = model.loyo(Xf, y, train, t_year, shape)
    val_terra = model.loyo(Xt, y, train, t_year, shape)

    pred_full = model.Model(val_full["chosen"]).fit(Xf[train], y[train]).predict(Xf).reshape(shape)
    pred_terra = model.Model(val_terra["chosen"]).fit(Xt[train], y[train]).predict(Xt).reshape(shape)

    # Calendar: observed VIIRS where the reference platform saw the whole month (or the current,
    # partial month); otherwise the MODIS-based estimate; otherwise null.
    current = T - 1
    src, cal = [], np.full(shape, np.nan)
    for t in range(T):
        ref, rc = ("n20", cov["n20"][t]) if is_n20_ref[t] else ("npp", cov["npp"][t])
        if rc >= 0.999 or (t == current and rc > 0):
            cal[t] = arr[ref][t]
            src.append("VIIRS NOAA-20 observed" if ref == "n20" else "VIIRS S-NPP observed")
        elif cov["aqua"][t] >= 0.999:
            cal[t] = pred_full[t]
            src.append(f"Estimated from MODIS Terra+Aqua ({val_full['chosen']})")
        elif cov["terra"][t] >= 0.999:
            cal[t] = pred_terra[t]
            src.append(f"Estimated from MODIS Terra only ({val_terra['chosen']})")
        else:
            src.append(None)

    # S-NPP vs NOAA-20 continuity on months both fully observed.
    both = (cov["npp"] >= 0.999) & (cov["n20"] >= 0.999)
    a, b = arr["npp"][both].sum(axis=(1, 2)), arr["n20"][both].sum(axis=(1, 2))
    continuity = {"months": int(both.sum()), "noaa20_over_snpp_total": None, "spearman": None, "mae_log": None}
    if both.sum() >= 3:
        continuity.update({
            "noaa20_over_snpp_total": float(b.sum() / max(a.sum(), 1)),
            "spearman": float(pd.Series(a).corr(pd.Series(b), method="spearman")),
            "mae_log": float(np.mean(np.abs(np.log1p(a) - np.log1p(b)))),
        })

    write_outputs(df, months, cov, arr, cal, src, val_full, val_terra, continuity, ranges, obs_end)


def nullable(a, ok):
    return [None if not o else (round(float(v), 2) if not float(v).is_integer() else int(v)) for v, o in zip(a, ok)]


def write_outputs(df, months, cov, arr, cal, src, val_full, val_terra, continuity, ranges, obs_end):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hotspots").mkdir(exist_ok=True)
    labels = [f"{y}-{m:02d}" for y, m in months]
    blocks, series = [], {}
    last = np.arange(len(months)) == len(months) - 1
    seen = {k: (c >= 0.999) | (last & (c > 0)) for k, c in cov.items()}  # raw values only for fully covered months
    for b in range(grid.NBX * grid.NBY):
        by, bx = divmod(b, grid.NBX)
        blocks.append({"id": b, "bounds": grid.block_bounds(b)})
        series[b] = {
            "cal": nullable(cal[:, by, bx], ~np.isnan(cal[:, by, bx])),
            "modis": nullable(arr["modis"][:, by, bx], seen["terra"]),
            "npp": nullable(arr["npp"][:, by, bx], seen["npp"]),
            "n20": nullable(arr["n20"][:, by, bx], seen["n20"]),
        }
    mask = ROOT / "data" / "work" / f"viirs_mask_monthly_{grid.REGION}.npz"
    if mask.exists():  # optional: VIIRS clear / cloud / missing cell-days from VNP14A1 (pipeline/masks.py)
        z = np.load(mask)
        idx = {m: i for i, m in enumerate(z["months"].tolist())}
        for b in range(grid.NBX * grid.NBY):
            by, bx = divmod(b, grid.NBX)
            c = [z["counts"][idx[l], :, by, bx] if l in idx else None for l in labels]
            series[b]["vc"] = [None if x is None else int(x[0]) for x in c]   # clear cell-days
            series[b]["vt"] = [None if x is None else int(x.sum()) for x in c]  # all cell-days with a mask
    monthly = {"months": labels, "source": src,
               "coverage": {k: np.round(v, 3).tolist() for k, v in cov.items()}, "blocks": series}
    (OUT / "monthly.json").write_text(json.dumps(monthly, separators=(",", ":")))
    (OUT / "blocks.json").write_text(json.dumps(blocks, separators=(",", ":")))

    for v in (val_full, val_terra):
        v["months"] = [labels[t] for t in v.pop("months_t")]
    (OUT / "validation.json").write_text(json.dumps(
        {"terra_aqua": val_full, "terra_only": val_terra, "continuity_snpp_noaa20": continuity}, indent=1))

    cols = ["date", "time", "lat", "lon", "sensor", "platform", "product", "collection", "processing",
            "confidence", "conf_class", "frp", "daynight", "type", "block", "used"]
    for yr, g in df.groupby(df.date.str[:4]):
        g[cols].to_csv(OUT / "hotspots" / f"{yr}.csv", index=False, lineterminator="\n")

    meta = {
        "method_version": METHOD_VERSION,
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "data": "NASA FIRMS active fire hotspots (real data, not synthetic)",
        "region": {"id": grid.REGION, "name": grid.REGION_NAME, "short": grid.CFG["short"], "bbox": [grid.W, grid.S, grid.E, grid.N],
                   "focus": grid.CFG["focus"], "presets": grid.CFG["presets"], "events": grid.CFG.get("events", {})},
        "n_hotspots": int(len(df)), "n_qualifying": int(df.used.sum()),
        "grid": {"cell_km": grid.CELL_KM, "block_km": grid.CELL_KM * grid.BLOCK_CELLS,
                 "nbx": grid.NBX, "nby": grid.NBY},
        "observations_through": str(obs_end),
        "sources": {s: {"product": p, "collection": c, "processing": pr,
                        "start": str(ranges[s][0]) if ranges[s] else None,
                        "end": str(ranges[s][1]) if ranges[s] else None}
                    for s, (_, _, p, c, pr) in SOURCES.items()},
        "snpp_end": str(SNPP_END),
        "unit": "active cell-days: 1 km grid cells x days with at least one qualifying hotspot",
        "qualifying_hotspot": "type not volcano/static/offshore (1,2,3) and confidence not low "
                              "(MODIS >= 30, VIIRS nominal or high)",
        "interval_full": val_full["interval_log1p_q10_q90"],
        "interval_terra": val_terra["interval_log1p_q10_q90"],
        "chosen_full": val_full["chosen"],
        "chosen_terra": val_terra["chosen"],
        "hotspot_years": sorted(df.date.str[:4].unique().tolist()),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    write_results_md(val_full, val_terra, continuity, meta, len(df), int(df.used.sum()))
    print(json.dumps({k: meta[k] for k in ("observations_through", "chosen_full", "chosen_terra")}))
    for name, v in (("Terra+Aqua", val_full), ("Terra only", val_terra)):
        print(name, {m: round(v["metrics"][m]["mae_log"], 3) for m in model.METHODS}, v["bootstrap_95"])
    print("continuity", continuity)


def write_results_md(vf, vt, cont, meta, n_all, n_used):
    """data/work/RESULTS_<region>.md: a readable summary generated from the same numbers as validation.json."""
    names = {"unadjusted": "Unadjusted MODIS", "ratio": "Overlap ratio", "seasonal": "Seasonal Poisson regression (#1)",
             "gbm": "Gradient-boosted Poisson model (#3)"}

    def table(v):
        rows = ["| Method | MAE log(1+x) ↓ | MAE (cell-days) | RMSE | Bias | Rank corr. | Annual error (median) |",
                "| --- | --- | --- | --- | --- | --- | --- |"]
        for m in model.METHODS:
            k = v["metrics"][m]
            mark = " **(used)**" if m == v["chosen"] else ""
            rows.append(f"| {names[m]}{mark} | {k['mae_log']:.3f} | {k['mae']:.1f} | {k['rmse']:.1f} | {k['bias_pct']:+.0f}% "
                        f"| {k['spearman']:.2f} | {k['annual_median_abs_pct']:.0f}% |")
        b = v["bootstrap_95"]
        rows.append("")
        rows.append("95% year-bootstrap interval of the difference in MAE log (GBM minus other; negative = GBM better): " +
                    "; ".join(f"vs {k.split('_minus_')[1]}: [{lo:+.3f}, {hi:+.3f}]" for k, (lo, hi) in b.items()))
        return "\n".join(rows)

    per_year = "| Year | " + " | ".join(names[m].split(" (")[0] for m in model.METHODS) + " |\n|" + " --- |" * 5 + "\n" + "\n".join(
        f"| {y} | " + " | ".join(f"{vf['per_year'][m][y]:.3f}" for m in model.METHODS) + " |" for y in sorted(vf["per_year"]["gbm"]))
    text = f"""# Results (generated by pipeline/build.py — do not edit by hand)

Real NASA FIRMS data, {meta['region']['name']}, bbox {meta['region']['bbox']}; observations through
{meta['observations_through']}; built {meta['generated_utc']}; method {meta['method_version']}.
{n_all:,} original hotspot records, {n_used:,} qualifying (not low confidence, not static/offshore).

## MODIS → VIIRS translation, leave-one-year-out ({vf['years'][0]}–{vf['years'][-1]})

Each year is predicted by models trained on the other years and compared with VIIRS S-NPP active
cell-days for the whole region, month by month. Primary metric, fixed before results: mean absolute
error of log(1 + monthly activity). {vf['n_train_rows']:,} training block-months.

### Terra + Aqua (used for July 2002 – 2011)

{table(vf)}

### Terra only (used for November 2000 – June 2002)

{table(vt)}

### Per held-out year, MAE log (Terra + Aqua)

{per_year}

80% interval applied to estimated months (log(1+x) residual quantiles, region-month): {vf['interval_log1p_q10_q90'][0]:+.3f} to {vf['interval_log1p_q10_q90'][1]:+.3f}.

## VIIRS continuity: NOAA-20 vs S-NPP

{"Not enough months observed by both yet." if cont['spearman'] is None else
 f"Over {cont['months']} months fully observed by both: NOAA-20 recorded {cont['noaa20_over_snpp_total'] * 100:.0f}% of S-NPP's active cell-days; rank correlation {cont['spearman']:.2f}; MAE log {cont['mae_log']:.3f}."}
"""
    (ROOT / "data" / "work").mkdir(parents=True, exist_ok=True)
    (ROOT / "data" / "work" / f"RESULTS_{grid.REGION}.md").write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
