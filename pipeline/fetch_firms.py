"""Download NASA FIRMS hotspots for one bounding box, 5 days per request, resumable.

Each response is cached as data/raw/firms/<SOURCE>/<start-date>.csv, so reruns skip finished windows.
The MAP_KEY is read from .env and never printed; it is scrubbed from any error text.

    python pipeline/fetch_firms.py --check
    python pipeline/fetch_firms.py --source MODIS_SP --start 2020-09-01 --end 2020-09-30
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time

import requests

import grid

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = "https://firms.modaps.eosdis.nasa.gov/api"
BBOX = ",".join(str(v) for v in grid.CFG["bbox"])  # W,S,E,N of the selected region
WINDOW = 5  # FIRMS area API maximum day range


def map_key() -> str:
    env = ROOT / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        k, _, v = line.partition("=")
        if k.strip() == "FIRMS_MAP_KEY" and v.strip():
            return v.strip()
    sys.exit("FIRMS_MAP_KEY missing: put FIRMS_MAP_KEY=<key> in .env (see .env.example)")


def get(path: str, key: str) -> str:
    try:
        for attempt in range(8):
            try:
                r = requests.get(f"{API}/{path.format(key=key)}", timeout=120)
            except requests.ConnectionError:  # network drop / sleep: back off and retry
                print(f"  network error; retry in {60 * (attempt + 1)}s", flush=True)
                time.sleep(60 * (attempt + 1))
                continue
            if r.ok and "transaction limit" not in r.text:
                break
            # Over the limit (rejected calls also count): wait out the 10-minute window; else brief back-off.
            wait = 660 if "limit" in r.text.lower() else 30 * (attempt + 1)
            print(f"  HTTP {r.status_code}: {r.text[:80].replace(key, '[MAP_KEY]')!r}; retry in {wait}s", flush=True)
            time.sleep(wait)
        r.raise_for_status()
    except requests.RequestException as e:
        raise RuntimeError(str(e).replace(key, "[MAP_KEY]")) from None
    if r.text.lstrip().lower().startswith(("invalid", "error")):
        raise RuntimeError(r.text[:200].replace(key, "[MAP_KEY]"))
    return r.text


def windows(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d, min(WINDOW, (end - d).days + 1)
        d += dt.timedelta(days=WINDOW)


def fetch(source: str, start: dt.date, end: dt.date, key: str) -> None:
    out = ROOT / "data" / "raw" / "firms" / grid.REGION / source
    out.mkdir(parents=True, exist_ok=True)
    todo = [(d, n) for d, n in windows(start, end) if not (out / f"{d}.csv").exists()]
    print(f"{source}: {len(todo)} requests to make")
    for i, (d, n) in enumerate(todo, 1):
        text = get(f"area/csv/{{key}}/{source}/{BBOX}/{n}/{d}", key)
        tmp = out / f"{d}.csv.part"
        tmp.write_text(text)
        tmp.replace(out / f"{d}.csv")  # only complete responses count as done
        if i % 50 == 0:
            print(f"  {i}/{len(todo)}")
        time.sleep(1.2)  # ~10 transactions per call -> stays under 5000 per 10 minutes
    # Record the covered date range; build.py uses it to tell "no detections" from "not downloaded".
    rng = out / "_range.json"
    old = json.loads(rng.read_text()) if rng.exists() else {"start": str(start), "end": str(end)}
    rng.write_text(json.dumps({"start": min(old["start"], str(start)), "end": max(old["end"], str(end))}))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true", help="show key quota and source date ranges")
    p.add_argument("--source")
    p.add_argument("--start", type=dt.date.fromisoformat)
    p.add_argument("--end", type=dt.date.fromisoformat)
    a = p.parse_args()
    key = map_key()
    if a.check:
        avail = get("data_availability/csv/{key}/all", key)
        out = ROOT / "data" / "raw" / "firms" / grid.REGION
        out.mkdir(parents=True, exist_ok=True)
        (out / "availability.csv").write_text(avail)  # read by build.py for last-observation dates
        print(avail)
        print(get("../mapserver/mapkey_status/?MAP_KEY={key}", key).replace(key, "[MAP_KEY]"))
        return
    if not (a.source and a.start and a.end):
        p.error("--source, --start and --end are required")
    fetch(a.source, a.start, a.end, key)


if __name__ == "__main__":
    main()
