import base64
import json
import sys
import urllib.request

API = "https://api.x5m5x.com/v1/images/generations"
KEY = "sk-f168c327d6bd59c0ead6823d3d8147a3d5f725e1e94a0aecd81ab5c884be2ed7"

PROMPT = """Ultra-detailed UI/UX design mockup of a dark-mode urban flood early-warning command center dashboard. Flat front-facing screenshot, perfectly straight-on, no perspective, no device frame, no browser chrome, fills the entire canvas edge to edge.

PALETTE: page background #0A1020 with a faint radial cyan glow behind the top bar; panels #111A2E, 1px #1E2A42 borders, 14px radius; neon cyan accent #22D3EE; alert red #F43F5E; amber #F59E0B; yellow #EAB308; primary text #E7EDF7; muted #7B8BA6.

LEFT ICON RAIL, 64px wide, darker #070C18: glowing cyan droplet logo at top; six thin monochrome line icons below (map, list, bell, gauge, sliders, cpu); the top icon is active inside a cyan tinted rounded pill with a bright cyan left edge.

TOP BAR, 56px: left, small letterspaced uppercase title "URBAN FLOOD EARLY WARNING"; right side in one row, a live clock "26 OCT 04:34:05", two outlined status pills each with a glowing dot reading ENGINE ONLINE and SSE LIVE, and one solid red pill reading 6 RED.

HERO BAND, full width, 96px tall, dark panel with a red-to-transparent gradient wash on its left third: a huge bold numeral 7 with the caption STATIONS IN WARNING; beside it a 24-hour activity strip of many small rounded segments in red, amber, blue and dark slate, with hour ticks 04 08 12 16 20 00 below; on the right four compact metrics separated by thin vertical dividers, each a tiny uppercase label above a large number: DEEPEST 0.82 m, RAIN NOW 170 mm/h, STATIONS 10, NEXT UPDATE 60 s.

MAIN ROW, two panels, left one 62 percent width, right one 38 percent, 16px gap.
LEFT PANEL titled SITE MAP / WARNING COLOR: a dark night city map, dark navy land, faint slate street grid, a glowing deep-blue river ribbon with a cyan rim crossing horizontally, two dark teal park shapes, a small north arrow and scale bar. Ten station markers as glowing dots with soft concentric halos, coloured red, amber and yellow, each with a small white ID tag and a floating depth chip. The central red marker is selected with a larger pulsing halo and an open dark tooltip card reading RAILWAY HUB S07, 0.82 m, RED 0.94. Legend of four coloured dots at bottom right.
RIGHT PANEL titled LIVE STATIONS: five rows divided by hairlines; each row shows a coloured dot, a station name in caps, a grey district subtitle, a small area sparkline in the row colour, and at the far right a bold depth number with unit m and a tiny up-arrow delta. The first row is tinted red with a 2px red left border.

BOTTOM PANEL, full width and notably tall, titled 12-HOUR WATER LEVEL FORECAST, with a compact legend at its right: Observed, Forecast, 90 percent Confidence, Rain. The chart plots water depth on the Y axis from 0.00 to 0.80 and time on the X axis from 16:00 to 14:00 with exactly these eight evenly spaced tick labels in this order: 16:00, 18:00, 20:00, 22:00, 00:00, 02:00, 04:00, 06:00. A thin white vertical dashed line marked NOW sits at 04:00. A grey observed line rises gently from the left up to the NOW line. From NOW onward a bright cyan forecast curve rises and then flattens just above the RED threshold. A translucent cyan confidence cone starts narrow at NOW and widens smoothly to the right, its upper edge well above the red threshold and its lower edge near the orange threshold. Four horizontal dashed threshold lines span the whole plot, labelled at the left end RED 0.46, ORANGE 0.30, YELLOW 0.18, BLUE 0.06. A row of small blue rain bars sits along the very bottom of the plot area.

QUALITY: rigid grid alignment, crisp hairlines, generous but tight spacing, glow used only on alerts and the selected marker, no heavy shadows, precise data-visualization craft, legible micro-typography, Inter typeface, professional emergency-operations software, dribbble quality, photorealistic UI screenshot. All text must be short labels only, correctly spelled, no lorem ipsum, no watermark, no people."""


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
