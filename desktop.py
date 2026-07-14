"""阅见 Windows 桌面版入口。"""
import ctypes
import os
import secrets
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import webview

import server


HOST = "127.0.0.1"


def run_http(httpd):
    os.chdir(server.ROOT)
    httpd.serve_forever()


def create_httpd(access_token=None):
    # 端口设为 0，由 Windows 自动分配当前可用的本机端口。
    # 服务只绑定 127.0.0.1，不对局域网或互联网开放。
    access_token = access_token or secrets.token_urlsafe(32)
    httpd = ThreadingHTTPServer((HOST, 0), server.app_handler(access_token))
    httpd.access_token = access_token
    return httpd


def self_test():
    """供打包后验证使用，不打开软件窗口。"""
    httpd = create_httpd()
    port = httpd.server_address[1]
    thread = threading.Thread(target=run_http, args=(httpd,), daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/health?token={httpd.access_token}", timeout=5) as response:
            return 0 if response.status == 200 and server.VERSION.encode("ascii") in response.read() else 1
    finally:
        httpd.shutdown()
        httpd.server_close()


def main():
    mutex = None
    if os.name == "nt":
        mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\YuejianReader")
        if ctypes.windll.kernel32.GetLastError() == 183:
            ctypes.windll.user32.MessageBoxW(None, "阅见已经在运行。", "阅见", 0x40)
            ctypes.windll.kernel32.CloseHandle(mutex)
            return
    httpd = create_httpd()
    port = httpd.server_address[1]
    thread = threading.Thread(target=run_http, args=(httpd,), daemon=True)
    thread.start()

    window = webview.create_window(
        "阅见",
        f"http://{HOST}:{port}/?desktop=1&token={httpd.access_token}",
        width=1440,
        height=900,
        min_size=(1050, 700),
        background_color="#fbfaf5",
        text_select=True,
        confirm_close=False,
    )
    window.events.closed += httpd.shutdown
    try:
        webview.start(
            gui="edgechromium",
            private_mode=False,
            storage_path=str(server.APP_DATA_DIR / "webview"),
            debug=False,
        )
    finally:
        httpd.shutdown()
        httpd.server_close()
        if mutex:
            ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    main()
