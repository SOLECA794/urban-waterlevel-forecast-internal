"""在线预测服务：把训练好的模型、滚动修正、三因子研判、评估结算串成一条链路。

一个周期（默认 60s）做四件事：
1. **取数**：从实时缓冲区取最近 24h 的统一特征（features.py）
2. **预测**：4 个预见期各出点值 + 90% 区间；再按 PCHIP 插值成 5min 密曲线
3. **修正**：滚动修正（correction.py）叠加系统性偏差；物理约束钳制
4. **研判**：三因子联合出预警等级（rules.py），并把"预测 vs 实际"落库评估

预测曲线插值为什么用 PCHIP 而不是线性/样条：
- 线性会在 1h/3h 等节点出现折角，图上很假；
- 三次样条会过冲，可能插出比所有预见期都高的假峰值（预报里这叫 overshoot，很危险）；
- PCHIP 保单调、不过冲，符合"水位不会在两个已预测点之间凭空冒出尖峰"的物理直觉。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from waterlog.service.agent import AgentDecision, decide
from waterlog.config import (HORIZONS_MIN, HORIZONS_STEPS, N_SITES, SITE_IDS, SITE_BY_ID,
                     STEP_MIN, WARMUP_STEPS)
from waterlog.domain.correction import RollingCorrector
from waterlog.domain.features import build_features, col
from waterlog.ml.models import load_bundle
from waterlog.domain.rules import assess_from_forecast, assess_observed
from waterlog.infra.store import Dataset, EvalStore, load_rules

SLOPE_COL = col("slope_1h")

# 条款 8-4：实测判定的回溯窗口。取 3h —— 比最短预见期长、比最长预见期短，
# 既够覆盖「涨起来又退下去」的一整段过程，又不会把昨天那场雨算进今天的告警。
OBSERVED_WINDOW_MIN = 180
OBSERVED_WINDOW_STEPS = OBSERVED_WINDOW_MIN // STEP_MIN


# ------------------------------------------------------------------ 插值

def _edge_slope(h0: float, h1: float, d0: float, d1: float) -> float:
    d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
    if d * d0 <= 0:
        return 0.0
    if abs(d) > 3 * abs(d0):
        return 3 * d0
    return float(d)


def pchip(xk: np.ndarray, yk: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Fritsch-Carlson 单调保形三次插值。"""
    xk = np.asarray(xk, dtype=float)
    yk = np.asarray(yk, dtype=float)
    x = np.asarray(x, dtype=float)
    n = xk.size
    h = np.diff(xk)
    delta = np.diff(yk) / h
    d = np.zeros(n)
    for k in range(1, n - 1):
        if delta[k - 1] * delta[k] <= 0:
            d[k] = 0.0
        else:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            d[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k])
    d[0] = _edge_slope(h[0], h[1], delta[0], delta[1]) if n > 2 else delta[0]
    d[-1] = _edge_slope(h[-1], h[-2], delta[-1], delta[-2]) if n > 2 else delta[-1]

    idx = np.clip(np.searchsorted(xk, x) - 1, 0, n - 2)
    t = (x - xk[idx]) / h[idx]
    t2, t3 = t * t, t * t * t
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    return h00 * yk[idx] + h10 * h[idx] * d[idx] + h01 * yk[idx + 1] + h11 * h[idx] * d[idx + 1]


# ------------------------------------------------------------------ 实时缓冲

class LiveBuffer:
    """滚动保存最近若干步的统一数据集（与训练时同构，保证特征口径一致）。"""

    def __init__(self, ds: Dataset, window: int = WARMUP_STEPS):
        self.window = window
        self.ds = ds.slice_tail(window)

    def push(self, out: dict, start_ts: int) -> None:
        n = out["step"].size
        ts = (start_ts + np.arange(n) * STEP_MIN * 60).astype(np.int64)
        ds = self.ds
        new = Dataset(
            ts=ts, level=out["level"], rain=out["rain"],
            rain_fc_1h=out["rain_fc_1h"], rain_fc_3h=out["rain_fc_3h"],
            rain_fc_6h=out["rain_fc_6h"], rain_fc_12h=out["rain_fc_12h"],
            quality=out["quality"],
        )
        merged = Dataset(
            ts=np.concatenate([ds.ts, new.ts])[-self.window:],
            level=np.concatenate([ds.level, new.level])[-self.window:],
            rain=np.concatenate([ds.rain, new.rain])[-self.window:],
            rain_fc_1h=np.concatenate([ds.rain_fc_1h, new.rain_fc_1h])[-self.window:],
            rain_fc_3h=np.concatenate([ds.rain_fc_3h, new.rain_fc_3h])[-self.window:],
            rain_fc_6h=np.concatenate([ds.rain_fc_6h, new.rain_fc_6h])[-self.window:],
            rain_fc_12h=np.concatenate([ds.rain_fc_12h, new.rain_fc_12h])[-self.window:],
            quality=np.concatenate([ds.quality, new.quality])[-self.window:],
        )
        self.ds = merged

    @property
    def now_ts(self) -> int:
        return int(self.ds.ts[-1])


