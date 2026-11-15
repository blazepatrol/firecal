"""VIIRS daily fire masks (VNP14A1 v002, HDF5) -> per-block-month clear / cloud / missing cell-days.

Separates "observed, no fire" from "hidden by cloud" and "no data" for VIIRS S-NPP months.
Needs an Earthdata login in ~/.netrc or ~/_netrc (machine urs.earthdata.nasa.gov ...);
credentials are never read or printed by this script, only used by requests via netrc.

    python pipeline/masks.py --start 2012-01-19 --end 2026-11-02     # download (resumable) + summarize

FireMask classes (VNP14A1 C2 user guide): 0-2 not processed, 3 water, 4 cloud, 5 land (no fire),
6 unknown, 7-9 fire (low/nominal/high). Clear = 3, 5 or 7-9.
Note: VNP14A1 is built from the 750 m VIIRS M-bands, while the FIRMS hotspots used for activity are
the 375 m I-band product, so the mask describes visibility, not the hotspot detections themselves.
"""
import argparse
import datetime as dt
import math
import pathlib

import h5py
import numpy as np
import requests

import grid

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "VNP14A1" / grid.REGION
WORK = ROOT / "data" / "work"
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
R = 6371007.181  # MODIS sinusoidal sphere radius (m)
TILE = 1111950.5197665
NPIX = 1200  # 1 km grid: 1200 x 1200 pixels per tile


def cell_pixels():
    """(tile 'hXXvYY', row, col) in the 1 km sinusoidal grid for every FireCal 1 km cell centre."""
    iy, ix = np.mgrid[0 : grid.NY, 0 : grid.NX]
    lon = grid.W + (ix + 0.5) * grid.CELL_KM / grid.KX
    lat = grid.S + (iy + 0.5) * grid.CELL_KM / grid.KY
    x = R * np.radians(lon) * np.cos(np.radians(lat)) + 20015109.354
    y = 10007554.677 - R * np.radians(lat)
    px = TILE / NPIX
    h, v = (x // TILE).astype(int), (y // TILE).astype(int)
    col = ((x - h * TILE) // px).astype(int).clip(0, NPIX - 1)
    row = ((y - v * TILE) // px).astype(int).clip(0, NPIX - 1)
    tile = np.char.add(np.char.add("h", np.char.zfill(h.astype(str), 2)), np.char.add("v", np.char.zfill(v.astype(str), 2)))
    return tile, row, col


def granules(start, end):
    page = 1
    while True:
        r = requests.get(CMR, params={"short_name": "VNP14A1", "version": "002", "page_size": 2000, "page_num": page,
                                      "bounding_box": f"{grid.W},{grid.S},{grid.E},{grid.N}",
                                      "temporal": f"{start}T00:00:00Z,{end}T23:59:59Z"}, timeout=120)
        r.raise_for_status()
        entries = r.json()["feed"]["entry"]
        if not entries:
            return
        for e in entries:
            url = next(l["href"] for l in e["links"] if l["href"].startswith("https") and l["href"].endswith(".h5"))
            yield url
        page += 1


def download(start, end):
    RAW.mkdir(parents=True, exist_ok=True)
    s = requests.Session()  # follows the URS redirect; netrc supplies the login, cookies keep the session
    urls = [u for u in granules(start, end) if not (RAW / u.rsplit("/", 1)[1]).exists()]
    print(f"VNP14A1: {len(urls)} files to download")
    for i, u in enumerate(urls, 1):
        r = s.get(u, timeout=300)
        if r.status_code == 401 or b"<html" in r.content[:200].lower():
            raise SystemExit("Earthdata login failed: check ~/_netrc (machine urs.earthdata.nasa.gov login ... password ...)")
        r.raise_for_status()
        tmp = RAW / (u.rsplit("/", 1)[1] + ".part")
        tmp.write_bytes(r.content)
        tmp.replace(RAW / u.rsplit("/", 1)[1])
        if i % 100 == 0:
            print(f"  {i}/{len(urls)}", flush=True)


def fire_mask(path):
    found = []
    with h5py.File(path, "r") as f:
        f.visititems(lambda n, o: found.append(n) if isinstance(o, h5py.Dataset) and n.endswith("FireMask") else None)
        return f[found[0]][()]


def summarize():
    """Daily cell states -> arrays [month, 3, NBY, NBX] of clear / cloud / missing cell-days."""
    tile, row, col = cell_pixels()
    iy, ix = np.mgrid[0 : grid.NY, 0 : grid.NX]
    blk = grid.block_id(ix, iy)
    out = {}
    for p in sorted(RAW.glob("VNP14A1.A*.h5")):
        parts = p.name.split(".")
        d, t = dt.datetime.strptime(parts[1][1:], "%Y%j").date(), parts[2]
        sel = tile == t
        if not sel.any():
            continue
        m = fire_mask(p)
        if m.ndim == 3:  # daily product should be 2-D; take the first layer if stacked
            m = m[0]
        cls = m[row[sel], col[sel]]
        clear = np.isin(cls, (3, 5, 7, 8, 9))
        cloud = cls == 4
        acc = out.setdefault((d.year, d.month), np.zeros((3, grid.NBY * grid.NBX)))
        for k, v in enumerate((clear, cloud, ~(clear | cloud))):
            np.add.at(acc[k], blk[sel], v)
    WORK.mkdir(parents=True, exist_ok=True)
    keys = sorted(out)
    counts = np.stack([out[k].reshape(3, grid.NBY, grid.NBX) for k in keys]) if keys else np.zeros((0, 3, grid.NBY, grid.NBX))
    np.savez_compressed(WORK / f"viirs_mask_monthly_{grid.REGION}.npz",
                        months=np.array([f"{y}-{m:02d}" for y, m in keys]), counts=counts)
    print(f"summarized {len(keys)} months")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=dt.date.fromisoformat, required=True)
    p.add_argument("--end", type=dt.date.fromisoformat, required=True)
    a = p.parse_args()
    download(a.start, a.end)
    summarize()
