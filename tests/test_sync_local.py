import json
import hashlib
import threading
from http.server import ThreadingHTTPServer

import pytest

from sync_local import LocalSyncManager
from sync_server import SyncStore, make_handler


@pytest.fixture
def sync_service(tmp_path):
    store = SyncStore(tmp_path / "remote")
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def manager(root):
    return LocalSyncManager(root, root / "ui-state.json", lambda value: "protected:" + value, lambda value: value.removeprefix("protected:"))


def test_local_mode_never_opens_network(tmp_path):
    calls = []
    client = LocalSyncManager(tmp_path, tmp_path / "ui.json", lambda x: x, lambda x: x, opener=lambda *args, **kwargs: calls.append(args))
    client.record_ui_patch({"yuejian-theme": "starry"})
    result = client.run_sync_once()
    assert result["skipped"] is True
    assert result["pendingChanges"] == 1
    assert calls == []


def test_login_sync_and_remote_state_application(tmp_path, sync_service):
    desktop = manager(tmp_path / "desktop")
    phone = manager(tmp_path / "phone")
    desktop.record_ui_patch({"yuejian-theme": "starry"})
    registered = desktop.login(sync_service, "reader", "correct-password", register=True)
    assert registered["mode"] == "account"
    phone.login(sync_service, "reader", "correct-password")
    result = phone.run_sync_once()
    assert result["ok"]
    state = json.loads((tmp_path / "phone" / "ui-state.json").read_text(encoding="utf-8"))
    assert state["yuejian-theme"] == "starry"


def test_qa_topics_sync_as_independent_entities(tmp_path, sync_service):
    desktop = manager(tmp_path / "desktop")
    phone = manager(tmp_path / "phone")
    first = "yuejian-qa-topic-qa-first"
    second = "yuejian-qa-topic-qa-second"
    first_value = json.dumps({"id": "qa-first", "bookId": "a" * 64, "title": "第一议题", "messages": [], "updatedAt": 1})
    second_value = json.dumps({"id": "qa-second", "bookId": "a" * 64, "title": "第二议题", "messages": [], "updatedAt": 2})
    (tmp_path / "desktop").mkdir(parents=True, exist_ok=True)
    (tmp_path / "desktop" / "ui-state.json").write_text(json.dumps({first: first_value}), encoding="utf-8")
    desktop.record_ui_patch({first: first_value})
    desktop.login(sync_service, "qa-reader", "correct-password", register=True)
    (tmp_path / "phone").mkdir(parents=True, exist_ok=True)
    (tmp_path / "phone" / "ui-state.json").write_text(json.dumps({second: second_value}), encoding="utf-8")
    phone.record_ui_patch({second: second_value})
    phone.login(sync_service, "qa-reader", "correct-password")
    desktop.run_sync_once()
    state = json.loads((tmp_path / "desktop" / "ui-state.json").read_text(encoding="utf-8"))
    assert json.loads(state[first])["title"] == "第一议题"
    assert json.loads(state[second])["title"] == "第二议题"


def test_offline_does_not_drop_outbox(tmp_path):
    client = manager(tmp_path)
    client.account_file.parent.mkdir(parents=True, exist_ok=True)
    client.account_file.write_text(json.dumps({
        "mode": "account", "serverUrl": "http://127.0.0.1:9", "username": "reader",
        "deviceId": "d44b1c56-ad12-4ba6-b15d-4c5b2314ee2c", "deviceName": "Test",
        "tokenProtected": "protected:token",
    }), encoding="utf-8")
    client.record_ui_patch({"yuejian-theme": "starry"})
    before = client._outbox()
    result = client.run_sync_once()
    assert not result["ok"] and result["offline"]
    assert client._outbox() == before


def test_sensitive_keys_are_not_queued(tmp_path):
    client = manager(tmp_path)
    client.record_ui_patch({
        "yuejian-theme": "night",
        "yuejian-ai-api-key": "secret",
        "yuejian-login-token": "secret",
    })
    serialized = json.dumps(client._outbox())
    assert "night" in serialized
    assert "secret" not in serialized


def test_book_blob_round_trip_between_devices(tmp_path, sync_service):
    desktop = manager(tmp_path / "desktop")
    phone = manager(tmp_path / "phone")
    content = b"Yuejian synced plain text book"
    digest = hashlib.sha256(content).hexdigest()
    library_dir = tmp_path / "desktop" / "library"
    library_dir.mkdir(parents=True)
    (library_dir / f"{digest}.txt").write_bytes(content)
    desktop.record_book(digest, {
        "title": "Synced Book", "original_name": "synced.txt", "stored_name": f"{digest}.txt",
        "file_size": len(content), "added_at": "2026-07-15T00:00:00Z", "last_opened": "",
    })
    assert desktop.login(sync_service, "blob-reader", "correct-password", register=True)["sync"]["uploadedBlobs"] == 1
    result = phone.login(sync_service, "blob-reader", "correct-password")
    assert result["sync"]["downloadedBlobs"] == 1
    assert (tmp_path / "phone" / "library" / f"{digest}.txt").read_bytes() == content
    library = json.loads((tmp_path / "phone" / "library.json").read_text(encoding="utf-8"))
    assert library[digest]["title"] == "Synced Book"


