# -*- coding: utf-8 -*-
"""修正实测侧的「连续超阈」口径。

问题：`assess()` 里 `duration_min = (h >= thr_now).sum() * STEP_MIN` 算的是
窗口内**累计**超阈步数，而参数名与 reason 文案都写「连续超阈」。对预测序列
（单调上涨）这个偏差无感，但对回溯实测序列，「涨上去又退下来」会把两段分开的
超阈时间加在一起，报出一个并不存在的连续时长。

实测侧必须报真实的「当前这一段连续超阈」——这才是值班员判断「还要不要封路」
的依据。做法：在 assess_observed() 里重算连续段，只覆盖 duration_min 这一个值，
其余三因子与分档完全沿用 assess()。

注意不能改 assess() 本体：preview_rules 拿它做 before/after 对比，改了口径
会让「规则变化」与「口径变化」混在一起，分不清是哪个造成的影响。
"""
import io

p = 'engine/waterlog/domain/rules.py'
s = io.open(p, encoding='utf-8').read()

old = '''    series = np.asarray(observed_levels, dtype=float)
    # 实测侧取消持续门槛降级：水已经漫过某档阈值就是既成事实，
    # 不该因为「还没泡够 60 分钟」把红色压成黄色。趋势跨档与等级兜底仍然生效。
    res = assess(site_id, series, rules, window_min, apply_min_duration=False)'''

assert s.count(old) == 1, 'assess_observed 主体锚点不唯一'

new = '''    series = np.asarray(observed_levels, dtype=float)
    # 实测侧取消持续门槛降级：水已经漫过某档阈值就是既成事实，
    # 不该因为「还没泡够 60 分钟」把红色压成黄色。趋势跨档与等级兜底仍然生效。
    res = assess(site_id, series, rules, window_min, apply_min_duration=False)

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
    res.__dict__['over_run_at_edge'] = (run == len(h))'''

s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK assess_observed 连续超阈重算')

# reason 文案同步：把「连续超阈」的口径写清楚
old2 = '''    res.reason = (f"实测近 {span_min}min 峰值 {res.peak_value:.2f}m（{LEVEL_LABEL[res.peak_level]}，"
                  f"出现在 {ago_min}min 前）、连续超阈 {res.duration_min}min、"
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")'''
s = io.open(p, encoding='utf-8').read()
assert s.count(old2) == 1, 'reason 锚点不唯一'
new2 = '''    # 「连续超阈」是当前这一段，不是累计——见上面的重算说明。
    if res.duration_min == 0:
        dur_txt = "当前未超阈"
    elif res.__dict__.get('over_run_at_edge'):
        dur_txt = f"已连续超阈 {res.duration_min}min（仍在超）"
    else:
        dur_txt = f"当前连续超阈 {res.duration_min}min"
    res.reason = (f"实测近 {span_min}min 峰值 {res.peak_value:.2f}m（{LEVEL_LABEL[res.peak_level]}，"
                  f"出现在 {ago_min}min 前）、{dur_txt}、"
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")'''
s = s.replace(old2, new2, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK reason 文案改为当前连续段口径')
