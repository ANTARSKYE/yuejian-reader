"""阅见 Windows 桌面版入口。"""
import os
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


def create_httpd():
    # 端口设为 0，由 Windows 自动分配当前可用的本机端口。
    # 服务只绑定 127.0.0.1，不对局域网或互联网开放。
    return ThreadingHTTPServer((HOST, 0), server.App)


def self_test():
    """供打包后验证使用，不打开软件窗口。"""
    httpd = create_httpd()
    port = httpd.server_address[1]
    thread = threading.Thread(target=run_http, args=(httpd,), daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/health", timeout=5) as response:
            return 0 if response.status == 200 and b'"version": "1.1"' in response.read() else 1
    finally:
        httpd.shutdown()
        httpd.server_close()


def main():
    httpd = create_httpd()
    port = httpd.server_address[1]
    thread = threading.Thread(target=run_http, args=(httpd,), daemon=True)
    thread.start()

    window = webview.create_window(
        "阅见",
        f"http://{HOST}:{port}/?desktop=1",
        width=1440,
        height=900,
        min_size=(1050, 700),
        background_color="#fbfaf5",
        text_select=True,
        confirm_close=False,
    )
    window.events.closed += httpd.shutdown
    webview.start(
        gui="edgechromium",
        private_mode=False,
        storage_path=str(server.APP_DATA_DIR / "webview"),
        debug=False,
    )


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        raise SystemExit(self_test())
    main()
