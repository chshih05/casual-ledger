"""在背景的瀏覽器（Chrome、Chromium 或 Edge 的無頭模式）跑自動測試，結果印在終端機。只用 Python 標準函式庫。

用法：
    python tools/run_tests.py                 先建置網站，再跑全部測試
    python tools/run_tests.py --only 返回手勢  只跑名稱含有關鍵字的測試
    python tools/run_tests.py --no-build      不重新建置（docs/ 已是最新時）

找不到瀏覽器時，用環境變數 CHROME_PATH 指定執行檔位置。GitHub Actions 每次推送也是用這個檔案跑測試。
測試頁只在本機測試網址執行，用獨立的瀏覽器設定檔，不會碰到正式帳本。
全部通過時結束代碼為 0，有失敗或逾時為 1。
"""
import argparse
import functools
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "chrome", "msedge"]
BROWSER_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_browser():
    if os.environ.get("CHROME_PATH"):
        return os.environ["CHROME_PATH"]
    for name in BROWSER_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return next((p for p in BROWSER_PATHS if pathlib.Path(p).is_file()), None)


class Handler(http.server.SimpleHTTPRequestHandler):
    """提供專案檔案；測試頁跑完後把結果 POST 到 /__report。"""

    def do_POST(self):
        if self.path != "/__report":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.server.report = json.loads(body or b"null")
        self.send_response(204)
        self.end_headers()
        self.server.finished.set()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")   # 每次都讀最新的檔案
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="在背景的瀏覽器跑自動測試")
    parser.add_argument("--only", default="", help="只跑名稱含有這個關鍵字的測試")
    parser.add_argument("--no-build", action="store_true", help="不重新建置網站")
    parser.add_argument("--timeout", type=int, default=600, help="最多等幾秒（預設 600）")
    args = parser.parse_args()

    if not args.no_build:
        subprocess.run([sys.executable, str(ROOT / "tools" / "build.py")], check=True)
    browser = find_browser()
    if not browser:
        print("找不到 Chrome、Chromium 或 Edge。請安裝其中一個，或用環境變數 CHROME_PATH 指定執行檔。")
        return 1

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    server.report, server.finished = None, threading.Event()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    query = "report" + (f"&only={urllib.parse.quote(args.only)}" if args.only else "")
    url = f"http://127.0.0.1:{server.server_address[1]}/tests/run.html?{query}"

    profile = tempfile.mkdtemp(prefix="ledger-test-")
    command = [browser, "--headless=new", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
               "--disable-gpu", "--disable-extensions", "--window-size=1280,900", url]
    # 以 root 執行、或在 GitHub Actions 這類自動化環境時，Chrome 的沙箱常常無法啟動；這裡只開本機的測試頁，關掉沒關係。
    if os.environ.get("CI") or (hasattr(os, "geteuid") and os.geteuid() == 0):
        command[1:1] = ["--no-sandbox", "--disable-dev-shm-usage"]
    print(f"使用瀏覽器：{browser}")
    proc = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        finished = server.finished.wait(args.timeout)
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    report = server.report
    if not finished or not report:
        print(f"測試在 {args.timeout} 秒內沒有跑完。")
        return 1
    for item in report.get("results", []):
        if not item.get("ok"):
            print(f"✗ {item.get('name')}\n  {item.get('error', '').replace(chr(10), chr(10) + '  ')}")
    passed, failed = report.get("passed", 0), report.get("failed", 0)
    print(f"完成：通過 {passed}・失敗 {failed}")
    return 0 if failed == 0 and passed > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
