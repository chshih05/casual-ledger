"""產生網站圖示（加到手機主畫面時使用）。只用 Python 標準函式庫。

用法：python tools/make_icons.py              產生全部圖示
      python tools/make_icons.py shortcuts    只產生長按主畫面圖示的捷徑圖示
輸出到 src/static/：icon.svg、icon-192.png、icon-512.png、icon-maskable-512.png、apple-touch-icon.png，
以及捷徑用的 shortcut-expense.png（記一筆支出）、shortcut-income.png（記一筆收入）。
圖樣：霧藍漸層底（和預設主題顏色同色系），一張收據，鉛筆剛隨手寫下一筆金額（對應「隨便記」）；捷徑是同樣的底色加上白色的 − 或 ＋。
畫法：每個圖形都用「到邊緣的距離」描述（負數代表在圖形內），邊緣依距離算出半透明，
不需要繪圖套件也有平滑的邊緣；陰影是把這個距離做成柔和的漸層。SVG 與 PNG 用同一組座標。
"""
import math
import pathlib
import struct
import sys
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "static"

BG_TOP = (0xA8, 0xC7, 0xFA)      # 左上淡藍
BG_BOTTOM = (0x4A, 0x7D, 0xDB)   # 右下深藍
SHADOW = (0x15, 0x2E, 0x66)
WHITE = (0xFF, 0xFF, 0xFF)
LINE = (0xCC, 0xDD, 0xFB)        # 收據上的淡色字行
INK = (0x4A, 0x7D, 0xDB)         # 手寫金額與筆芯同色
PENCIL = {"wood": (0xFD, 0xE3, 0xBD), "body": (0xFC, 0xD3, 0x4D), "stripe": (0xF5, 0xB7, 0x31),
          "band": (0xD9, 0xDC, 0xE8), "eraser": (0xF9, 0xA8, 0xD4)}
SHADOW_OPACITY, SHADOW_DY, SHADOW_BLUR = 0.35, 10, 12

# 以 512 為基準的版面。整組圖案先旋轉收據（含鉛筆），再平移到畫面正中央。
CENTER_SHIFT = (-28, 16)
RECEIPT_TURN = (-8, 234, 242)    # 收據旋轉角度與旋轉中心
PENCIL_TIP = (300, 276, 45)      # 鉛筆筆尖位置（收據座標）與傾斜角度；筆尖剛好在手寫金額的結尾

VARIANTS = {
    "any": {"corner": 112, "scale": 1.0},        # 一般圖示：自帶圓角
    "maskable": {"corner": 0, "scale": 0.82},    # Android 會裁成圓形等形狀：主體縮進中央安全範圍
    "apple": {"corner": 0, "scale": 1.0},        # iPhone 會自己裁圓角，背景要填滿
}


def arc(cx, cy, r, a0, a1, steps=10):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]


def receipt_outline():
    pts = arc(160, 122, 30, 180, 270) + arc(312, 122, 30, 270, 360) + [(342, 374)]
    # 底部鋸齒：6 個齒
    pts += [(342 - k * 212 / 12, 392 if k % 2 else 374) for k in range(1, 13)]
    return pts


def squiggle(steps=10):
    pts, x, up = [(166.0, 272.0)], 166.0, True
    for _ in range(4):   # 四段起伏的手寫線
        cy = 244 if up else 300
        for i in range(1, steps + 1):
            t = i / steps
            pts.append((x + 32 * t, (1 - t) ** 2 * 272 + 2 * (1 - t) * t * cy + t * t * 272))
        x, up = x + 32, not up
    return pts


