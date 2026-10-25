"""建置網站（可重複執行）。

用法：
    python tools/build.py            產生 docs/（GitHub Pages 發布的資料夾）
    python tools/build.py --out 路徑  產生到其他資料夾（例如測試用）

流程：讀取 src/index.html，把 <!-- @inline-css ... --> 與 <!-- @inline-js -->
換成 src/ 內對應檔案的內容，得到單一 HTML（樣式與程式都內嵌，不依賴外部字型
或樣式 CDN）。接著複製 src/static/ 的檔案，並把建置代碼寫入 sw.js，讓手機
知道有新版本。只用 Python 標準函式庫，不需要 Node.js。
"""
import argparse
import hashlib
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

# 程式依序串接成同一個 <script>。10～60 是既有功能（從成品拆出），其餘是同步與離線載入。
JS_ORDER = [
    "firebase-config.js",       # Firebase 網頁設定（公開值，未設定時為 null）
    "js/10-icons-base.js",
    "js/20-icon-overrides.js",
    "js/30-icon-catalog.js",
    "js/40-views.js",
    "js/50-icon-picker.js",
    "js/52-category-editor.js", # 分類編輯（新增與修改共用）
    "js/55-sync-core.js",       # 同步核心：比對、衝突、補傳（不綁定雲端服務）
    "js/58-store.js",           # 帳本儲存：IndexedDB（無法使用時退回 localStorage）
    "js/60-app.js",
    "js/62-budget.js",          # 每月預算
    "js/64-stats-compare.js",   # 統計比較與近 12 個月走勢
    "js/66-recurring.js",       # 固定收支（到期自動記帳）
    "js/70-sync-firebase.js",   # Firebase 登入與資料庫連線
    "js/80-sync-ui.js",         # 同步流程與畫面
    "js/90-pwa.js",             # 離線載入與版本更新
]

CSS_MARKER = re.compile(r"^(\s*)<!-- @inline-css (\S+) -->$")
JS_MARKER = re.compile(r"^(\s*)<!-- @inline-js -->$")


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


def check_sources() -> None:
    listed = set(JS_ORDER)
    present = {p.relative_to(SRC).as_posix() for p in (SRC / "js").rglob("*.js")}
    missing = sorted(rel for rel in listed if not (SRC / rel).is_file())
    unlisted = sorted(present - listed)
    if missing:
        sys.exit(f"找不到程式檔：{', '.join(missing)}")
    if unlisted:
        sys.exit(f"src/js 有未列入 JS_ORDER 的檔案：{', '.join(unlisted)}")
    for rel in JS_ORDER:
        if "</script" in read(rel).lower():
            sys.exit(f"{rel} 含有 </script>，內嵌後會截斷程式，請改寫成 '<\\/script>'")


def render_html() -> str:
    out = []
    for line in read("index.html").split("\n"):
        css = CSS_MARKER.match(line)
        if css:
            out.append(f"{css.group(1)}<style>{read(css.group(2))}</style>")
            continue
        js = JS_MARKER.match(line)
        if js:
            bundle = "".join(read(rel) for rel in JS_ORDER)
            out.append(f"{js.group(1)}<script>\n{bundle}</script>")
            continue
        out.append(line)
    return "\n".join(out)


def build(out_dir: pathlib.Path) -> str:
    check_sources()
    html = render_html()
    version = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]
    html = html.replace("__BUILD_VERSION__", version)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html, encoding="utf-8", newline="\n")

    static = SRC / "static"
    if static.is_dir():
        for path in sorted(static.rglob("*")):
            if not path.is_file():
                continue
            target = out_dir / path.relative_to(static)
            target.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix in {".js", ".webmanifest", ".json", ".txt", ".svg", ".html"}:
                text = path.read_text(encoding="utf-8").replace("__BUILD_VERSION__", version)
                target.write_text(text, encoding="utf-8", newline="\n")
            else:
                shutil.copyfile(path, target)
    # GitHub Pages 預設會用 Jekyll 處理檔案；這個空檔案讓它原樣發布。
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description="建置記帳網站")
    parser.add_argument("--out", default=str(ROOT / "docs"), help="輸出資料夾（預設 docs/）")
    args = parser.parse_args()
    out_dir = pathlib.Path(args.out).resolve()
    version = build(out_dir)
    size = (out_dir / "index.html").stat().st_size
    print(f"完成：{out_dir / 'index.html'}（{size:,} 位元組，版本 {version}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