# ------------------------------------------------------------------ 服务

@dataclass
class SiteForecast:
    site_id: str
    now_level: float
    horizons: list[dict] = field(default_factory=list)
    curve: list[list[float]] = field(default_factory=list)     # [offset_min, level, lower, upper]
    warning: dict = field(default_factory=dict)
    decision: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"site_id": self.site_id, "now_level": round(self.now_level, 4),
                "horizons": self.horizons, "curve": self.curve,
                "warning": self.warning, "decision": self.decision}


class ForecastService:
    def __init__(self, ds: Dataset, bundle: dict | None = None):
        self.buf = LiveBuffer(ds)
        self.bundle = bundle or load_bundle()
        self.rules = load_rules()
        self.corrector = RollingCorrector()
        self.store = EvalStore()
        self.last_forecast: dict[str, SiteForecast] = {}
        # 每个站点本轮研判实际用的 (now_level, 5min 加密曲线)——
        # 规则预演要拿"同一条预报"重判，不能让用户看到"模型也变了"的混合结果。
        self.last_series: dict[str, tuple[float, list[float]]] = {}
        self.last_cycle_ts = 0
        self.cycle_count = 0
        self._dense_offsets = np.arange(0, HORIZONS_MIN[-1] + STEP_MIN, STEP_MIN)

    # ------------------------------------------------------------ 修正器热启动

    def warmup_corrector(self, ds: Dataset, span_steps: int = 288 * 3) -> None:
        """用最近 3 天的历史做一次"离线回放"，让修正器一开始就有误差样本，
        否则刚启动的 1h 内修正强度为 0，在线修正看起来像没生效。"""
        origins = np.arange(max(WARMUP_STEPS, len(ds) - span_steps), len(ds) - HORIZONS_STEPS[-1] - 1, 6)
        if origins.size == 0:
            return
        sites = np.tile(np.arange(N_SITES), origins.size)
        o = np.repeat(origins, N_SITES)
        for hmin, hstep in zip(HORIZONS_MIN, HORIZONS_STEPS):
            X = build_features(ds, o, sites, hstep)
            # 注意：_predict 返回的是**增量**，而误差统计必须是绝对水位对绝对水位。
            # 早先这里直接拿增量当预测值去比实测，误差均值直接飙到 +7.8m（≈基准水位），
            # 修正器于是每轮加 3 米，整条曲线被顶到上限。别再把两种量纲混用。
            yhat = ds.level[o, sites] + self._predict(X, sites, hstep)
            actual = ds.level[o + hstep, sites]
            for i, sid in enumerate(SITE_IDS):
                m = sites == i
                for p, a in zip(yhat[m], actual[m]):
                    self.corrector.observe(sid, hmin, float(p), float(a))

    def _predict(self, X: np.ndarray, sites: np.ndarray, hstep: int) -> np.ndarray:
        """返回**增量**预测（米）。"""
        gbr = self.bundle["models"][str(hstep * STEP_MIN)]
        pred_gbr = gbr.predict(X)
        # 线性外推基线：当前 1h 涨速 × 预见期小时数（列号按名字取，别写魔法下标）
        pred_lin = X[:, SLOPE_COL] * (hstep * STEP_MIN / 60.0)
        w_map = self.bundle["weights"][str(hstep * STEP_MIN)]
        w = np.array([w_map[s] for s in SITE_IDS])[sites]
        return w * pred_gbr + (1 - w) * pred_lin

    # ------------------------------------------------------------ 一个周期

    def cycle(self) -> dict:
        ds = self.buf.ds
        now_ts = self.buf.now_ts
        origin = len(ds) - 1
        sites = np.arange(N_SITES)

        # 各预见期的增量预测
        deltas: dict[int, np.ndarray] = {}
        for hmin, hstep in zip(HORIZONS_MIN, HORIZONS_STEPS):
            X = build_features(ds, np.full(N_SITES, origin), sites, hstep)
            deltas[hmin] = self._predict(X, sites, hstep)

        now_level = ds.level[origin].astype(float)
        quality = ds.quality[origin]
        out: dict[str, SiteForecast] = {}

        for i, sid in enumerate(SITE_IDS):
            site = SITE_BY_ID[sid]
            dec = decide(sid, self._signals(ds, origin, i), self.rules, self.corrector)
            self.store.add_decision(now_ts, sid, dec.should_forecast, dec.model,
                                    round(dec.gain, 3), dec.reason, dec.signals)

            hs: list[dict] = []
            for hmin in HORIZONS_MIN:
                raw = float(now_level[i] + deltas[hmin][i])
                corr = self.corrector.apply(sid, hmin, raw)
                sigma = float(self.bundle["sigma"][str(hmin)].get(sid, 0.05))
                # 修正量硬上限：不超过 3σ。修正器再出问题，也不允许把曲线推出置信带，
                # 这是一道防呆闸门，不是主逻辑（主逻辑在 correction.py 的增益设计）。
                applied = float(np.clip(corr.applied, -3 * sigma, 3 * sigma))
                level = raw + applied
                lo, hi = level - 1.6449 * sigma, level + 1.6449 * sigma
                # 物理约束：水深不能为负、不能突破 1.5m（真实内涝的街道调蓄上限）
                floor = site.base_level
                cap = site.base_level + 1.5
                level = float(np.clip(level, floor, cap))
                lo = float(np.clip(lo, floor, cap))
                hi = float(np.clip(hi, floor, cap))
                hs.append({"horizon_min": hmin, "level": round(level, 4),
                           "lower": round(lo, 4), "upper": round(hi, 4),
                           "delta": round(level - float(now_level[i]), 4),
                           "delta_raw": round(raw - float(now_level[i]), 4),
                           "corrected": round(applied, 4),
                           "gain": round(corr.gain, 3),
                           "sigma": round(sigma, 4),
                           "model": "blend",
                           "reason": corr.reason})

            # PCHIP 加密到 5min，锚点 (0, 现在水位)
            xk = np.array([0.0] + [float(h) for h in HORIZONS_MIN])
            yk = np.array([float(now_level[i])] + [h["level"] for h in hs])
            dense = pchip(xk, yk, self._dense_offsets)
            dense[0] = float(now_level[i])
            dense = np.clip(dense, site.base_level, site.base_level + 1.5)
            lo_k = np.array([float(now_level[i])] + [h["lower"] for h in hs])
            hi_k = np.array([float(now_level[i])] + [h["upper"] for h in hs])
            d_lo = np.clip(pchip(xk, lo_k, self._dense_offsets), site.base_level, site.base_level + 1.5)
            d_hi = np.clip(pchip(xk, hi_k, self._dense_offsets), site.base_level, site.base_level + 1.5)
            d_lo = np.minimum(d_lo, dense)
            d_hi = np.maximum(d_hi, dense)
            curve = [[int(o), round(float(v), 4), round(float(a), 4), round(float(b), 4)]
                     for o, v, a, b in zip(self._dense_offsets, dense, d_lo, d_hi)]

            series5 = [float(v) for v in dense[1:]]
            self.last_series[sid] = (float(now_level[i]), series5)
            warn = assess_from_forecast(sid, float(now_level[i]), series5,
                                        self.rules, self.rules.get("horizon_min", 180))
            # ---- 条款 8-4：实测越限判定（与上面的预测研判并列，不改其语义）
            # 回溯窗口取当前时刻往前 OBSERVED_WINDOW_STEPS 步，升序传入。
            obs_end = origin + 1
            obs_start = max(0, obs_end - OBSERVED_WINDOW_STEPS)
            obs_series = ds.level[obs_start:obs_end, i].astype(float)
            obs = assess_observed(sid, obs_series, self.rules, OBSERVED_WINDOW_MIN)
            obs_level = obs.level if len(obs_series) >= 2 else "none"

            # alarm_source：本次告警由哪一侧触发。两侧都报同一个站时叫 both，
            # 这是最需要值班员立刻看的组合（既在下、预测还要涨）。
            fc_hit = warn.level != "none"
            ob_hit = obs_level != "none"
            if fc_hit and ob_hit:
                alarm_source = "both"
            elif ob_hit:
                alarm_source = "observed"
            elif fc_hit:
                alarm_source = "forecast"
            else:
                alarm_source = "none"

            # observed_thr_name：实测判定所依据的那一档阈值名。
            # peak_level 是 assess() 按实测峰值推出来的档位，超阈持续就是按它算的。
            obs_thr_name = obs.peak_level
            warning = {
                "site_id": sid, "level": warn.level, "score": warn.score,
                "peak_value": round(warn.peak_value, 4), "peak_level": warn.peak_level,
                "peak_at_min": warn.peak_at_min, "duration_min": warn.duration_min,
                "slope_mh": warn.slope_mh, "reason": warn.reason, "blocked_by": warn.blocked_by,
                "factors": {"peak": round(warn.factors.peak_norm, 3),
                            "duration": round(warn.factors.duration_norm, 3),
                            "trend": round(warn.factors.trend_norm, 3),
                            "score": warn.score},
                "thresholds": list(site.thresholds), "horizon_min": self.rules.get("horizon_min", 180),
                # ---- 条款 8-4 新增：实测越限判定（与上面 4 个字段语义正交）
                "observed_level": obs_level,
                "observed_reason": obs.reason,
                "observed_over_min": obs.duration_min,
                "observed_thr_name": obs_thr_name,
                "observed_score": round(obs.score, 4),
                "observed_window_min": OBSERVED_WINDOW_MIN,
                "observed_peak_value": round(obs.peak_value, 4),
                # 此刻是否仍在超阈 —— 与 observed_level 是两个事实，
                # 界面必须两个都说，否则「红色预警 + 当前未超阈」会自相矛盾。
                "observed_still_over": bool(obs.__dict__.get("still_over", False)),
                "alarm_source": alarm_source,
            }
            sf = SiteForecast(site_id=sid, now_level=float(now_level[i]),
                              horizons=hs, curve=curve, warning=warning,
                              decision={"should_forecast": dec.should_forecast,
                                        "model": dec.model, "gain": round(dec.gain, 3),
                                        "reason": dec.reason, "signals": dec.signals})
            out[sid] = sf

            # 落库待结算
            self.store.add_predictions([
                (now_ts, now_ts + h["horizon_min"] * 60, sid, h["horizon_min"], "blend",
                 h["level"], h["delta_raw"] + float(now_level[i]), float(now_level[i]),
                 h["lower"], h["upper"])
                for h in hs])

        self.last_forecast = out
        self.last_cycle_ts = now_ts
        self.cycle_count += 1
        return {"issued_at": now_ts, "model_version": self.bundle.get("version", "unknown"),
                "step_min": STEP_MIN, "sites": {k: v.to_json() for k, v in out.items()}}

    def preview_rules(self, patch: dict) -> dict:
        """规则影响预演：拿**同一条已发布的预测曲线**，只换规则重算等级。

        为什么不重新预测：用户想知道的不是「改了规则以后模型会怎么预测」，
        而是「同样的预报，判级会变成什么样」。重跑一遍模型会把两件事混在一起，
        变化到底来自规则还是来自模型噪声就分不清了。
        """
        from waterlog.domain.rules import LEVEL_RANK
        from waterlog.infra.store import merge_rules

        base = self.rules
        cand = merge_rules(base, patch)
        changes = []
        for sid in SITE_IDS:
            item = self.last_series.get(sid)
            if item is None:
                continue
            now, series = item
            b = assess_from_forecast(sid, now, series, base, int(base.get("horizon_min", 180)))
            a = assess_from_forecast(sid, now, series, cand, int(cand.get("horizon_min", 180)))
            rb, ra = LEVEL_RANK.get(b.level, 0), LEVEL_RANK.get(a.level, 0)
            changes.append({
                "site_id": sid, "name": SITE_BY_ID[sid].name,
                "before_level": b.level, "before_score": round(b.score, 3),
                "after_level": a.level, "after_score": round(a.score, 3),
                "before_reason": b.reason, "after_reason": a.reason,
                "direction": "up" if ra > rb else ("down" if ra < rb else "same"),
            })
        changes.sort(key=lambda c: (c["direction"] == "same", -abs(c["after_score"] - c["before_score"])))
        return {
            "changes": changes,
            "summary": {
                "upgraded": sum(1 for c in changes if c["direction"] == "up"),
                "downgraded": sum(1 for c in changes if c["direction"] == "down"),
                "unchanged": sum(1 for c in changes if c["direction"] == "same"),
                "total": len(changes),
            },
        }

    def _signals(self, ds: Dataset, origin: int, i: int) -> dict:
        site = SITE_BY_ID[SITE_IDS[i]]
        h = float(ds.level[origin, i]) - site.base_level
        slope = float((ds.level[origin, i] - ds.level[origin - 12, i]))
        return {
            "rain_now": round(float(ds.rain[origin, i]), 2),
            "rain_sum_1h": round(float(ds.rain[origin - 12:origin + 1, i].sum() * STEP_MIN / 60), 2),
            "fc_1h": round(float(ds.rain_fc_1h[origin, i]), 2),
            "fc_3h": round(float(ds.rain_fc_3h[origin, i]), 2),
            "depth": round(h, 3),
            "slope_1h": round(slope, 3),
            "quality": int(ds.quality[origin, i]),
            "thr_blue": site.thresholds[0],
            "headroom_blue": round(site.thresholds[0] - h, 3),
        }

    # ------------------------------------------------------------ 结算

    def settle(self, now_ts: int) -> int:
        ds = self.buf.ds
        actual = {sid: float(ds.level[-1, i]) for i, sid in enumerate(SITE_IDS)}
        n = self.store.settle(now_ts, actual)
        if n:
            for sid, hmin, yhat, act in self.store.settled_since(now_ts):
                self.corrector.observe(sid, hmin, yhat, act)
        return n