def test_first_login_bootstraps_existing_library(tmp_path, sync_service):
    desktop = manager(tmp_path / "desktop")
    content = b"Book imported before account mode existed"
    digest = hashlib.sha256(content).hexdigest()
    (tmp_path / "desktop" / "library").mkdir(parents=True)
    (tmp_path / "desktop" / "library" / f"{digest}.txt").write_bytes(content)
    (tmp_path / "desktop" / "library.json").write_text(json.dumps({digest: {
        "title": "Existing Book", "original_name": "existing.txt", "stored_name": f"{digest}.txt",
        "file_size": len(content), "added_at": "2026-07-15T00:00:00Z", "last_opened": "",
    }}), encoding="utf-8")
    result = desktop.login(sync_service, "existing-reader", "correct-password", register=True)
    assert result["initialSnapshot"]["books"] == 1
    assert result["sync"]["uploadedBooks"] == 1


def test_reading_reports_sum_independent_device_contributions(tmp_path, sync_service):
    book_id = "a" * 64
    first = manager(tmp_path / "first")
    second = manager(tmp_path / "second")
    for root, seconds, chars in ((tmp_path / "first", 120, 900), (tmp_path / "second", 80, 600)):
        root.mkdir(parents=True, exist_ok=True)
        (root / "ui-state.json").write_text(json.dumps({"yuejian-reading-contributions": json.dumps({
            book_id: {"daily": {"2026-07-15": seconds}, "dailyChars": {"2026-07-15": chars}}
        })}), encoding="utf-8")
    first.login(sync_service, "stats-reader", "correct-password", register=True)
    second.login(sync_service, "stats-reader", "correct-password")
    first.run_sync_once()
    state = json.loads((tmp_path / "first" / "ui-state.json").read_text(encoding="utf-8"))
    reports = json.loads(state["yuejian-reading-stats"])
    assert reports[book_id]["daily"]["2026-07-15"] == 200
    assert reports[book_id]["dailyChars"]["2026-07-15"] == 1500
    assert reports[book_id]["completed"] == []
    assert reports[book_id]["sessions"] == 0


def test_remote_book_delete_removes_other_device_copy(tmp_path, sync_service):
    first = manager(tmp_path / "first")
    second = manager(tmp_path / "second")
    content = b"book deleted on another device"
    digest = hashlib.sha256(content).hexdigest()
    library_dir = tmp_path / "first" / "library"
    library_dir.mkdir(parents=True)
    (library_dir / f"{digest}.txt").write_bytes(content)
    entry = {"title": "Delete Me", "original_name": "delete.txt", "stored_name": f"{digest}.txt", "file_size": len(content)}
    first.record_book(digest, entry)
    first.login(sync_service, "delete-reader", "correct-password", register=True)
    second.login(sync_service, "delete-reader", "correct-password")
    assert digest in json.loads((tmp_path / "second" / "library.json").read_text(encoding="utf-8"))
    first.record_book(digest, entry, deleted=True)
    first.run_sync_once()
    second.run_sync_once()
    library = json.loads((tmp_path / "second" / "library.json").read_text(encoding="utf-8"))
    assert digest not in library
    assert not (tmp_path / "second" / "library" / f"{digest}.txt").exists()


def test_ai_report_syncs_without_ai_credentials_and_is_marked_cached(tmp_path, sync_service):
    book_id = "b" * 64
    desktop = manager(tmp_path / "desktop")
    phone = manager(tmp_path / "phone")
    report = {
        "title": "Already analyzed", "provider": "deepseek", "model": "deepseek-v4-pro",
        "analyzed_at": "2026-07-15T12:00:00Z", "revision_count": 1,
        "analysis": {"schema_version": 2, "one_sentence": "同步后的报告", "book_purpose": "验证报告无需密钥即可查看", "caveat": "测试"},
    }
    (tmp_path / "desktop").mkdir(parents=True, exist_ok=True)
    (tmp_path / "desktop" / "analysis-cache.json").write_text(json.dumps({book_id: report}), encoding="utf-8")
    desktop.login(sync_service, "analysis-reader", "correct-password", register=True)
    phone.login(sync_service, "analysis-reader", "correct-password")
    cached = json.loads((tmp_path / "phone" / "analysis-cache.json").read_text(encoding="utf-8"))
    assert cached[book_id]["analysis"]["one_sentence"] == "同步后的报告"
    assert cached[book_id]["model"] == "deepseek-v4-pro"