def box(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


RECEIPT = receipt_outline()
LINES = [[(164, 146), (270, 146)], [(164, 190), (232, 190)]]
SQUIGGLE = squiggle()
# 鉛筆以筆尖為原點、筆身朝上；相鄰的部件多畫 1 單位疊在下一個部件底下，避免接縫露出背景。
PENCIL_PARTS = [
    ("wood", [(0, 0), (-30, -55), (30, -55)]),
    ("ink", [(0, 0), (-10.8, -19.44), (10.8, -19.44)]),
    ("body", box(-30, -175, 30, -54)),
    ("stripe", box(10, -174, 30, -54)),
    ("band", box(-30, -193, 30, -174)),
    ("eraser", [(-30, -192), (30, -192)] + arc(18, -206, 12, 0, -90) + arc(-18, -206, 12, -90, -180)),
]


# ---------- 距離計算（負數在圖形內） ----------
def sd_polygon(px, py, edges):
    best, inside = float("inf"), False
    for xi, yi, ex, ey, inv in edges:
        wx, wy = px - xi, py - yi
        t = (wx * ex + wy * ey) * inv
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        bx, by = wx - ex * t, wy - ey * t
        d = bx * bx + by * by
        if d < best:
            best = d
        if (yi > py) != (yi + ey > py) and px < xi + (py - yi) * ex / ey:
            inside = not inside
    return -math.sqrt(best) if inside else math.sqrt(best)


def sd_stroke(px, py, segs, half):
    best = float("inf")
    for xi, yi, ex, ey, inv in segs:
        wx, wy = px - xi, py - yi
        t = (wx * ex + wy * ey) * inv
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        bx, by = wx - ex * t, wy - ey * t
        d = bx * bx + by * by
        if d < best:
            best = d
    return math.sqrt(best) - half


def edges_of(points, closed=True):
    pairs = list(zip(points, points[1:] + points[:1])) if closed else list(zip(points, points[1:]))
    out = []
    for (x0, y0), (x1, y1) in pairs:
        ex, ey = x1 - x0, y1 - y0
        out.append((x0, y0, ex, ey, 1 / (ex * ex + ey * ey)))
    return out


def sd_round_square(px, py, r):
    qx, qy = abs(px - 256) - (256 - r), abs(py - 256) - (256 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


# ---------- 座標轉換：畫面 ↔ 收據 ↔ 鉛筆 ----------
def make_transforms(scale):
    a = math.radians(RECEIPT_TURN[0])
    ca, sa = math.cos(a), math.sin(a)
    rx, ry = RECEIPT_TURN[1], RECEIPT_TURN[2]
    b = math.radians(PENCIL_TIP[2])
    cb, sb = math.cos(b), math.sin(b)
    tx, ty = PENCIL_TIP[0], PENCIL_TIP[1]

    def to_receipt(gx, gy):   # 畫面座標 → 收據座標
        x = (gx - 256) / scale + 256 - CENTER_SHIFT[0] - rx
        y = (gy - 256) / scale + 256 - CENTER_SHIFT[1] - ry
        return rx + x * ca + y * sa, ry - x * sa + y * ca

    def to_pencil(gx, gy):    # 畫面座標 → 鉛筆座標
        x, y = to_receipt(gx, gy)
        x, y = x - tx, y - ty
        return x * cb + y * sb, -x * sb + y * cb

    def receipt_to_screen(x, y):
        x, y = x - rx, y - ry
        x, y = rx + x * ca - y * sa, ry + x * sa + y * ca
        return 256 + scale * (x + CENTER_SHIFT[0] - 256), 256 + scale * (y + CENTER_SHIFT[1] - 256)

    def pencil_to_screen(x, y):
        return receipt_to_screen(tx + x * cb - y * sb, ty + x * sb + y * cb)

    return to_receipt, to_pencil, receipt_to_screen, pencil_to_screen


def layers(scale):
    """依繪製順序列出圖層：(顏色, 透明度, 距離函數, 畫面上的範圍, 是否為陰影)。"""
    to_receipt, to_pencil, receipt_to_screen, pencil_to_screen = make_transforms(scale)
    receipt_edges = edges_of(RECEIPT)
    parts = {name: edges_of(points) for name, points in PENCIL_PARTS}
    silhouette = [parts["wood"], parts["body"], parts["band"], parts["eraser"]]

    def bounds(points, to_screen, margin):
        xs, ys = zip(*(to_screen(x, y) for x, y in points))
        return min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin

    def receipt_sd(gx, gy):
        return sd_polygon(*to_receipt(gx, gy), receipt_edges) * scale

    def pencil_sd(gx, gy):
        x, y = to_pencil(gx, gy)
        return min(sd_polygon(x, y, e) for e in silhouette) * scale

    def shadow_of(sd):
        return lambda gx, gy: sd(gx, gy - SHADOW_DY * scale)

    def part(name):
        clip = parts["body"] if name == "stripe" else None   # 筆身上的深色條不超出筆身
        def sd(gx, gy):
            x, y = to_pencil(gx, gy)
            d = sd_polygon(x, y, parts[name])
            return (max(d, sd_polygon(x, y, clip)) if clip else d) * scale
        return sd

    def stroke(points, half):
        segs = edges_of(points, closed=False)
        return lambda gx, gy: sd_stroke(*to_receipt(gx, gy), segs, half) * scale

    spread = 3.2 * SHADOW_BLUR * scale + 2
    pencil_points = [p for _, pts in PENCIL_PARTS for p in pts]
    out = [
        (SHADOW, SHADOW_OPACITY, shadow_of(receipt_sd), bounds(RECEIPT, receipt_to_screen, spread), True),
        (WHITE, 1, receipt_sd, bounds(RECEIPT, receipt_to_screen, 2), False),
    ]
    for line in LINES:
        out.append((LINE, 1, stroke(line, 10), bounds(line, receipt_to_screen, 10 * scale + 2), False))
    out.append((INK, 1, stroke(SQUIGGLE, 11), bounds(SQUIGGLE, receipt_to_screen, 11 * scale + 2), False))
    out.append((SHADOW, SHADOW_OPACITY, shadow_of(pencil_sd), bounds(pencil_points, pencil_to_screen, spread), True))
    for name, points in PENCIL_PARTS:
        color = INK if name == "ink" else PENCIL[name]
        out.append((color, 1, part(name), bounds(points, pencil_to_screen, 2), False))
    return out


def render(variant, size):
    corner, scale = VARIANTS[variant]["corner"], VARIANTS[variant]["scale"]
    unit = 512 / size   # 一個像素等於幾個設計單位
    color, alpha = [], []
    for j in range(size):
        gy = (j + 0.5) * unit
        for i in range(size):
            gx = (i + 0.5) * unit
            t = (gx + gy) / 1024   # 由左上往右下的漸層
            color.append([BG_TOP[k] + (BG_BOTTOM[k] - BG_TOP[k]) * t for k in range(3)])
            a = 1.0 if not corner else min(max(0.5 - sd_round_square(gx, gy, corner) / unit, 0.0), 1.0)
            alpha.append(a)
    blur = SHADOW_BLUR * scale * math.sqrt(2)
    for paint, opacity, sd, (x0, y0, x1, y1), is_shadow in layers(scale):
        for j in range(max(int(y0 / unit), 0), min(int(y1 / unit) + 1, size)):
            gy = (j + 0.5) * unit
            for i in range(max(int(x0 / unit), 0), min(int(x1 / unit) + 1, size)):
                gx = (i + 0.5) * unit
                d = sd(gx, gy)
                cover = 0.5 * math.erfc(d / blur) if is_shadow else min(max(0.5 - d / unit, 0.0), 1.0)
                if cover <= 0:
                    continue
                a, px = cover * opacity, color[j * size + i]
                for k in range(3):
                    px[k] += (paint[k] - px[k]) * a
    rows = []
    for j in range(size):
        row = bytearray([0])   # PNG 每列開頭的濾波方式：0 = 不處理
        for i in range(size):
            px = color[j * size + i]
            row += bytes(round(c) for c in px) + bytes([round(alpha[j * size + i] * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def shortcut(symbol, size):
    """捷徑圖示：漸層底填滿整張（Android 會裁成圓形），中間白色的 −（支出）或 ＋（收入），留在可裁切的安全範圍內。"""
    reach, half = 100, 24   # 線條從中心往外的長度、線條半寬（以 512 為基準）
    segs = edges_of([(256 - reach, 256), (256 + reach, 256)], closed=False)
    if symbol == "+":
        segs += edges_of([(256, 256 - reach), (256, 256 + reach)], closed=False)
    unit = 512 / size
    rows = []
    for j in range(size):
        gy = (j + 0.5) * unit
        row = bytearray([0])
        for i in range(size):
            gx = (i + 0.5) * unit
            t = (gx + gy) / 1024
            base = [BG_TOP[k] + (BG_BOTTOM[k] - BG_TOP[k]) * t for k in range(3)]
            cover = min(max(0.5 - sd_stroke(gx, gy, segs, half) / unit, 0.0), 1.0)
            row += bytes(round(base[k] + (WHITE[k] - base[k]) * cover) for k in range(3)) + b"\xff"
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 位元 RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def svg(variant):
    corner, scale = VARIANTS[variant]["corner"], VARIANTS[variant]["scale"]
    hexc = lambda c: "#%02X%02X%02X" % c
    pts = lambda points: " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
    turn = "rotate(%g %g %g)" % RECEIPT_TURN
    pencil = turn + " translate(%g %g) rotate(%g)" % PENCIL_TIP
    sh = f'<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="{SHADOW_DY}" stdDeviation="{SHADOW_BLUR}" flood-color="{hexc(SHADOW)}" flood-opacity="{SHADOW_OPACITY}"/></filter>'
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
        f'<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{hexc(BG_TOP)}"/><stop offset="1" stop-color="{hexc(BG_BOTTOM)}"/></linearGradient>{sh}</defs>',
        f'<rect width="512" height="512" rx="{corner}" fill="url(#bg)"/>',
        f'<g transform="translate(256 256) scale({scale}) translate(-256 -256) translate({CENTER_SHIFT[0]} {CENTER_SHIFT[1]})">',
        f'<g filter="url(#sh)"><polygon transform="{turn}" points="{pts(RECEIPT)}" fill="{hexc(WHITE)}"/></g>',
        f'<g transform="{turn}" fill="none" stroke-linecap="round" stroke-linejoin="round">',
    ]
    for line in LINES:
        parts.append(f'<polyline points="{pts(line)}" stroke="{hexc(LINE)}" stroke-width="20"/>')
    parts.append(f'<polyline points="{pts(SQUIGGLE)}" stroke="{hexc(INK)}" stroke-width="22"/></g>')
    parts.append(f'<g filter="url(#sh)"><g transform="{pencil}">')
    for name, points in PENCIL_PARTS:
        color = INK if name == "ink" else PENCIL[name]
        parts.append(f'<polygon points="{pts(points)}" fill="{hexc(color)}"/>')
    parts.append("</g></g></g></svg>\n")
    return "".join(parts)


def main(argv):
    OUT.mkdir(parents=True, exist_ok=True)
    if "shortcuts" not in argv:
        (OUT / "icon.svg").write_text(svg("any"), encoding="utf-8", newline="\n")
        for name, variant, size in [("icon-192.png", "any", 192), ("icon-512.png", "any", 512),
                                    ("icon-maskable-512.png", "maskable", 512), ("apple-touch-icon.png", "apple", 180)]:
            write_png(OUT / name, size, render(variant, size))
            print("已產生", name)
    for name, symbol in [("shortcut-expense.png", "-"), ("shortcut-income.png", "+")]:
        write_png(OUT / name, 192, shortcut(symbol, 192))
        print("已產生", name)


if __name__ == "__main__":
    main(sys.argv[1:])
