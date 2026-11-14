# -*- coding: utf-8 -*-
"""8-4 实测判定口径修正：实测侧取消「持续门槛降级」。

用户决策（m33718）：实测侧取消持续门槛。水已经漫过某档阈值是既成事实，
不是预测，不应因「还没泡够 X 分钟」把等级压下来。

实现方式——不是把 level 硬改成 peak_level，那样会让「越过红阈一下就退回」
也报红，等于废掉 min_duration 的全部意义。真正要取消的只是**那一道降级闸**，
其余机制（趋势跨档、min_level_for_alarm 兜底）保持不动。

为此给 assess() 增加一个可选参数 `apply_min_duration: bool = True`，
默认行为完全不变（预测侧零影响），实测侧传 False。
"""
import io

p = 'engine/waterlog/domain/rules.py'
s = io.open(p, encoding='utf-8').read()

old_sig = '''def assess(site_id: str, level_series: np.ndarray, rules: dict,
           horizon_min: int | None = None) -> WarningResult:'''
assert s.count(old_sig) == 1, 'assess 签名锚点不唯一'

new_sig = '''def assess(site_id: str, level_series: np.ndarray, rules: dict,
           horizon_min: int | None = None,
           apply_min_duration: bool = True) -> WarningResult:'''
s = s.replace(old_sig, new_sig, 1)

old_doc = '''    """level_series: 当前时刻起、等间隔 STEP_MIN 的水位序列（含 t0 与未来）。"""'''
assert s.count(old_doc) == 1
new_doc = '''    """level_series: 当前时刻起、等间隔 STEP_MIN 的水位序列（含 t0 与未来）。

    apply_min_duration: 是否应用「持续门槛降级」。预测序列必须应用（还没发生的
    事不能凭一瞬就报高级），实测序列不应用（已经漫过去了是既成事实）——
    见 assess_observed() 的口径说明。
    """'''
s = s.replace(old_doc, new_doc, 1)

# 把降级闸包起来
old_gate = '''    blocked = None
    # 持续时间门槛：峰值到了但没持续够，不允许报这么高的等级
    if level != "none" and duration_min < need:'''
assert s.count(old_gate) == 1
new_gate = '''    blocked = None
    # 持续时间门槛：峰值到了但没持续够，不允许报这么高的等级。
    # 实测序列不走这道闸——水已经漫过阈值是既成事实（见 apply_min_duration）。
    if apply_min_duration and level != "none" and duration_min < need:'''
s = s.replace(old_gate, new_gate, 1)

# assess_from_forecast 显式传 True，把意图写死在调用点
old_af = '''    series = np.concatenate([[current_level], np.asarray(forecast_levels, dtype=float)])
    return assess(site_id, series, rules, horizon_min)'''
assert s.count(old_af) == 1
new_af = '''    series = np.concatenate([[current_level], np.asarray(forecast_levels, dtype=float)])
    # 预测侧始终应用持续门槛：这是「提前预警」与「虚惊一场」之间的分界线。
    return assess(site_id, series, rules, horizon_min, apply_min_duration=True)'''
s = s.replace(old_af, new_af, 1)

# assess_observed 传 False
old_ob = '''    series = np.asarray(observed_levels, dtype=float)
    res = assess(site_id, series, rules, window_min)'''
assert s.count(old_ob) == 1
new_ob = '''    series = np.asarray(observed_levels, dtype=float)
    # 实测侧取消持续门槛降级：水已经漫过某档阈值就是既成事实，
    # 不该因为「还没泡够 60 分钟」把红色压成黄色。趋势跨档与等级兜底仍然生效。
    res = assess(site_id, series, rules, window_min, apply_min_duration=False)'''
s = s.replace(old_ob, new_ob, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('OK rules.py: apply_min_duration 参数已加，assess_observed 取消门槛')
