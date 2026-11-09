"""值班智能体（agent）：决定"这个站点此刻要不要算、用哪条模型、修正多重"。

需求里"时序模型 + AI 算法 + 智能体"三者融合，很多实现会把"智能体"做成一个聊天框，
那是套壳。这里把智能体落成一个**可解释的调度决策器**，它每一轮对每个站点输出：

    should_forecast : 是否值得跑一次完整推理（雨停了、水位平稳的站点降频）
    model           : 用哪条路径（blend / linear 兜底）
    gain            : 本次修正强度（来自滚动修正器的误差统计）
    reason          : 人话解释，直接展示在值班面板上
    signals         : 触发它做这个决定的证据

规则不是拍脑袋，而是照抄真实值班逻辑：
- 有雨、雨要来、已经涨、已经超过蓝色阈值、传感器异常 → 必须算
- 全都平静且刚算过 → 跳过，省算力（这就是"智能"的部分：不是无脑全量跑）
- 传感器劣化 → 降级到线性外推（模型特征不可信时，简单方法反而稳）
"""

from __future__ import annotations

from dataclasses import dataclass, field

from waterlog.config import STEP_MIN


@dataclass
class AgentDecision:
    site_id: str
    should_forecast: bool
    model: str
    gain: float
    reason: str
    signals: dict = field(default_factory=dict)


# 触发"必须算"的阈值（可解释、可调，不藏进模型权重里）
RAIN_NOW_TRIGGER = 0.8        # mm/h，当前在下
RAIN_FC_TRIGGER = 3.0         # mm，未来 1h 预报累积
SLOPE_TRIGGER = 0.04          # m/h，还在涨
QUIET_SKIP_MIN = 6            # 平静站点每 6 个周期算一次（30min）

_cycle = {"n": 0}


def decide(site_id: str, signals: dict, rules: dict, corrector) -> AgentDecision:
    _cycle["n"] += 1
    reasons: list[str] = []
    urgent = False

    rain_now = signals["rain_now"]
    fc_1h = signals["fc_1h"]
    depth = signals["depth"]
    slope = signals["slope_1h"]
    quality = signals["quality"]
    thr_blue = signals["thr_blue"]

    if rain_now >= RAIN_NOW_TRIGGER:
        urgent = True
        reasons.append(f"当前降雨 {rain_now:.1f}mm/h")
    if fc_1h >= RAIN_FC_TRIGGER:
        urgent = True
        reasons.append(f"未来 1h 预报 {fc_1h:.1f}mm")
    if slope >= SLOPE_TRIGGER:
        urgent = True
        reasons.append(f"1h 涨速 {slope:+.2f}m/h")
    if depth >= thr_blue * 0.8:
        urgent = True
        reasons.append(f"水深 {depth:.2f}m 接近蓝色阈值 {thr_blue:.2f}m")
    if quality == 0:
        urgent = True
        reasons.append("传感器数据劣化")

    # 平静站点降频：不是不算，是低频算
    should = urgent or (_cycle["n"] % QUIET_SKIP_MIN == 0)

    # 模型路径：传感器可信 → 融合模型；劣化 → 线性外推兜底
    model = "blend" if quality == 1 else "linear"

    gain = corrector.gain(site_id, int(rules.get("horizon_min", 180)))
    if gain > 0.05:
        reasons.append(f"历史系统性偏差触发修正 {gain:.2f}")

    if not reasons:
        reasons.append("无雨、水位平稳，按低频巡检")

    return AgentDecision(
        site_id=site_id, should_forecast=should, model=model,
        gain=float(gain), reason="；".join(reasons), signals=signals,
    )
