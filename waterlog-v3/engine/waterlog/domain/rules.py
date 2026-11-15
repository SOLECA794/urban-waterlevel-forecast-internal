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
           horizon_min: int | None = None,
           apply_min_duration: bool = True,
           now_index: int = 0) -> WarningResult:
    """level_series: 当前时刻起、等间隔 STEP_MIN 的水位序列（含 t0 与未来）。

    apply_min_duration: 是否应用「持续门槛降级」。预测序列必须应用（还没发生的
    事不能凭一瞬就报高级），实测序列不应用（已经漫过去了是既成事实）——
    见 assess_observed() 的口径说明。
    now_index: 序列里哪一端是「当前」。预测序列的当前在开头（0），实测序列的
    当前在结尾（-1）。这道参数只服务于下面那条「既成事实」下限。
    """
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
    # 持续时间门槛：峰值到了但没持续够，不允许报这么高的等级。
    # 实测序列不走这道闸——水已经漫过阈值是既成事实（见 apply_min_duration）。
    if apply_min_duration and level != "none" and duration_min < need:
        blocked = f"超阈持续 {duration_min}min < {need:.0f}min 门槛，降级"
        allowed = [name for name in LEVELS if duration_min >= float(min_dur.get(name, 0))]
        cap = allowed[-1] if allowed else "none"
        if LEVEL_RANK.get(cap, 0) < LEVEL_RANK.get(level, 0):
            level = cap

    # 趋势跨档：猛涨升一级、明显退水降一级
    up = float(rules.get("trend_upgrade_slope", 0.25))
    down = float(rules.get("trend_downgrade_slope", -0.15))
    up_level = False
    down_level = False
    if level != "none" and slope >= up:
        i = LEVELS.index(level)
        if i < len(LEVELS) - 1:
            level = LEVELS[i + 1]
            up_level = True
            blocked = None
    elif level != "none" and slope <= down:
        i = LEVELS.index(level)
        level = LEVELS[i - 1] if i > 0 else "none"
        down_level = True

    min_level = int(rules.get("min_level_for_alarm", 1))
    if level != "none" and LEVEL_RANK[level] < min_level:
        level = "none"

    # ---- 既成事实下限
    # 三因子分档允许「退水」把等级压下来（趋势因子只拿 20% 权重），可它压不出
    # 「现在水里还泡着 3.19m、红阈只有 0.46m，却报橙色」这种读感。凡是当前
    # 水深仍高于某一档阈值，等级不得低于那一档——这一条不看趋势，只看事实。
    now_h = float(h[now_index])
    floor = "none"
    for name in LEVELS:
        if now_h >= float(thr[LEVELS.index(name)]):
            floor = name
    floored = False
    if LEVEL_RANK.get(floor, 0) > LEVEL_RANK.get(level, 0):
        level = floor
        floored = True
        blocked = None

    reason = (f"峰值 {peak_h:.2f}m（{peak_level}，第 {i_peak * STEP_MIN}min）、"
              f"超阈持续 {duration_min}min、1h 趋势 {slope:+.2f}m/h → 综合分 {score:.2f}")
    if up_level:
        reason += "（猛涨升一级）"
    elif down_level:
        reason += "（明显退水降一级）"
    if floored:
        reason += f"；但当前仍超{LEVEL_LABEL[floor]}阈（{now_h:.2f}m ≥ {thr[LEVELS.index(floor)]:.2f}m），按既成事实不再降级"
    reason += f" → {LEVEL_LABEL[level]}"

    result = WarningResult(
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
    # `still_over` 是「此刻是否仍在峰值档阈值之上」。assess_observed() 要拿它决定
    # 措辞是「目前仍在超阈」还是「现已回落至阈值以下」——这个字段此前只被读、
    # 从来没被写过，于是每一句实测结论都在说「已回落」，哪怕还泡在三米水里。
    result.__dict__["still_over"] = bool(now_h >= float(thr[max(LEVEL_RANK.get(peak_level, 1) - 1, 0)]))
    return result

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


def assess_observed(site_id: str, observed_levels: np.ndarray, rules: dict,
                    window_min: int | None = None) -> WarningResult:
    """条款 8-4：对**实测回溯序列**做越限判定。

    与 `assess_from_forecast` 的区别在输入语义，不在算法：
      - 预测判定喂的是 `[现在, +1h, +3h, +6h, +12h]`，回答「未来会不会淹」；
      - 实测判定喂的是 `[3h前, ..., 现在]`，回答「现在是不是已经淹了、淹了多久」。

    两者共用同一套三因子与分档规则，所以「同一个站，预测说橙、实测说蓝」
    这种组合是合法且有意义的：说明雨还没落到地上，或者刚下但还没汇起来。

    `observed_levels` 必须按时间升序（最早在前、当前最后），这样 `assess()`
    内部的 `slope = (末 - 首) / 小时数` 天然就是「过去这段涨了多少 m/h」，
    与预测序列的斜率方向语义一致，不需要翻转。
    """
    series = np.asarray(observed_levels, dtype=float)
    # 实测侧取消持续门槛降级：水已经漫过某档阈值就是既成事实，
    # 不该因为「还没泡够 60 分钟」把红色压成黄色。趋势跨档与等级兜底仍然生效。
    res = assess(site_id, series, rules, window_min, apply_min_duration=False, now_index=-1)

    # ---- 重算「连续超阈」：assess() 给的是窗口内累计，实测侧要的是当前这一段。
    # 从序列末尾往前数，直到第一次跌破 peak_level 对应阈值为止。
    site = SITE_BY_ID[site_id]
    thr_now = site.thresholds[max(LEVEL_RANK.get(res.peak_level, 1) - 1, 0)]
    h = series - site.base_level
    run = 0
    for v in h[::-1]:
        if v >= thr_now:
            run += 1
        else:
            break
    res.duration_min = run * STEP_MIN
    # 顺手记一个「这一段是不是就从窗口开头一路超下来的」——
    # 是的话说明雨还在持续，界面可以据此说「仍在超阈」而不是「超阈已 X 分钟」。
    res.__dict__['over_run_at_edge'] = (run == len(h))

    # assess() 的 reason 是照「未来序列」写的（「峰值 Xm（第 Ymin）」指的是
    # 预测序列里第 Y 分钟会到峰值）。对回溯序列必须改口径，否则值班员会
    # 把「过去 3h 里最高出现在第 120min」误读成「还有 2 小时才到峰值」。
    n = len(series)
    span_min = (n - 1) * STEP_MIN
    ago_min = (n - 1 - int(round(res.peak_at_min / STEP_MIN))) * STEP_MIN
    rise = float(series[-1] - series[0])
    # 「连续超阈」是当前这一段，不是累计——见上面的重算说明。
    # 文案必须同时回答两个问题：曾达哪一档、现在什么状态。只报 level 会在
    # 「涨过又退了」的站上产生「红色预警但当前未超阈」这种自相矛盾的读感。
    if not res.__dict__.get('still_over'):
        now_txt = "现已回落至阈值以下"
    elif res.__dict__.get('over_run_at_edge'):
        now_txt = f"目前仍在超阈，已持续 {res.duration_min}min"
    else:
        now_txt = f"目前仍在超阈 {res.duration_min}min"
    res.reason = (f"实测近 {span_min}min 峰值 {res.peak_value:.2f}m（曾达{LEVEL_LABEL[res.peak_level]}，"
                  f"出现在 {ago_min}min 前）、{now_txt}、"
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")
    return res


def assess_from_forecast(site_id: str, current_level: float, forecast_levels: list[float],
                         rules: dict, horizon_min: int | None = None) -> WarningResult:
    series = np.concatenate([[current_level], np.asarray(forecast_levels, dtype=float)])
    # 预测侧始终应用持续门槛：这是「提前预警」与「虚惊一场」之间的分界线。
    return assess(site_id, series, rules, horizon_min, apply_min_duration=True)
