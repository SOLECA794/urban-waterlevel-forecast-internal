# -*- coding: utf-8 -*-
"""消除实测判定的自相矛盾：level 与「当前是否仍在超阈」分开表达。

问题（实测发现）：序列「涨到 0.50m 超红 → 退到 0.20m → 回到 0.24m」得到
level=red 而 over_min=0、文案「当前未超阈」——系统报红色预警同时说现在没超阈。
值班员会直接质疑系统。

根因：level 承载了两件事——「本次判定的严重程度（含窗口内历史峰值）」与
「此刻是否仍在超阈」。一个字段表达两个事实，一旦二者背离就自相矛盾。

修法：不改 level 的算法（峰值到红档就该留痕，否则「涨过又退了」会被系统遗忘，
这对复盘是重要的），而是显式补一个 `still_over` 布尔，并让文案把两件事都讲清楚：
「曾达红色、现已回落」比单说「红色预警」诚实得多。
"""
import io

p = 'engine/waterlog/domain/rules.py'
s = io.open(p, encoding='utf-8').read()

old = '''    res.duration_min = run * STEP_MIN
    # 顺手记一个「这一段是不是就从窗口开头一路超下来的」——
    # 是的话说明雨还在持续，界面可以据此说「仍在超阈」而不是「超阈已 X 分钟」。
    res.__dict__['over_run_at_edge'] = (run == len(h))'''

assert s.count(old) == 1
new = '''    res.duration_min = run * STEP_MIN
    # still_over：此刻是否仍在超阈。与 level 是两个事实——
    # level 含窗口内历史峰值（涨过又退了也要留痕，否则复盘时会以为没发生过），
    # still_over 只回答「现在还在不在水上」。界面必须两个都说，不能只报 level。
    res.__dict__['still_over'] = run > 0
    res.__dict__['over_run_at_edge'] = (run == len(h))
    # peak_level 高于 level 时说明被趋势回落降过级——这正是「曾达红、现已退」的形态。
    res.__dict__['receded'] = (LEVEL_RANK.get(res.peak_level, 0) > LEVEL_RANK.get(res.level, 0))'''
s = s.replace(old, new, 1)

# reason 重写：把「曾达哪一档」与「现在什么状态」分开说
old2 = '''    # 「连续超阈」是当前这一段，不是累计——见上面的重算说明。
    if res.duration_min == 0:
        dur_txt = "当前未超阈"
    elif res.__dict__.get('over_run_at_edge'):
        dur_txt = f"已连续超阈 {res.duration_min}min（仍在超）"
    else:
        dur_txt = f"当前连续超阈 {res.duration_min}min"
    res.reason = (f"实测近 {span_min}min 峰值 {res.peak_value:.2f}m（{LEVEL_LABEL[res.peak_level]}，"
                  f"出现在 {ago_min}min 前）、{dur_txt}、"
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")'''

s = io.open(p, encoding='utf-8').read()
assert s.count(old2) == 1
new2 = '''    # 「连续超阈」是当前这一段，不是累计——见上面的重算说明。
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
                  f"该窗涨跌 {rise:+.2f}m → 综合分 {res.score:.2f} → {LEVEL_LABEL[res.level]}")'''
s = s.replace(old2, new2, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('OK reason 改为「曾达 X / 现已 Y」双事实口径')

# to_json 透出新布尔
p2 = 'engine/waterlog/service/forecast.py'
s2 = io.open(p2, encoding='utf-8').read()
old3 = '''                "observed_score": round(obs.score, 4),
                "observed_window_min": OBSERVED_WINDOW_MIN,
                "observed_peak_value": round(obs.peak_value, 4),'''
assert s2.count(old3) == 1
new3 = '''                "observed_score": round(obs.score, 4),
                "observed_window_min": OBSERVED_WINDOW_MIN,
                "observed_peak_value": round(obs.peak_value, 4),
                # 此刻是否仍在超阈 —— 与 observed_level 是两个事实，
                # 界面必须两个都说，否则「红色预警 + 当前未超阈」会自相矛盾。
                "observed_still_over": bool(obs.__dict__.get("still_over", False)),'''
s2 = s2.replace(old3, new3, 1)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('OK forecast.py 透出 observed_still_over')
