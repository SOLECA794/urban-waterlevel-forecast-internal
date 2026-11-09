"""预警等级研判：三因子联合。

老师需求 §2.3 明确要求不能只看"水位超没超阈值"，要三个因子联合：
    1. 预测峰值（peak）—— 峰值多高
    2. 超阈持续（duration）—— 超阈值持续多久（短时超一下不报警）
    3. 变化趋势（trend）—— 还在涨还是在退（加速上涨升级，下降降级）

实现方式：三个因子各自归一化到 [0,1]，加权成综合评分，再按可配置分档切等级；
趋势因子在评分之外还做一次"跨档升降"（这是防汛值班员的直觉：猛涨时必须提前一级）。
所有阈值、权重、分档都来自 rules.json，可在前端热改。

等级色与前端 tokens.css 的蓝/黄/橙/红一一对应，不在这里定义颜色。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from waterlog.config import SITE_BY_ID, SITES, STEP_MIN

LEVELS = ("blue", "yellow", "orange", "red")
LEVEL_RANK = {name: i + 1 for i, name in enumerate(LEVELS)}
LEVEL_LABEL = {"blue": "蓝色预警", "yellow": "黄色预警", "orange": "橙色预警", "red": "红色预警", "none": "无预警"}


@dataclass
class FactorDetail:
    peak: float
    duration: float
    trend: float
    peak_norm: float
    duration_norm: float
    trend_norm: float
    score: float


@dataclass
class WarningResult:
    level: str
    score: float
    factors: FactorDetail
    peak_level: str
    peak_value: float
    peak_min: int
    peak_at_min: int | None
    duration_min: int
    slope_mh: float
    reason: str
    blocked_by: str | None = None


def _level_from_ratio(ratio: float) -> str:
    if ratio >= 1.0:
        return "red"
    if ratio >= 0.72:
        return "orange"
    if ratio >= 0.42:
        return "yellow"
    if ratio >= 0.18:
        return "blue"
    return "none"


def _ratio(peak_m: float, thr: tuple[float, float, float, float]) -> float:
    """把峰值水深映射成"相对红色阈值的比例"，同时考虑中间档的跨越程度。"""
    blue, yellow, orange, red = thr
    if peak_m <= 0:
        return 0.0
    if peak_m < blue:
        return 0.18 * peak_m / max(blue, 1e-6) * 0.5
    if peak_m < yellow:
        return 0.18 + 0.24 * (peak_m - blue) / max(yellow - blue, 1e-6)
    if peak_m < orange:
        return 0.42 + 0.30 * (peak_m - yellow) / max(orange - yellow, 1e-6)
    if peak_m < red:
        return 0.72 + 0.28 * (peak_m - orange) / max(red - orange, 1e-6)
    return 1.0 + min(0.5, (peak_m - red) / max(red, 1e-6))


def assess(site_id: str, level_series: np.ndarray, rules: dict,
           horizon_min: int | None = None) -> WarningResult:
    """level_series: 当前时刻起、等间隔 STEP_MIN 的水位序列（含 t0 与未来）。"""
    site = SITE_BY_ID[site_id]
    thr = site.thresholds
    hmin = horizon_min or int(rules.get("horizon_min", 180))
    n = max(2, min(len(level_series), hmin // STEP_MIN + 1))
    seg = np.asarray(level_series[:n], dtype=float)
    h = seg - site.base_level

    # ---- 因子 1：峰值
    i_peak = int(np.argmax(h))
    peak_h = float(h[i_peak])
    peak_ratio = _ratio(peak_h, thr)
    peak_level = _level_from_ratio(peak_ratio)
    peak_norm = float(np.clip(peak_ratio, 0.0, 1.0))

    # ---- 因子 2：超阈持续（按当前预警档位的阈值算）
    idx = max(LEVEL_RANK.get(peak_level, 1) - 1, 0)
    thr_now = thr[idx] if peak_level != "none" else thr[0]
    over = h >= thr_now
    duration_steps = int(over.sum())
    duration_min = duration_steps * STEP_MIN
    sat = float(rules.get("duration_saturation_min", 180))
    min_dur = rules.get("min_duration_min", {})
    need = float(min_dur.get(peak_level, 20)) if peak_level != "none" else 0.0
    duration_norm = float(np.clip(duration_min / max(sat, 1.0), 0.0, 1.0))

    # ---- 因子 3：趋势（近 1h 斜率，m/h）
    k = min(len(h) - 1, max(1, 60 // STEP_MIN))
    slope = float((h[k] - h[0]) / (k * STEP_MIN / 60.0))
    span = float(rules.get("trend_score_span", 0.5))
    trend_norm = float(np.clip((slope + span) / (2 * span), 0.0, 1.0))

    w = rules.get("weights", {})
    score = (float(w.get("peak", 0.45)) * peak_norm
             + float(w.get("duration", 0.35)) * duration_norm
             + float(w.get("trend", 0.20)) * trend_norm)

    # ---- 分档
    cuts = rules.get("score_cutoffs", {})
    level = "none"
    for name in LEVELS:
        if score >= float(cuts.get(name, 1.0)):
            level = name

    blocked = None
    # 持续时间门槛：峰值到了但没持续够，不允许报这么高的等级
    if level != "none" and duration_min < need:
        blocked = f"超阈持续 {duration_min}min < {need:.0f}min 门槛，降级"
        allowed = [name for name in LEVELS if duration_min >= float(min_dur.get(name, 0))]
        cap = allowed[-1] if allowed else "none"
        if LEVEL_RANK.get(cap, 0) < LEVEL_RANK.get(level, 0):
            level = cap

    # 趋势跨档：猛涨升一级、明显退水降一级
    up = float(rules.get("trend_upgrade_slope", 0.25))
    down = float(rules.get("trend_downgrade_slope", -0.15))
    if level != "none" and slope >= up:
        i = LEVELS.index(level)
        if i < len(LEVELS) - 1:
            level = LEVELS[i + 1]
            blocked = None
    elif level != "none" and slope <= down:
        i = LEVELS.index(level)
        level = LEVELS[i - 1] if i > 0 else "none"

    min_level = int(rules.get("min_level_for_alarm", 1))
    if level != "none" and LEVEL_RANK[level] < min_level:
        level = "none"

    reason = (f"峰值 {peak_h:.2f}m（{peak_level}，第 {i_peak * STEP_MIN}min）、"
              f"超阈持续 {duration_min}min、1h 趋势 {slope:+.2f}m/h → 综合分 {score:.2f} → "
              f"{LEVEL_LABEL[level]}")

    return WarningResult(
        level=level, score=round(score, 4),
        factors=FactorDetail(peak=peak_h, duration=duration_min, trend=slope,
                             peak_norm=round(peak_norm, 4),
                             duration_norm=round(duration_norm, 4),
                             trend_norm=round(trend_norm, 4),
                             score=round(score, 4)),
        peak_level=peak_level, peak_value=peak_h,
        peak_min=i_peak * STEP_MIN, peak_at_min=i_peak * STEP_MIN,
        duration_min=duration_min, slope_mh=round(slope, 4),
        reason=reason, blocked_by=blocked,
    )


def assess_from_forecast(site_id: str, current_level: float, forecast_levels: list[float],
                         rules: dict, horizon_min: int | None = None) -> WarningResult:
    series = np.concatenate([[current_level], np.asarray(forecast_levels, dtype=float)])
    return assess(site_id, series, rules, horizon_min)
