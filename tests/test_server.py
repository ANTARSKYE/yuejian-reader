import hashlib
import http.client
import io
import json
import threading
import time
import zipfile

import pytest

import server


def build_epub():
    output = io.BytesIO()
    chapter = """<?xml version="1.0" encoding="utf-8"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>正文标题</h1>
    <p>这是一段足够长的 EPUB 测试正文，用于验证目录标题、文字编码、安全清洗、脚注和图片资源是否能被阅读器正确保留。为了超过最小正文长度，这里再补充一些文字。</p>
    <img src="../images/p.png" onerror="alert(1)" alt="插图"/><script>alert(1)</script>
    <aside id="note-1">这是脚注。</aside></body></html>"""
    nav = """<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="text/ch1.xhtml">来自目录的标题</a></li></ol></nav></body></html>"""
    package = """<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/p.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>"""
    container = """<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("OPS/package.opf", package)
        archive.writestr("OPS/nav.xhtml", nav)
        archive.writestr("OPS/text/ch1.xhtml", chapter)
        archive.writestr("OPS/images/p.png", b"\x89PNG\r\n\x1a\n" + b"0" * 40)
    return output.getvalue()


def valid_analysis():
    value = {
        "one_sentence": "一句话",
        "book_purpose": "目的",
        "caveat": "边界",
        "domain": {},
        "executive_summary": {},
        "reading_guide": {},
    }
    for field in server.ANALYSIS_LIST_FIELDS:
        value[field] = []
    return value


def test_python_313_upload_parser():
    boundary = "----yuejian-test"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"book\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--{boundary}--\r\n"
    ).encode()
    filename, data = server.parse_multipart(
        f"multipart/form-data; boundary={boundary}", body, "book"
    )
    assert filename == "a.txt"
    assert data == b"hello"


def test_epub_toc_sanitization_and_resources(tmp_path, monkeypatch):
    data = build_epub()
    book_hash = hashlib.sha256(data).hexdigest()
    title, chapters = server.extract_book("test.epub", data, book_hash)
    assert title == "测试书"
    assert chapters[0]["title"] == "来自目录的标题"
    assert "<script" not in chapters[0]["html"]
    assert "onerror" not in chapters[0]["html"]
    assert "/api/book/resource" in chapters[0]["html"]
    assert "这是脚注" in chapters[0]["html"]


def test_analysis_schema_rejects_incomplete_output():
    assert server.validate_analysis(valid_analysis())["schema_version"] == 2
    with pytest.raises(ValueError):
        server.validate_analysis({"one_sentence": "x"})


def test_session_store_expires_and_evicts():
    store = server.SessionStore(max_items=2, ttl_seconds=0.03)
    store.put("a", {"value": 1})
    store.put("b", {"value": 2})
    store.put("c", {"value": 3})
    assert store.get("a") is None
    assert len(store) == 2
    time.sleep(0.04)
    assert len(store) == 0


def test_backup_round_trip(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    library_dir = data_dir / "library"
    library_dir.mkdir(parents=True)
    mapping = {
        "APP_DATA_DIR": data_dir,
        "LIBRARY_DIR": library_dir,
        "LIBRARY_FILE": data_dir / "library.json",
        "CACHE_FILE": data_dir / "analysis-cache.json",
        "TIMING_FILE": data_dir / "analysis-timings.json",
        "CHUNK_CACHE_FILE": data_dir / "analysis-chunks.json",
        "UI_STATE_FILE": data_dir / "ui-state.json",
    }
    for name, value in mapping.items():
        monkeypatch.setattr(server, name, value)
    monkeypatch.setattr(
        server,
        "BACKUP_JSON_FILES",
        {
            "library.json": server.LIBRARY_FILE,
            "analysis-cache.json": server.CACHE_FILE,
            "analysis-timings.json": server.TIMING_FILE,
            "analysis-chunks.json": server.CHUNK_CACHE_FILE,
            "ui-state.json": server.UI_STATE_FILE,
        },
    )
    book_hash = "a" * 64
    server.write_json(server.LIBRARY_FILE, {book_hash: {"title": "A"}})
    (library_dir / f"{book_hash}.txt").write_text("book", encoding="utf-8")
    backup = server.create_backup()
    server.write_json(server.LIBRARY_FILE, {})
    (library_dir / f"{book_hash}.txt").unlink()
    result = server.restore_backup(backup)
    assert result["books"] == 1
    assert (library_dir / f"{book_hash}.txt").read_text(encoding="utf-8") == "book"


def test_backup_never_contains_keys_logs_or_webview_data(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    library_dir = data_dir / "library"
    library_dir.mkdir(parents=True)
    ai_config = data_dir / "ai-config.secure.json"
    ai_config.write_text('{"protected_key":"secret"}', encoding="utf-8")
    (data_dir / "logs").mkdir()
    (data_dir / "logs" / "yuejian.log").write_text("private log", encoding="utf-8")
    (data_dir / "webview").mkdir()
    (data_dir / "webview" / "Cookies").write_text("cookie", encoding="utf-8")
    monkeypatch.setattr(server, "APP_DATA_DIR", data_dir)
    monkeypatch.setattr(server, "LIBRARY_DIR", library_dir)
    monkeypatch.setattr(server, "BACKUP_JSON_FILES", {})
    with zipfile.ZipFile(io.BytesIO(server.create_backup())) as archive:
        names = set(archive.namelist())
    assert not any("ai-config" in name or "logs/" in name or "webview/" in name for name in names)


def test_http_requires_launch_token_and_restricts_host():
    token = "test-token"
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.app_handler(token))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", "/api/health")
        assert connection.getresponse().status == 401
        connection.close()

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", f"/api/health?token={token}")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["version"] == server.VERSION
        connection.close()

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.putrequest("GET", f"/api/health?token={token}", skip_host=True)
        connection.putheader("Host", "attacker.example")
        connection.endheaders()
        assert connection.getresponse().status == 403
        connection.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
