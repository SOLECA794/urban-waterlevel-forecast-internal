# -*- coding: utf-8 -*-
"""加手动分页，避免高行被跨页劈开；同时设置打印标题行。"""
import win32com.client as win32

XL = r'D:\Desktop\waterLevelForcasting\waterlog-v3\docs\水涝监测软件部分接口技术方案-补全版.xlsx'

app = win32.DispatchEx('Excel.Application')
app.Visible = False
app.DisplayAlerts = False
wb = app.Workbooks.Open(XL, UpdateLinks=0, ReadOnly=False)
try:
    for i in range(1, wb.Worksheets.Count + 1):
        ws = wb.Worksheets(i)
        name = ws.Name
        ws.ResetAllPageBreaks()
        rows = ws.UsedRange.Rows.Count
        if name == 'Sheet1':
            ws.PageSetup.PrintTitleRows = '$1:$1'
        elif name == 'AI平台接口可行性分析':
            ws.PageSetup.PrintTitleRows = '$1:$1'
        elif name == '集成接口清单':
            # 表一/表二/约定三段共用一张表，重复标题行会在表二页顶压出表一表头，故不设
            ws.PageSetup.PrintTitleRows = ''
            ws.PageSetup.PrintTitleColumns = ''
            # 每段标题行前分页：表二标题(39)、约定标题(50)
            for r in (39, 50):
                if r <= rows:
                    ws.HPageBreaks.Add(Before=ws.Rows(r))
        print(name, 'breaks', ws.HPageBreaks.Count)
    wb.Save()
    print('saved')
finally:
    wb.Close(SaveChanges=False)
    app.Quit()
