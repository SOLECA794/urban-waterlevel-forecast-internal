"""统一特征工程。

需求原文要求"对异构数据做统一特征工程处理，输出一份统一数据集供模型用"。
这里就是那一层：把 站点静态属性 + 水位时序 + 实时雨量 + 气象预报 + 时间周期
拼成同一个特征矩阵，所有模型共用，保证模型之间可比。

三类特征：
1. **状态类**：当前水位、近 1h 水位滞后、涨速、加速度、3h 极值 → 回答"现在怎么样"
2. **驱动类**：实时雨强、累积雨量（30m/1h/3h/6h/12h/24h）、气象预报累积雨量
   → 回答"上游还有多少水要下来"（这是 3h 以上预见期能否有效的关键）
3. **静态类**：汇水面积、积水面积、不透水率、排水能力、各级阈值 → 回答"这个站点经不经得起"
"""

from __future__ import annotations

import numpy as np

from waterlog.config import N_SITES, SITES, STEP_MIN

# 站点静态矩阵（顺序与 SITES 一致）
_A_CATCH = np.array([s.catchment_ha for s in SITES])
_A_POND = np.array([s.pond_ha for s in SITES])
_IMPERV = np.array([s.impervious for s in SITES])
_DRAIN = np.array([s.drainage_mm_h for s in SITES])
_BASE = np.array([s.base_level for s in SITES])
_THR = np.array([s.thresholds for s in SITES])          # (N,4)
_RATIO = _A_POND / _A_CATCH

_LAGS = (0, 1, 2, 3, 6, 12)
_RAIN_WINDOWS = (6, 12, 36, 72, 144, 288)              # 30m/1h/3h/6h/12h/24h

FEATURE_NAMES: list[str] = (
    [f"level_lag{k}" for k in _LAGS]
    + ["d_level_1", "d_level_3", "d_level_6", "d_level_12", "slope_1h", "accel"]
    + ["level_max_3h", "level_min_3h", "level_range_3h"]
    + ["rain_now", "rain_max_1h"]
    + [f"rain_sum_{w * STEP_MIN}m" for w in _RAIN_WINDOWS]
    + ["fc_1h", "fc_3h", "fc_6h", "fc_12h", "fc_excess_3h", "fc_excess_6h"]
    + ["impervious", "drain_mm_h", "catchment_ha", "pond_ha", "pond_ratio",
       "base_level", "thr_blue", "thr_yellow", "thr_orange", "thr_red",
       "headroom_red", "saturation"]
    + ["hour_sin", "hour_cos", "dow_sin", "dow_cos", "month_sin", "month_cos"]
)

N_FEATURES = len(FEATURE_NAMES)
_COL_INDEX = {name: i for i, name in enumerate(FEATURE_NAMES)}


def col(name: str) -> int:
    """按特征名取列号。别写魔法下标——之前把 d_level_12 写成 4 号列（其实是 level_lag6），
    线性基线直接算成 8 米误差，整个融合权重被带偏。"""
    return _COL_INDEX[name]


def _cumsum(arr: np.ndarray) -> np.ndarray:
    return np.concatenate([np.zeros((1, arr.shape[1])), np.cumsum(arr, axis=0)], axis=0)


def _rolling_max(arr: np.ndarray, window: int, origins: np.ndarray, sites: np.ndarray) -> np.ndarray:
    stack = np.stack([arr[origins - k, sites] for k in range(window)], axis=0)
    return stack.max(axis=0)


def build_features(ds, origins: np.ndarray, sites: np.ndarray, horizon_steps: int) -> np.ndarray:
    """(M, F) 特征矩阵。origins/sites 等长，逐行是一个 (时间点, 站点) 样本。"""
    o = np.asarray(origins, dtype=np.int64)
    s = np.asarray(sites, dtype=np.int64)
    L, R = ds.level, ds.rain
    C = _cumsum(R)

    def lag(arr, k):
        return arr[o - k, s]

    level = [lag(L, k) for k in _LAGS]
    l0, l1, l2, l3, l6, l12 = level
    d1, d3, d6, d12 = (l0 - l1, l0 - l3, l0 - l6, l0 - l12)

    mx3 = _rolling_max(L, 36, o, s)
    mn3 = np.stack([L[o - k, s] for k in range(36)], axis=0).min(axis=0)

    rain_now = lag(R, 0)
    rain_max_1h = np.stack([R[o - k, s] for k in range(12)], axis=0).max(axis=0)
    rain_sums = [C[o + 1, s] - C[o + 1 - w, s] for w in _RAIN_WINDOWS]

    fc1 = lag(ds.rain_fc_1h, 0)
    fc3 = lag(ds.rain_fc_3h, 0)
    fc6 = lag(ds.rain_fc_6h, 0)
    fc12 = lag(ds.rain_fc_12h, 0)
    drain = _DRAIN[s]
    fc_excess_3h = fc3 - drain * 3.0
    fc_excess_6h = fc6 - drain * 6.0

    h0 = l0 - _BASE[s]
    thr_red = _THR[s, 3]

    ts = ds.ts[o].astype("datetime64[s]")
    local = ts + np.timedelta64(8, "h")          # 东八区
    hour = (local.astype("datetime64[h]") - local.astype("datetime64[D]")).astype(np.int64)
    dow = (local.astype("datetime64[D]").astype(np.int64) - 4) % 7      # 1970-01-01 是周四
    month = (local.astype("datetime64[M]").astype(np.int64) % 12).astype(np.float64)
    hour_frac = hour + (local.astype("datetime64[m]").astype(np.int64) % 60) / 60.0

    cols = [
        *level,
        d1, d3, d6, d12, l0 - l12, (l0 - 2 * l1 + l2),
        mx3, mn3, mx3 - mn3,
        rain_now, rain_max_1h,
        *rain_sums,
        fc1, fc3, fc6, fc12, fc_excess_3h, fc_excess_6h,
        _IMPERV[s], drain, _A_CATCH[s], _A_POND[s], _RATIO[s],
        _BASE[s], _THR[s, 0], _THR[s, 1], _THR[s, 2], thr_red,
        thr_red - h0, h0 / np.maximum(thr_red, 1e-6),
        np.sin(2 * np.pi * hour_frac / 24), np.cos(2 * np.pi * hour_frac / 24),
        np.sin(2 * np.pi * dow / 7), np.cos(2 * np.pi * dow / 7),
        np.sin(2 * np.pi * month / 12), np.cos(2 * np.pi * month / 12),
    ]
    X = np.stack([np.asarray(c, dtype=np.float64) for c in cols], axis=1)
    assert X.shape[1] == N_FEATURES, f"feature count mismatch {X.shape[1]} != {N_FEATURES}"
    return np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)


def build_target(ds, origins: np.ndarray, sites: np.ndarray, horizon_steps: int) -> np.ndarray:
    """预测目标取 **水位增量** 而不是绝对水位：
    增量更平稳、跨站点可比，且模型天然以当前观测为锚点，不会预测出与现状断裂的曲线。"""
    return ds.level[origins + horizon_steps, sites] - ds.level[origins, sites]


def valid_origins(ds, horizon_steps: int, start: int = 288) -> np.ndarray:
    """可用样本起点：留够 24h 历史与 12h 前瞻。"""
    last = len(ds) - horizon_steps - 1
    return np.arange(start, last)


def site_arrays():
    """给上层用的站点静态数组（阈值等）。"""
    return {"thr": _THR, "base": _BASE, "imperv": _IMPERV, "drain": _DRAIN}
