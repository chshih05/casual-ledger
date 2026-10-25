"""檢查畫面用到的樣式名稱是否真的存在（可重複執行）。

src/styles/tailwind.css 是先前編譯好的 Tailwind 樣式，這台電腦不需要 Node.js
就能建置；代價是新增畫面時，若用了編譯檔裡沒有的 Tailwind 樣式名稱，畫面會
默默失去樣式。這個工具列出這類名稱，提醒改用 app.css 自訂樣式。

用法：python tools/check_classes.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"

# 只當作程式掛鉤、刻意沒有樣式的名稱。
HOOK_CLASSES = {
    "record-item-btn", "keypad-btn", "op-btn", "setting-header-btn", "mode-check",
    "settings-page", "category-edit", "dark",
}
TEMPLATE_EXPR = re.compile(r"\$\{[^{}]*\}")

STRING_PATTERNS = [
    re.compile(r'class="([^"]*)"'),
    re.compile(r"className\s*=\s*'([^']*)'"),
    re.compile(r'className\s*=\s*"([^"]*)"'),
    re.compile(r"className\s*=\s*`([^`]*)`"),
    re.compile(r"classList\.(?:add|remove|toggle)\(\s*'([^']+)'"),
]


def escape_class(name: str) -> str:
    return "".join(ch if re.match(r"[A-Za-z0-9_-]", ch) else "\\" + ch for ch in name)


def main() -> int:
    css = (SRC / "styles" / "tailwind.css").read_text(encoding="utf-8")
    css += (SRC / "styles" / "app.css").read_text(encoding="utf-8")
    css += (SRC / "index.html").read_text(encoding="utf-8")  # <head> 內的基本樣式
    files = [SRC / "index.html", *sorted((SRC / "js").glob("*.js"))]
    unknown: dict[str, set[str]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8")
        for pattern in STRING_PATTERNS:
            for match in pattern.finditer(text):
                # 樣板字串中的 ${...} 是程式運算，不是樣式名稱；先移除再檢查。
                for token in TEMPLATE_EXPR.sub(" ", match.group(1)).split():
                    if "$" in token or "{" in token or "}" in token or token in HOOK_CLASSES:
                        continue
                    selector = "." + escape_class(token)
                    if not re.search(re.escape(selector) + r"(?![A-Za-z0-9_\\-])", css):
                        unknown.setdefault(token, set()).add(path.relative_to(ROOT).as_posix())
    if not unknown:
        print("所有樣式名稱都有對應樣式。")
        return 0
    print("下列樣式名稱在編譯好的樣式中找不到（畫面可能沒有套用）：")
    for token in sorted(unknown):
        print(f"  {token}  ← {', '.join(sorted(unknown[token]))}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
