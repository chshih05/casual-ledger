"""產生網站圖示（加到手機主畫面時使用）。只用 Python 標準函式庫。

用法：python tools/make_icons.py
輸出到 src/static/：icon.svg、icon-192.png、icon-512.png、icon-maskable-512.png
圖樣：深灰底、淡紫色方塊與「＋」，對應首頁的「＋記一筆」。
"""
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "static"

BG = (0x1E, 0x20, 0x28)
ACCENT = (0xA7, 0x8B, 0xFA)
DARK = (0x14, 0x16, 0x1B)

# 以 512 為基準的圖形：(x0, y0, x1, y1, 圓角半徑)
DESIGNS = {
    "any": {
        "bg": (0, 0, 512, 512, 112),
        "tile": (132, 132, 380, 380, 60),
        "bars": [(180, 236, 332, 276, 20), (236, 180, 276, 332, 20)],
    },
    # 可裁切圖示：Android 會裁成圓形或其他形狀，主體必須留在中央安全範圍內。
    "maskable": {
        "bg": (0, 0, 512, 512, 0),
        "tile": (152, 152, 360, 360, 52),
        "bars": [(192, 239, 320, 273, 17), (239, 192, 273, 320, 17)],
    },
}


def inside(px, py, rect):
    x0, y0, x1, y1, r = rect
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    dx = max(x0 + r - px, 0, px - (x1 - r))
    dy = max(y0 + r - py, 0, py - (y1 - r))
    return dx * dx + dy * dy <= r * r


def render(design, size, samples=4):
    scale = 512 / size
    offsets = [(i + 0.5) / samples for i in range(samples)]
    rows = []
    for y in range(size):
        row = bytearray([0])  # PNG 每列開頭的濾波方式：0 = 不處理
        for x in range(size):
            cover = [0, 0, 0]
            for oy in offsets:
                for ox in offsets:
                    px, py = (x + ox) * scale, (y + oy) * scale
                    if inside(px, py, design["bg"]):
                        cover[0] += 1
                        if inside(px, py, design["tile"]):
                            cover[1] += 1
                            if any(inside(px, py, bar) for bar in design["bars"]):
                                cover[2] += 1
            n = samples * samples
            a_bg, a_tile, a_bar = cover[0] / n, cover[1] / n, cover[2] / n
            if a_bg == 0:
                row += bytes(4)
                continue
            # 依序疊上：底色 → 淡紫方塊 → 深色加號（各層都在前一層之內）
            t = a_tile / a_bg
            b = a_bar / a_tile if a_tile else 0
            color = [BG[i] * (1 - t) + ACCENT[i] * t for i in range(3)]
            color = [color[i] * (1 - b * t) + DARK[i] * b * t for i in range(3)]
            row += bytes(round(c) for c in color) + bytes([round(a_bg * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 位元 RGBA
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def svg(design):
    def rect(r, color):
        x0, y0, x1, y1, radius = r
        return f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{radius}" fill="#{color[0]:02X}{color[1]:02X}{color[2]:02X}"/>'
    parts = [rect(design["bg"], BG), rect(design["tile"], ACCENT)] + [rect(b, DARK) for b in design["bars"]]
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' + "".join(parts) + "</svg>\n"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg(DESIGNS["any"]), encoding="utf-8", newline="\n")
    for name, design, size in [("icon-192.png", "any", 192), ("icon-512.png", "any", 512), ("icon-maskable-512.png", "maskable", 512)]:
        write_png(OUT / name, size, render(DESIGNS[design], size))
        print("已產生", name)


if __name__ == "__main__":
    main()
