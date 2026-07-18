import hashlib
import base64
import http.client
import io
import json
import threading
import time
import zipfile

import pytest

import server
import ai_client


class FakeUrlResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, limit=-1):
        return self.payload[:limit]


def test_basic_translation_uses_public_service_and_local_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "TRANSLATION_CACHE_FILE", tmp_path / "translation-cache.json")
    calls = []

    def fake_open(request, timeout):
        calls.append((request.full_url, timeout))
        return FakeUrlResponse({"responseStatus": 200, "responseData": {"translatedText": "你好世界"}})

    monkeypatch.setattr(server.urllib.request, "urlopen", fake_open)
    first = server.basic_translate("Hello world")
    second = server.basic_translate("Hello world")
    assert first["translation"] == "你好世界" and first["provider"] == "MyMemory"
    assert second["cached"] is True and len(calls) == 1
    assert "langpair=autodetect%7Czh-CN" in calls[0][0]


def test_translation_chunks_preserve_text_and_utf8_limit():
    source = "这是一个用于检查 UTF-8 安全分段的句子。" * 80
    chunks = server.translation_chunks(source)
    assert "".join(chunks) == source
    assert all(len(chunk.encode("utf-8")) <= 450 for chunk in chunks)


def test_bookmark_image_is_validated_and_saved_to_downloads(tmp_path, monkeypatch):
    png = b"\x89PNG\r\n\x1a\n" + b"bookmark-image"
    monkeypatch.setattr(server.Path, "home", classmethod(lambda cls: tmp_path))
    result = server.save_bookmark_image("data:image/png;base64," + base64.b64encode(png).decode(), '测试:书签.png')
    target = server.Path(result["path"])
    assert target.read_bytes() == png
    assert target.parent.name == "阅见书签"
    with pytest.raises(ValueError):
        server.save_bookmark_image("data:image/png;base64," + base64.b64encode(b"not-png").decode(), "bad.png")


def test_storage_status_exposes_fixed_local_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(server.Path, "home", classmethod(lambda cls: tmp_path))
    status = server.storage_status()
    assert status["bookPath"] == str(server.LIBRARY_DIR)
    assert status["bookmarkPath"] == str(tmp_path / "Downloads" / "阅见书签")


@pytest.mark.parametrize("status,details", [(402, "payment required"), (429, '{"error":{"code":"insufficient_quota"}}'), (400, "账户余额不足，请充值")])
def test_ai_balance_errors_are_clear(status, details):
    assert "余额或可用额度不足" in str(ai_client.api_http_error(status, details))


def test_ai_rate_limit_is_not_misreported_as_balance():
    message = str(ai_client.api_http_error(429, "rate limit exceeded"))
    assert "请求过于频繁" in message and "余额不足" not in message


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


def build_anchored_ncx_epub():
    output = io.BytesIO()
    paragraph = "This is section body text long enough to remain readable after anchor splitting. " * 3
    chapter = f"""<html xmlns="http://www.w3.org/1999/xhtml"><body>
    <p><a href="#part-two">A link in the internal contents must not be treated as the anchor.</a></p>
    <span id="part-one"></span><h1>Part one</h1><p>{paragraph}</p>
    <span id="part-two"></span><h1>Part two</h1><p>{paragraph}</p>
    <a name="part-three"></a><h1>Part three</h1><p>{paragraph}</p>
    </body></html>"""
    ncx = """<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
    <navPoint><navLabel><text>Part one</text></navLabel><content src="chapter.xhtml#part-one"/></navPoint>
    <navPoint><navLabel><text>Part two</text></navLabel><content src="chapter.xhtml#part-two"/></navPoint>
    <navPoint><navLabel><text>Part three</text></navLabel><content src="chapter.xhtml#part-three"/></navPoint>
    </navMap></ncx>"""
    package = """<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Anchored book</dc:title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="chapter"/></spine></package>"""
    container = """<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("OPS/package.opf", package)
        archive.writestr("OPS/toc.ncx", ncx)
        archive.writestr("OPS/chapter.xhtml", chapter)
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


def test_epub_preserves_multiple_anchored_ncx_entries_in_one_file():
    data = build_anchored_ncx_epub()
    title, chapters = server.extract_book("anchored.epub", data, hashlib.sha256(data).hexdigest())
    assert title == "Anchored book"
    assert [chapter["title"] for chapter in chapters] == ["Part one", "Part two", "Part three"]
    assert "Part two" not in chapters[0]["text"]
    assert "Part two" in chapters[1]["text"]
    assert "Part three" not in chapters[1]["text"]


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
