# -*- coding: utf-8 -*-
"""用 Excel 自身的 AutoFit 作为标尺，检查我算的行高是否够用（文本是否被裁）。"""
import win32com.client as win32

XL = r'D:\Desktop\waterLevelForcasting\waterlog-v3\docs\水涝监测软件部分接口技术方案-补全版.xlsx'

app = win32.DispatchEx('Excel.Application')
app.Visible = False
app.DisplayAlerts = False
wb = app.Workbooks.Open(XL, UpdateLinks=0, ReadOnly=False)
try:
    rep = []
    for i in range(1, wb.Worksheets.Count + 1):
        ws = wb.Worksheets(i)
        name = ws.Name
        used = ws.UsedRange
        rows = used.Rows.Count
        # 记录我设的值
        mine = {r: ws.Rows(r).RowHeight for r in range(1, rows + 1)}
        # 只对正文行 AutoFit（表头/标题行不参与）
        ws.Rows("1:%d" % rows).AutoFit()
        fit = {r: ws.Rows(r).RowHeight for r in range(1, rows + 1)}
        bad = []
        for r in range(1, rows + 1):
            if fit[r] > mine[r] + 0.6:
                bad.append((r, round(mine[r], 1), round(fit[r], 1)))
        rep.append((name, rows, bad))
    for name, rows, bad in rep:
        print('===', name, 'rows', rows, 'need-taller:', len(bad))
        for b in bad[:25]:
            print('    r%d mine=%.1f autofit=%.1f' % b)
finally:
    wb.Close(SaveChanges=False)
    app.Quit()
