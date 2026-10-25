"""一次性工具（2026-10-25 已執行，請勿重跑）。

原開發資料夾（build.py、improvements.js 等）無法存取，因此從可用的成品
prototype-revised.html 拆出原始碼到 src/。拆分後以 tools/build.py 重新組合，
並確認內容與原成品逐字相同（只把換行從 CRLF 改為 LF）。

若 src/ 已有檔案，本工具會拒絕執行，避免覆蓋後續修改。
用法：python -I tools/one-time/extract_from_built_html.py <成品 HTML 路徑>
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "src"

# (檔名, 起始行, 結束行)：行號以 1 起算、含頭尾，對應原成品 <script> 內的段落。
JS_PARTS = [
    ("js/10-icons-base.js", 535, 570),      # 原始雛形的 ICONS / ICON_LABELS
    ("js/20-icon-overrides.js", 571, 600),  # icon-overrides.js：統一線條圖示
    ("js/30-icon-catalog.js", 601, 623),    # Lucide 授權聲明 + icon-catalog.js
    ("js/40-views.js", 624, 988),           # 原始雛形的畫面繪製函式
    ("js/50-icon-picker.js", 989, 1061),    # icon-picker.js
    ("js/60-app.js", 1062, 1482),           # improvements.js：本機帳本與操作
]

# 每段開頭應出現的文字，用來確認行號沒有切錯。
EXPECTED_STARTS = {
    535: "    const ICONS = {",
    571: "// A consistent, rounded outline set",
    601: "/* Lucide SVG attribution",
    624: "    function getInitialState() {",
    989: "const iconPickerStates=new Map();",
    1062: "// Local-only ledger.",
}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    built = pathlib.Path(sys.argv[1])
    existing = [p for p in SRC.rglob("*") if p.is_file()]
    if existing:
        print("src/ 已有檔案，為避免覆蓋修改，停止執行。")
        return 1

    text = built.read_text(encoding="utf-8").replace("\r\n", "\n")
    lines = text.split("\n")
    if lines[-1] == "":
        lines = lines[:-1]
    assert len(lines) == 1485, f"行數與預期不同：{len(lines)}"
    line = lambda n: lines[n - 1]

    for number, start in EXPECTED_STARTS.items():
        assert line(number).startswith(start), f"第 {number} 行內容與預期不同"
    assert line(26).startswith("<style>") and line(26).endswith("</style>")
    assert line(27).startswith("<style>") and line(92) == "</style>"
    assert line(534) == "<script>" and line(1483) == "</script>"

    def write(rel: str, content: str) -> None:
        path = SRC / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")

    write("styles/tailwind.css", line(26)[len("<style>"):-len("</style>")])
    app_css = "\n".join([line(27)[len("<style>"):]] + lines[27:91]) + "\n"
    write("styles/app.css", app_css)

    for rel, start, end in JS_PARTS:
        write(rel, "\n".join(lines[start - 1:end]) + "\n")

    template = (
        lines[0:25]
        + ["<!-- @inline-css styles/tailwind.css -->", "<!-- @inline-css styles/app.css -->"]
        + lines[92:533]
        + ["<!-- @inline-js -->"]
        + lines[1483:]
    )
    write("index.html", "\n".join(template) + "\n")
    print("已拆出：", ", ".join(["index.html", "styles/tailwind.css", "styles/app.css"] + [p[0] for p in JS_PARTS]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
