"""MODIS -> VIIRS-equivalent translation on block-months, with leave-one-year-out validation.

Unit: active 1 km cell-days per 5 km block per calendar month.
Methods compared (same features available back to 2000):
  unadjusted  MODIS active cell-days as-is
  ratio       one overlap-period VIIRS/MODIS ratio
  seasonal    Poisson regression, intercept and slope per season (method #1, baseline)
  gbm         gradient-boosted Poisson correction on top of the seasonal regression, using MODIS cells,
              Terra and Aqua separately, neighbours, adjacent months,
              fire radiative power, regional activity, month and location (method #3)
The method used for pre-VIIRS months is the one with the lowest held-out error on the
pre-declared primary metric: mean absolute error of log(1 + region-month activity).
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import PoissonRegressor

METHODS = ["unadjusted", "ratio", "seasonal", "gbm"]
PRIMARY = "mae_log"
SEASON = np.array([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0])  # Jan..Dec -> DJF, MAM, JJA, SON


def _neighbours(a):
    p = np.pad(a, ((0, 0), (1, 1), (1, 1)))
    return sum(p[:, 1 + dy : 1 + dy + a.shape[1], 1 + dx : 1 + dx + a.shape[2]]
               for dy in (-1, 0, 1) for dx in (-1, 0, 1)) - a


def _shift(a, k):
    out = np.zeros_like(a)
    if k > 0:
        out[k:] = a[:-k]
    else:
        out[:k] = a[-k:]
    return out


def features(primary, month_of_year, extra=None):
    """Feature table, one row per (t, by, bx), from arrays shaped [T, NBY, NBX]."""
    T, NY, NX = primary.shape
    t, by, bx = np.meshgrid(np.arange(T), np.arange(NY), np.arange(NX), indexing="ij")
    cols = {
        "cells": primary,
        "neigh": _neighbours(primary),
        "prev": _shift(primary, 1),
        "next": _shift(primary, -1),
        "region": np.broadcast_to(primary.sum(axis=(1, 2))[:, None, None], primary.shape),
        "month": month_of_year[t],
        "bx": bx,
        "by": by,
    }
    for k, v in (extra or {}).items():
        cols[k] = v
    return pd.DataFrame({k: np.asarray(v, dtype=float).ravel() for k, v in cols.items()})


class Model:
    def __init__(self, method):
        self.method = method

    def fit(self, X, y):
        if self.method == "ratio":
            self.r = y.sum() / max(X["cells"].sum(), 1)
        elif self.method == "seasonal":
            self.cmax, self.nmax = X["cells"].max(), X["neigh"].max()
            self.m = PoissonRegressor(alpha=1e-4, fit_intercept=False, max_iter=3000).fit(self._design(X), y)
        elif self.method == "gbm":
            # Boosted correction on top of the seasonal regression: Poisson trees fit y / base with
            # weight base (a Poisson model with offset log(base)). Trees alone can't predict beyond
            # the largest training value, which would cap big pre-2012 fire months; scaling the
            # baseline keeps estimates proportional to what MODIS saw.
            self.base = Model("seasonal").fit(X, y)
            b = self.base.predict(X)
            self.m = HistGradientBoostingRegressor(
                loss="poisson", learning_rate=0.05, max_iter=300, max_leaf_nodes=15,
                min_samples_leaf=40, l2_regularization=1.0, random_state=0).fit(self._with(X, b), y / b, sample_weight=b)
        return self

    @staticmethod
    def _with(X, b):
        return X.assign(log_base=np.log(b))

    def predict(self, X):
        if self.method == "unadjusted":
            return X["cells"].to_numpy()
        if self.method == "ratio":
            return self.r * X["cells"].to_numpy()
        if self.method == "seasonal":
            # Beyond the largest training value, hold the VIIRS/MODIS ratio of the top of the
            # range constant instead of letting the power law run (it can bend steeply either way).
            c = X["cells"].to_numpy()
            ce = np.minimum(c, self.cmax)
            return self.m.predict(self._design(X)) * (c + 1) / (ce + 1)
        b = self.base.predict(X)
        return b * self.m.predict(self._with(X, b))

    def _design(self, X):
        s = SEASON[X["month"].to_numpy().astype(int) - 1]
        onehot = np.eye(4)[s]
        logc = np.log1p(np.minimum(X["cells"].to_numpy(), self.cmax))[:, None]
        logn = np.log1p(np.minimum(X["neigh"].to_numpy(), self.nmax))[:, None]
        return np.hstack([onehot, onehot * logc, logn])


def metrics(obs_r, pred_r, years, obs_b, pred_b):
    """obs_r/pred_r: region-month totals; years: year of each region-month; *_b: block-month values."""
    ann = pd.DataFrame({"y": years, "o": obs_r, "p": pred_r}).groupby("y").sum()
    ann_err = (ann.p - ann.o).abs() / ann.o.where(ann.o > 0)
    return {
        "mae_log": float(np.mean(np.abs(np.log1p(pred_r) - np.log1p(obs_r)))),
        "mae": float(np.mean(np.abs(pred_r - obs_r))),
        "rmse": float(np.sqrt(np.mean((pred_r - obs_r) ** 2))),
        "bias_pct": float(100 * (pred_r.sum() - obs_r.sum()) / max(obs_r.sum(), 1)),
        "spearman": float(pd.Series(pred_r).corr(pd.Series(obs_r), method="spearman")),
        "annual_median_abs_pct": float(100 * ann_err.median()),
        "block_mae": float(np.mean(np.abs(pred_b - obs_b))),
    }


def loyo(X, y, train_mask, t_year, shape, seed=0):
    """Leave-one-year-out predictions for every method on the training rows.

    Returns per-method region-month series, metrics, per-year primary metric, bootstrap
    intervals for the gbm-vs-baseline differences, and the chosen method.
    """
    rows = np.flatnonzero(train_mask)
    years = t_year[rows]
    pred = {m: np.full(len(rows), np.nan) for m in METHODS}
    for yr in np.unique(years):
        te, tr = years == yr, years != yr
        for m in METHODS:
            pred[m][te] = Model(m).fit(X.iloc[rows[tr]], y[rows[tr]]).predict(X.iloc[rows[te]])

    T = shape[0]
    t_idx = rows // (shape[1] * shape[2])
    ts = np.unique(t_idx)
    def region(v):
        return np.bincount(t_idx, weights=v, minlength=T)[ts]
    obs_r = region(y[rows])
    yr_r = t_year[ts * shape[1] * shape[2]]
    res = {"months_t": ts.tolist(), "obs": obs_r.tolist(), "pred": {}, "metrics": {}, "per_year": {}}
    for m in METHODS:
        pr = region(pred[m])
        res["pred"][m] = np.round(pr, 2).tolist()
        res["metrics"][m] = metrics(obs_r, pr, yr_r, y[rows], pred[m])
        res["per_year"][m] = {int(Y): float(np.mean(np.abs(np.log1p(pr[yr_r == Y]) - np.log1p(obs_r[yr_r == Y]))))
                              for Y in np.unique(yr_r)}

    # Year-block bootstrap of the primary-metric difference (negative = gbm better).
    rng = np.random.default_rng(seed)
    uy = np.unique(yr_r)
    err = {m: np.abs(np.log1p(np.array(res["pred"][m])) - np.log1p(obs_r)) for m in METHODS}
    boot = {}
    for base in ("seasonal", "ratio", "unadjusted"):
        diffs = []
        for _ in range(2000):
            pick = rng.choice(uy, len(uy))
            idx = np.concatenate([np.flatnonzero(yr_r == Y) for Y in pick])
            diffs.append(err["gbm"][idx].mean() - err[base][idx].mean())
        boot[f"gbm_minus_{base}"] = [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))]
    res["bootstrap_95"] = boot
    res["chosen"] = min(METHODS, key=lambda m: res["metrics"][m][PRIMARY])
    resid = np.log1p(obs_r) - np.log1p(np.array(res["pred"][res["chosen"]]))
    res["interval_log1p_q10_q90"] = [float(np.percentile(resid, 10)), float(np.percentile(resid, 90))]
    ann = pd.DataFrame({"y": yr_r, "o": obs_r, "p": res["pred"][res["chosen"]]}).groupby("y").sum()
    ann_resid = np.log1p(ann.o) - np.log1p(ann.p)
    res["interval_annual_log1p_q10_q90"] = [float(np.percentile(ann_resid, 10)), float(np.percentile(ann_resid, 90))]
    res["n_train_rows"] = int(len(rows))
    res["years"] = [int(Y) for Y in uy]
    return res
