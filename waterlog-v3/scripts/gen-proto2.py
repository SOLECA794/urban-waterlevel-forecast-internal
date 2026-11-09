import base64
import json
import sys
import urllib.request

API = "https://api.x5m5x.com/v1/images/generations"
KEY = "sk-f168c327d6bd59c0ead6823d3d8147a3d5f725e1e94a0aecd81ab5c884be2ed7"

PROMPT = """Ultra-detailed UI/UX design mockup of a dark-mode urban flood early-warning command center dashboard, flat front-facing screenshot, no perspective, no device frame, no browser chrome.

OVERALL PALETTE: deep navy page background #0A1020 with a very subtle radial cyan glow at the top center; panels #111A2E with crisp 1px #1E2A42 borders and 14px rounded corners; accent neon cyan #22D3EE; alert red #F43F5E; amber #F59E0B; primary text #E7EDF7; muted text #7B8BA6.

LAYOUT:
- Far left: a slim 64px vertical icon rail on slightly darker background, a glowing cyan water-droplet logo at the top, then six thin monochrome line icons stacked below; the active icon sits in a cyan tinted pill with a glowing left edge.
- Top bar 56px: at left the title "URBAN FLOOD EARLY WARNING" in small letterspaced uppercase; at right a live clock "26 OCT 04:34:05", two small status pills each with a tiny glowing dot labelled ENGINE ONLINE and SSE LIVE, and one solid red badge reading 6 RED.
- Hero band, full width: a dark panel with a faint red-to-transparent gradient on its left edge. On the left an enormous numeral 7 in 64px bold with the label STATIONS IN WARNING beneath it. In the middle a 24-hour horizontal activity strip made of many small rounded segments coloured red, amber, blue and dark gray, captioned LAST 24 H. On the right a row of four compact metrics with tiny uppercase labels: DEEPEST 0.82 m, RAIN NOW 170 mm/h, STATIONS 10, NEXT UPDATE 60 s.
- Main area, two columns in a 3:2 ratio with 16px gap.
  LEFT COLUMN: a large dark map panel titled SITE MAP / WARNING COLOR. Inside it an abstract dark night city map: dark navy landmass, a thin slate street grid, a river drawn as a soft glowing deep-blue ribbon with a cyan edge highlight curving across the middle, two park polygons in dark teal. Ten station markers rendered as glowing dots with concentric halo rings, coloured red, amber and yellow; each marker carries a tiny white ID label and a small floating chip showing a depth value such as 0.68 m. One red marker is selected, drawn with a larger pulsing halo and an open dark callout card reading RAILWAY HUB S07, 0.82 m, RED 0.94. A small legend row of four coloured dots sits at the bottom right of the map.
  RIGHT COLUMN: a vertical LIVE STATIONS panel containing five rows separated by hairline dividers. Each row has a coloured status dot, a station name such as RAILWAY HUB S07, a small grey district subtitle, a mini area sparkline drawn in the row colour, and right aligned a bold depth number like 0.824 with a small m unit plus a tiny up-arrow delta such as +0.164. The first row is highlighted with a faint red tinted background and a 2px red left border.
- Bottom band, full width: a panel titled 12-HOUR WATER LEVEL FORECAST containing a wide line chart. A dark grey observed history line on the left, a bright cyan forecast curve continuing to the right, a translucent cyan confidence cone that widens with lead time, four horizontal dashed threshold lines labelled BLUE 0.06, YELLOW 0.18, ORANGE 0.30, RED 0.46, a thin vertical NOW marker line, and a soft blue rain-bar histogram along the very bottom of the chart.

DESIGN QUALITY: extremely strict grid alignment, tight but generous spacing, crisp hairlines, glow reserved only for alert elements, no heavy drop shadows, fintech-grade data visualization, legible micro-typography, Inter typeface, high information density without clutter, dribbble and behance quality, photorealistic UI screenshot.

No paragraphs of lorem ipsum, no watermark, no person, no phone mockup."""


def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else "prototype.png"
    size = sys.argv[2] if len(sys.argv) > 2 else "1536x1024"
    body = json.dumps({
        "model": "gpt-image-2.5-sunburst",
        "prompt": PROMPT,
        "n": 1,
        "size": size,
    }).encode("utf-8")

    req = urllib.request.Request(
        API,
        data=body,
        # 该网关会拒掉 urllib 默认的 User-Agent（直接 403），必须伪装成普通客户端。
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "User-Agent": "curl/8.9.1",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    item = payload["data"][0]
    raw = base64.b64decode(item["b64_json"])
    with open(out, "wb") as fh:
        fh.write(raw)
    print(f"saved {out} {len(raw)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
