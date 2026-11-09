"""预测模型：持久化基线 + 梯度提升 + 自适应融合（走前式分块交叉验证）。

为什么这样设计（答辩要点）：

1. **基线不是摆设**。持久化模型 y(t+h)=y(t) 是水文预报界的标准基线（persistence），
   任何模型必须打赢它才算有效。我们把它显式实现、显式报告，而不是偷偷比较。
2. **主模型预测增量而非绝对值**。Δy 更平稳，且天然以当前观测为锚，避免"预测曲线
   与实测断裂"这类答辩现场最容易被问倒的问题。
3. **融合权重按站点、按预见期独立学习**，不搞一个全局权重糊所有场景——
   短临靠惯性、长预见期靠雨量驱动，两者的最优权重天然不同。
4. **验证用分块交叉验证，不是"最后 10 天"**。内涝是稀有事件：如果验证窗口恰好没有
   暴雨，所有 Δy≈0，持久化基线几乎零误差，任何模型都会被判"不如基线"——这是指标假象，
   不是模型问题。把 60 天切成 3 块轮换验证，每块都含暴雨场次，指标才稳定可解释。
   同时**单独报告"事件样本"（预见期末真的超过蓝色阈值）上的指标**，因为业务关心的是
   "淹的时候准不准"，不是"不下雨的时候准不准"。
5. **残差修正**（在线滚动修正）单独一层，见 correction.py，不混进训练。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

from waterlog.config import HORIZONS_MIN, HORIZONS_STEPS, MODELS_DIR, N_SITES, SITE_IDS
from waterlog.domain.features import (FEATURE_NAMES, build_features, build_target, col,
                       site_arrays, valid_origins)
from waterlog.infra.store import model_path

SLOPE_COL = col("slope_1h")     # m/h，线性外推基线用


@dataclass
class HorizonMetrics:
    horizon_min: int
    rmse: float
    mae: float
    mape: float
    nse: float
    skill_vs_persistence: float
    crps: float
    picp90: float
    pinaw: float
    n: int


@dataclass
class TrainResult:
    version: str
    trained_at: int
    n_train: int
    n_valid: int
    train_seconds: float
    folds: int = 0
    metrics: dict[str, list[dict]] = field(default_factory=dict)
    weights: dict[str, dict[str, float]] = field(default_factory=dict)
    feature_importance: list[dict] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "version": self.version, "trained_at": self.trained_at,
            "n_train": self.n_train, "n_valid": self.n_valid,
            "train_seconds": round(self.train_seconds, 2), "folds": self.folds,
            "metrics": self.metrics, "weights": self.weights,
            "feature_importance": self.feature_importance,
        }


def _norm_cdf(x):
    from math import erf, sqrt
    v = np.vectorize(lambda t: 0.5 * (1 + erf(t / sqrt(2))))
    return v(x)


def _norm_pdf(x):
    return np.exp(-0.5 * x ** 2) / np.sqrt(2 * np.pi)


def _metrics(y, yhat, ybase, lower, upper, mask=None) -> dict:
    if mask is not None and int(mask.sum()) >= 20:
        y, yhat, ybase, lower, upper = y[mask], yhat[mask], ybase[mask], lower[mask], upper[mask]
    err = yhat - y
    rmse = float(np.sqrt(np.mean(err ** 2)))
    mae = float(np.mean(np.abs(err)))
    denom = np.maximum(np.abs(y), 0.02)
    mape = float(np.mean(np.abs(err) / denom) * 100)
    var = float(np.sum((y - y.mean()) ** 2))
    nse = float(1.0 - np.sum(err ** 2) / var) if var > 1e-9 else 0.0
    base_rmse = float(np.sqrt(np.mean((ybase - y) ** 2)))
    skill = float(1.0 - rmse / base_rmse) if base_rmse > 1e-9 else 0.0
    sigma = np.maximum((upper - lower) / (2 * 1.6449), 1e-4)
    z = err / sigma
    crps = float(np.mean(sigma * (z * (2 * _norm_cdf(z) - 1) + 2 * _norm_pdf(z) - 1 / np.sqrt(np.pi))))
    inside = ((y >= lower) & (y <= upper)).astype(float)
    return {"rmse": round(rmse, 4), "mae": round(mae, 4), "mape": round(mape, 2),
            "nse": round(nse, 4), "skill_vs_persistence": round(skill, 4),
            "crps": round(crps, 4), "picp90": round(float(np.mean(inside) * 100), 2),
            "pinaw": round(float(np.mean(upper - lower)), 4), "n": int(y.shape[0])}


def _blocks(origins: np.ndarray, n_folds: int) -> list[np.ndarray]:
    edges = np.linspace(0, origins.size, n_folds + 1).astype(int)
    return [origins[edges[i]:edges[i + 1]] for i in range(n_folds)]


def _fit(X: np.ndarray, y: np.ndarray) -> HistGradientBoostingRegressor:
    gbr = HistGradientBoostingRegressor(
        max_iter=260, learning_rate=0.06, max_depth=6,
        min_samples_leaf=40, l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.12, random_state=42,
    )
    gbr.fit(X, y)
    return gbr


def _xy(ds, origins: np.ndarray, hstep: int):
    sites = np.tile(np.arange(N_SITES), origins.size)
    o = np.repeat(origins, N_SITES)
    X = build_features(ds, o, sites, hstep)
    y = build_target(ds, o, sites, hstep)
    return X, y, o, sites


def train(ds, version: str | None = None, progress=None, n_folds: int = 3) -> TrainResult:
    t0 = time.time()
    version = version or time.strftime("v%Y%m%d-%H%M%S")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    result = TrainResult(version=version, trained_at=int(time.time()),
                         n_train=0, n_valid=0, train_seconds=0.0, folds=n_folds)
    bundle: dict = {"version": version, "models": {}, "sigma": {}, "weights": {},
                    "horizons": list(HORIZONS_MIN), "folds": n_folds}
    sa = site_arrays()
    base, thr = sa["base"], sa["thr"]

    for hi, (hmin, hstep) in enumerate(zip(HORIZONS_MIN, HORIZONS_STEPS)):
        blocks = _blocks(valid_origins(ds, hstep), n_folds)

        y_all, p_gbr, p_lin, s_all, lvl_all = [], [], [], [], []
        for k, va_o in enumerate(blocks):
            tr_o = np.concatenate([b for j, b in enumerate(blocks) if j != k])
            Xtr, ytr, _, _ = _xy(ds, tr_o, hstep)
            Xva, yva_k, ova, sva = _xy(ds, va_o, hstep)
            gbr = _fit(Xtr, ytr)
            p_gbr.append(gbr.predict(Xva))
            p_lin.append(Xva[:, SLOPE_COL] * (hmin / 60.0))
            y_all.append(yva_k)
            s_all.append(sva)
            lvl_all.append(ds.level[ova, sva])
            del Xtr, Xva

        yva = np.concatenate(y_all)
        pg = np.concatenate(p_gbr)
        pl = np.concatenate(p_lin)
        sv = np.concatenate(s_all)
        lv = np.concatenate(lvl_all)
        ybase = np.zeros_like(yva)          # 持久化基线：Δy = 0

        w_map: dict[str, float] = {}
        for sid_i, sid in enumerate(SITE_IDS):
            m = sv == sid_i
            best_w, best_rmse = 1.0, 1e9
            # 融合对象是「模型」与「持久化基线 Δy=0」：权重即对该站点该预见期的信任度。
            # 预见期越长、模型方差越大，学出来的权重会自然下压，等于自动保守化——
            # 这比固定系数讲得通，也比拿线性外推当融合对象靠谱（线性外推在退水期会一路外推到负值）。
            for w in np.linspace(0.0, 1.0, 21):
                blend = w * pg[m] + (1 - w) * ybase[m]
                r = float(np.sqrt(np.mean((blend - yva[m]) ** 2)))
                if r < best_rmse:
                    best_rmse, best_w = r, float(w)
            w_map[sid] = round(best_w, 2)

        w_vec = np.array([w_map[s] for s in SITE_IDS])[sv]
        pb = w_vec * pg + (1 - w_vec) * ybase

        resid = pb - yva
        sigma_by_site = {}
        for sid_i, sid in enumerate(SITE_IDS):
            m = sv == sid_i
            sigma_by_site[sid] = float(np.clip(np.std(resid[m]) if m.sum() > 30 else np.std(resid), 0.006, 0.6))
        sigma_vec = np.array([sigma_by_site[s] for s in SITE_IDS])[sv]
        z90 = 1.6449

        # 事件样本：预见期末水深 ≥ 蓝色阈值（"真的淹了"）
        event = (lv - base[sv] + yva) >= thr[sv, 0]

        for name, pred in (("persistence", ybase), ("linear", pl), ("gbr", pg), ("blend", pb)):
            lo, hi_ = pred - z90 * sigma_vec, pred + z90 * sigma_vec
            m = _metrics(yva, pred, ybase, lo, hi_)
            m["horizon_min"] = hmin
            me = _metrics(yva, pred, ybase, lo, hi_, event)
            m["event_rmse"] = me["rmse"]
            m["event_skill"] = me["skill_vs_persistence"]
            m["event_n"] = me["n"]
            result.metrics.setdefault(name, []).append(m)

        Xall, yall, _, _ = _xy(ds, valid_origins(ds, hstep), hstep)
        bundle["models"][str(hmin)] = _fit(Xall, yall)
        bundle["sigma"][str(hmin)] = sigma_by_site
        bundle["weights"][str(hmin)] = w_map
        result.weights[str(hmin)] = w_map
        result.n_train = int(Xall.shape[0])
        result.n_valid = int(yva.size)
        del Xall, yall
        if progress:
            progress(hi + 1, len(HORIZONS_MIN), hmin)

    # 特征重要性：置换重要性在 3h 模型上算一次（可解释性，答辩必问）
    try:
        from sklearn.inspection import permutation_importance
        hstep = HORIZONS_STEPS[1]
        va_o = _blocks(valid_origins(ds, hstep), n_folds)[-1][::6]
        Xv, yv, _, _ = _xy(ds, va_o, hstep)
        pi = permutation_importance(bundle["models"][str(HORIZONS_MIN[1])], Xv, yv,
                                    n_repeats=4, random_state=0, n_jobs=-1)
        order = np.argsort(pi.importances_mean)[::-1][:14]
        result.feature_importance = [
            {"name": FEATURE_NAMES[i], "importance": round(float(pi.importances_mean[i]), 5)}
            for i in order]
    except Exception as exc:
        result.feature_importance = [{"name": "unavailable", "importance": 0.0, "error": str(exc)}]

    bundle["feature_names"] = FEATURE_NAMES
    bundle["trained_at"] = result.trained_at
    bundle["train_seconds"] = round(time.time() - t0, 2)
    joblib.dump(bundle, model_path(version), compress=3)

    result.train_seconds = time.time() - t0
    (MODELS_DIR / "latest.txt").write_text(version, encoding="utf-8")
    return result


def load_bundle(version: str | None = None) -> dict:
    if version is None:
        f = MODELS_DIR / "latest.txt"
        if not f.exists():
            raise FileNotFoundError("尚未训练任何模型，请先执行 bootstrap")
        version = f.read_text(encoding="utf-8").strip()
    return joblib.load(model_path(version))
