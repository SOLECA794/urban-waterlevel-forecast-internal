# -*- coding: utf-8 -*-
"""用 Excel 自身的 AutoFit 定行高（比手算准），标题/表头行保持原值。"""
import win32com.client as win32

XL = r'D:\Desktop\waterLevelForcasting\waterlog-v3\docs\水涝监测软件部分接口技术方案-补全版.xlsx'
KEEP = {
    'Sheet1': {1},
    'AI平台接口可行性分析': {1, 26},
    '集成接口清单': {1, 2, 39, 40, 50, 51},
}

app = win32.DispatchEx('Excel.Application')
app.Visible = False
app.DisplayAlerts = False
wb = app.Workbooks.Open(XL, UpdateLinks=0, ReadOnly=False)
try:
    for i in range(1, wb.Worksheets.Count + 1):
        ws = wb.Worksheets(i)
        name = ws.Name
        used = ws.UsedRange
        rows = used.Rows.Count
        saved = {r: ws.Rows(r).RowHeight for r in range(1, rows + 1)}
        ws.Rows("1:%d" % rows).AutoFit()
        for r in KEEP.get(name, ()):
            ws.Rows(r).RowHeight = saved[r]
        print(name, 'rows', rows, 'maxH', max(ws.Rows(r).RowHeight for r in range(1, rows + 1)))
    wb.Save()
    print('saved')
finally:
    wb.Close(SaveChanges=False)
    app.Quit()
