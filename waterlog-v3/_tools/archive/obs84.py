# -*- coding: utf-8 -*-
"""条款 8-4：新增「实测越限判定」，与现有「预测研判」并列输出。

背景：23 条款基线里 8-4 要求「基于实时值 + 监测状态 + 历史变化」做规则判定，
而现有实现（`assess_from_forecast`）喂进去的是**未来预测序列**，答的是
「接下来会不会淹」而不是「现在是不是已经淹了」。这两件事在业务上是两回事：
前者是提前预警，后者是即时告警，条款 8-5 要的 `appliedThreshold` 也只有在
「已经越过某档阈值」的语境下才有意义。

做法：完全复用 `domain/rules.py::assess()`（三因子 + 分档 + 门槛 + 趋势跨档），
只把输入的序列换成**近端回溯窗口的实测序列**，并在 reason 措辞上说清是「过去」。
不新增任何阈值比较代码。
"""
import io

# ---------------------------------------------------------------- rules.py

p = 'engine/waterlog/domain/rules.py'
s = io.open(p, encoding='utf-8').read()

anchor = 'def assess_from_forecast('
assert s.count(anchor) == 1, 'assess_from_forecast 锚点不唯一'

add = '''def assess_observed(site_id: str, observed_levels: np.ndarray, rules: dict,
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
    res = assess(site_id, series, rules, window_min)

    # assess() 的 reason 是照「未来序列」写的（「峰值 Xm（第 Ymin）」指的是
    # 预测序列里第 Y 分钟会到峰值）。对回溯序列必须改口径，否则值班员会
    # 把「过去 3h 里最高出现在第 120min」误读成「还有 2 小时才到峰值」。
    n = len(series)
    span_min = (n - 1) * STEP_MIN
    ago_min = (n - 1 - int(round(res.peak_at_min / STEP_MIN))) * STEP_MIN
    rise = float(series[-1] - series[0])
    res.reason = (f"实测近 {span_min}min 峰值 {res.peak_value:.2f}m（{LEVEL_LABEL[res.peak_level]}，"
                  f"出现在 {ago_min}min 前）、连续超阈 {res.duration_min}min、"
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")
    return res


'''

s = s.replace(anchor, add + anchor, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK rules.py: 新增 assess_observed() (~%d 字符)' % len(add))

# ---------------------------------------------------------------- forecast.py

p2 = 'engine/waterlog/service/forecast.py'
s2 = io.open(p2, encoding='utf-8').read()

old_imp = 'from waterlog.domain.rules import assess_from_forecast'
assert s2.count(old_imp) == 1
s2 = s2.replace(old_imp, 'from waterlog.domain.rules import assess_from_forecast, assess_observed', 1)

# 窗口常量：与预见期同量级（3h），保证「实测滞后于预测」能被看出来
old_win = 'SLOPE_COL = col("slope_1h")'
assert s2.count(old_win) == 1
s2 = s2.replace(old_win, '''SLOPE_COL = col("slope_1h")

# 条款 8-4：实测判定的回溯窗口。取 3h —— 比最短预见期长、比最长预见期短，
# 既够覆盖「涨起来又退下去」的一整段过程，又不会把昨天那场雨算进今天的告警。
OBSERVED_WINDOW_MIN = 180
OBSERVED_WINDOW_STEPS = OBSERVED_WINDOW_MIN // STEP_MIN''', 1)

# 在 prediction 研判之后插入 observed 研判
old_pred = '''            warn = assess_from_forecast(sid, float(now_level[i]), series5,
                                        self.rules, self.rules.get("horizon_min", 180))'''
assert s2.count(old_pred) == 1
new_pred = old_pred + '''
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
            obs_thr_name = obs.peak_level'''
s2 = s2.replace(old_pred, new_pred, 1)

# warning 字典里加新字段
old_dict = '''                "thresholds": list(site.thresholds), "horizon_min": self.rules.get("horizon_min", 180),
            }'''
assert s2.count(old_dict) == 1
new_dict = '''                "thresholds": list(site.thresholds), "horizon_min": self.rules.get("horizon_min", 180),
                # ---- 条款 8-4 新增：实测越限判定（与上面 4 个字段语义正交）
                "observed_level": obs_level,
                "observed_reason": obs.reason,
                "observed_over_min": obs.duration_min,
                "observed_thr_name": obs_thr_name,
                "observed_score": round(obs.score, 4),
                "observed_window_min": OBSERVED_WINDOW_MIN,
                "observed_peak_value": round(obs.peak_value, 4),
                "alarm_source": alarm_source,
            }'''
s2 = s2.replace(old_dict, new_dict, 1)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('OK forecast.py: cycle() 新增实测判定与 7 个字段')
