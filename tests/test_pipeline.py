import datetime as dt
import json
import pathlib
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "pipeline"))
import build  # noqa: E402
import grid  # noqa: E402
import model  # noqa: E402

DATA = pathlib.Path(__file__).resolve().parents[1] / "web" / "public" / "data"


def test_grid_corners_and_block_bounds():
    fx, fy, _ = grid.CFG["focus"]
    lon = np.array([grid.W, grid.E, fx])
    lat = np.array([grid.S, grid.N, fy])
    ix, iy = grid.cell_xy(lon, lat)
    assert (ix >= 0).all() and (ix < grid.NX).all() and (iy >= 0).all() and (iy < grid.NY).all()
    b = grid.block_id(ix[2], iy[2])  # the region's focus point lies inside its own block
    w, s, e, n = grid.block_bounds(int(b))
    assert w <= fx <= e and s <= fy <= n


def test_confidence_classes():
    df = pd.DataFrame({"sensor": ["MODIS", "MODIS", "MODIS", "VIIRS", "VIIRS", "VIIRS"],
                       "confidence": ["29", "30", "80", "l", "n", "h"]})
    assert build.conf_class(df).tolist() == ["low", "nominal", "high", "low", "nominal", "high"]


def test_partial_month_coverage():
    lo, hi = dt.date(2012, 1, 20), dt.date(2026, 11, 2)
    days = {d for d in (lo + dt.timedelta(k) for k in range(6000)) if d <= hi}
    c = build.coverage(days, [(2012, 1), (2012, 2), (2026, 11), (2026, 12)])
    assert c.tolist() == pytest.approx([12 / 31, 1.0, 2 / 30, 0.0])


def test_ratio_recovers_known_factor():
    rng = np.random.default_rng(0)
    cells = rng.poisson(3, size=(24, 4, 5)).astype(float)
    X = model.features(cells, np.tile(np.arange(1, 13), 2))
    y = 2.5 * X["cells"].to_numpy()
    m = model.Model("ratio").fit(X, y)
    assert m.r == pytest.approx(2.5)
    assert model.Model("seasonal").fit(X, y).predict(X).shape == y.shape


@pytest.mark.skipif(not (DATA / "monthly.json").exists(), reason="run pipeline/build.py first")
def test_calendar_output_keeps_no_data_distinct():
    m = json.loads((DATA / "monthly.json").read_text())
    for b in m["blocks"].values():
        for t, src in enumerate(m["source"]):
            v = b["cal"][t]
            if src is None:
                assert v is None  # no observation is null, never zero
            else:
                assert v is not None and v >= 0
            if src == "VIIRS S-NPP observed":
                assert v == b["npp"][t]  # observed months are VIIRS values, unmodified
        # VIIRS S-NPP did not exist before 2012: null, not zero
        assert all(x is None for x in b["npp"][: m["months"].index("2012-01")])
