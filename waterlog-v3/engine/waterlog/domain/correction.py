"""滚动修正（多源协同）。

老师需求 §2.4 要求"用最新实时监测修正、用最新气象预报修正、用已发生事件修正"。
这里落成一个可解释的在线模块，不是黑盒：

    ŷ_final(t+h) = ŷ_model(t+h) + K·(y_obs(t) − ŷ_model(t)) + β·(fc_new − fc_old)

- 第一项：**状态误差反馈**（类似卡尔曼的观测更新）。K 用自适应增益：
  最近该站点该预见期的误差越大，增益越高；但钳制在 [0, 0.6]，防止一次野值把曲线带飞。
- 第二项：**预报修正**。新气象预报与发报时用的旧预报不同时，按雨量差 × 站点敏感度 β 调整。
  β 由历史数据回归得到（站点对该预见期的"雨量→水位"弹性），不是拍脑袋常数。
- 第三项（事件修正）：已发生的内涝事件把该站点的经验阈值下调，体现在研判层而非预测层，
  避免污染预测。

修正强度全程记录，可以在前端"滚动修正"面板看到修正前后对比。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from waterlog.config import HORIZONS_MIN, SITE_BY_ID, SITE_IDS


@dataclass
class Correction:
    gain: float
    applied: float          # 实际加到预测上的量（米）
    innovation: float       # y_obs - y_model(now)
    reason: str


class RollingCorrector:
    """按 (站点, 预见期) 维护误差统计，给出自适应增益。"""

    def __init__(self, alpha: float = 0.15, k_max: float = 0.6, k_min: float = 0.05):
        self.alpha = alpha
        self.k_max = k_max
        self.k_min = k_min
        # err_mean[(site, horizon)] 与 err_abs_mean
        self.err_mean: dict[tuple[str, int], float] = {}
        self.err_abs: dict[tuple[str, int], float] = {}

    def observe(self, site_id: str, horizon_min: int, predicted: float, actual: float) -> None:
        key = (site_id, horizon_min)
        e = actual - predicted
        prev = self.err_mean.get(key, 0.0)
        self.err_mean[key] = (1 - self.alpha) * prev + self.alpha * e
        prev_abs = self.err_abs.get(key, 0.02)
        self.err_abs[key] = (1 - self.alpha) * prev_abs + self.alpha * abs(e)

    def gain(self, site_id: str, horizon_min: int) -> float:
        key = (site_id, horizon_min)
        if key not in self.err_abs:
            return 0.0
        # 误差越大 → 增益越大；但上限 0.6，且随预见期衰减（远期本来就不可信，少修）
        base = min(self.k_max, 1.6 * self.err_abs[key] / 0.05 * 0.25)
        decay = 1.0 / (1.0 + horizon_min / 360.0)
        return float(np.clip(base * decay, self.k_min if base > 0 else 0.0, self.k_max))

    def apply(self, site_id: str, horizon_min: int, yhat_model: float) -> Correction:
        """新息取该站点该预见期最近的系统性偏差（指数加权），而不是瞬时观测差。
        理由：瞬时差里混着传感器噪声，用它做反馈会把噪声灌进预测曲线；
        指数均值只保留偏差的慢变部分，这才是模型整体偏高/偏低的真实信号。"""
        k = self.gain(site_id, horizon_min)
        innovation = self.err_mean.get((site_id, horizon_min), 0.0)
        # 误差反馈随时间衰减：远期不做等量修正
        decay = 1.0 / (1.0 + horizon_min / 240.0)
        delta = k * innovation * decay
        if k <= 0:
            reason = "无历史误差样本，未修正"
        else:
            reason = f"系统性偏差 {innovation:+.3f}m × 增益 {k:.2f} × 远期衰减 {decay:.2f}"
        return Correction(gain=k, applied=float(delta), innovation=float(innovation), reason=reason)

    def state(self) -> dict:
        return {"err_abs": {f"{s}|{h}": round(v, 4) for (s, h), v in self.err_abs.items()},
                "err_mean": {f"{s}|{h}": round(v, 4) for (s, h), v in self.err_mean.items()}}

    def load(self, st: dict) -> None:
        self.err_abs = {}
        for k, v in st.get("err_abs", {}).items():
            s, h = k.split("|")
            self.err_abs[(s, int(h))] = float(v)
        self.err_mean = {}
        for k, v in st.get("err_mean", {}).items():
            s, h = k.split("|")
            self.err_mean[(s, int(h))] = float(v)


def rain_sensitivity(ds, horizon_steps: int) -> dict[str, float]:
    """站点对该预见期的"雨量→水位"弹性 β（m per mm），由历史数据回归。

    做法：对每个站点，用 (预测雨量累积, 水位增量) 做无截距最小二乘，钳制到合理区间。
    这是"用气象预报修正"能够成立的经验依据，而不是拍一个常数。
    """
    from waterlog.domain.features import build_features, build_target, valid_origins
    from waterlog.config import N_SITES

    origins = valid_origins(ds, horizon_steps)
    if origins.size < 100:
        return {s: 0.002 for s in SITE_IDS}
    origins = origins[::7]
    sites = np.tile(np.arange(N_SITES), origins.size)
    o = np.repeat(origins, N_SITES)
    X = build_features(ds, o, sites, horizon_steps)
    y = build_target(ds, o, sites, horizon_steps)
    fc_col = {"60": "fc_1h", "180": "fc_3h", "360": "fc_6h", "720": "fc_12h"}
    from waterlog.domain.features import FEATURE_NAMES
    col = FEATURE_NAMES.index(fc_col[str(horizon_steps * 5)])
    out: dict[str, float] = {}
    for i, sid in enumerate(SITE_IDS):
        m = sites == i
        x = X[m, col]
        denom = float(np.dot(x, x))
        beta = float(np.dot(x, y[m]) / denom) if denom > 1e-9 else 0.0
        out[sid] = float(np.clip(beta, 0.0, 0.02))
    return out
