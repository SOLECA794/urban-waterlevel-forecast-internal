# -*- coding: utf-8 -*-
"""用 Excel COM 导出 PDF，再用 PyMuPDF 渲染成 PNG，人工核对版式。"""
import os, sys
import win32com.client as win32

XL = r'D:\Desktop\waterLevelForcasting\waterlog-v3\docs\水涝监测软件部分接口技术方案-补全版.xlsx'
PDF = r'D:\Desktop\waterLevelForcasting\icm-doc\_work\preview.pdf'

if os.path.exists(PDF):
    os.remove(PDF)

app = win32.DispatchEx('Excel.Application')
app.Visible = False
app.DisplayAlerts = False
wb = None
try:
    wb = app.Workbooks.Open(XL, UpdateLinks=0, ReadOnly=True)
    for ws in wb.Worksheets:
        ws.PageSetup.Orientation = 2      # landscape
        ws.PageSetup.Zoom = False
        ws.PageSetup.FitToPagesWide = 1
        ws.PageSetup.FitToPagesTall = False
        ws.PageSetup.LeftMargin = app.InchesToPoints(0.2)
        ws.PageSetup.RightMargin = app.InchesToPoints(0.2)
        ws.PageSetup.TopMargin = app.InchesToPoints(0.3)
        ws.PageSetup.BottomMargin = app.InchesToPoints(0.3)
    wb.ExportAsFixedFormat(0, PDF)
    print('pdf ok', os.path.getsize(PDF))
finally:
    if wb is not None:
        wb.Close(SaveChanges=False)
    app.Quit()

import fitz
doc = fitz.open(PDF)
print('pages', doc.page_count)
os.makedirs(r'D:\Desktop\waterLevelForcasting\icm-doc\_work\png', exist_ok=True)
for i, page in enumerate(doc):
    pix = page.get_pixmap(dpi=110)
    out = rf'D:\Desktop\waterLevelForcasting\icm-doc\_work\png\p{i+1:02d}.png'
    pix.save(out)
    print(out, pix.width, pix.height)
