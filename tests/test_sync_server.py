import hashlib
import http.client
import json
import socket
import threading
import time
import uuid

import pytest

from sync_server import DISCOVERY_REQUEST, PROTOCOL, TOKEN_MAX_IDLE_MS, LoginRateLimiter, SyncError, SyncStore, make_handler, now_ms, serve_discovery
from http.server import ThreadingHTTPServer


def device():
    return str(uuid.uuid4())


def change(entity="app_state", entity_id="theme", value="starry", updated=100):
    return {
        "changeId": str(uuid.uuid4()),
        "entityType": entity,
        "entityId": entity_id,
        "operation": "upsert",
        "payload": {"key": entity_id, "value": value, "updatedAt": updated},
        "createdAt": updated,
    }


def exchange_request(device_id, changes, cursor=0):
    return {
        "protocol": PROTOCOL,
        "protocolVersion": 1,
        "deviceId": device_id,
        "cursor": cursor,
        "changes": changes,
        "limit": 200,
    }


def test_register_login_password_and_token(tmp_path):
    store = SyncStore(tmp_path)
    first = device()
    registered = store.register("reader.one", "correct-password", first, "Windows")
    assert registered["accessToken"]
    assert store.authenticate("Bearer " + registered["accessToken"])["username"] == "reader.one"
    with pytest.raises(SyncError) as wrong:
        store.login("reader.one", "wrong-password", device(), "Phone")
    assert wrong.value.status == 401
    with store.connect() as db:
        row = db.execute("SELECT password_hash,salt FROM users").fetchone()
        token = db.execute("SELECT token_hash FROM devices").fetchone()[0]
    assert row["password_hash"] != "correct-password"
    assert token != registered["accessToken"]


def test_idle_access_token_expires(tmp_path):
    store = SyncStore(tmp_path)
    registered = store.register("reader", "correct-password", device(), "Windows")
    with store.connect() as db:
        db.execute("UPDATE devices SET last_seen_at=?", (now_ms() - TOKEN_MAX_IDLE_MS - 1,))
    with pytest.raises(SyncError) as expired:
        store.authenticate("Bearer " + registered["accessToken"])
    assert expired.value.status == 401


def test_login_rate_limiter_blocks_repeated_failures():
    limiter = LoginRateLimiter()
    key = limiter.check("127.0.0.1", "reader")
    for _ in range(8):
        limiter.failed(key)
    with pytest.raises(SyncError) as limited:
        limiter.check("127.0.0.1", "reader")
    assert limited.value.status == 429


def test_idempotent_exchange_and_second_device_pull(tmp_path):
    store = SyncStore(tmp_path)
    first, second = device(), device()
    account = store.register("reader", "correct-password", first, "Windows")
    phone = store.login("reader", "correct-password", second, "Android")
    auth1 = store.authenticate("Bearer " + account["accessToken"])
    auth2 = store.authenticate("Bearer " + phone["accessToken"])
    item = change()
    result = store.exchange(auth1, exchange_request(first, [item]))
    assert result["accepted"] == [item["changeId"]]
    duplicate = store.exchange(auth1, exchange_request(first, [item]))
    assert duplicate["accepted"] == [item["changeId"]]
    pulled = store.exchange(auth2, exchange_request(second, []))
    assert [entry["changeId"] for entry in pulled["changes"]] == [item["changeId"]]
    with store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM changes").fetchone()[0] == 1


def test_tombstone_newer_than_old_upsert(tmp_path):
    store = SyncStore(tmp_path)
    first, second = device(), device()
    account = store.register("reader", "correct-password", first, "Windows")
    phone = store.login("reader", "correct-password", second, "Android")
    auth1 = store.authenticate("Bearer " + account["accessToken"])
    auth2 = store.authenticate("Bearer " + phone["accessToken"])
    deleted = change("annotation", "note-1", "", 200)
    deleted["operation"] = "delete"
    deleted["payload"] = {"updatedAt": 200}
    store.exchange(auth1, exchange_request(first, [deleted]))
    stale = change("annotation", "note-1", "old", 100)
    result = store.exchange(auth2, exchange_request(second, [stale]))
    assert result["conflicts"][0]["reason"] == "deleted_on_another_device"
    with store.connect() as db:
        row = db.execute("SELECT deleted,updated_at FROM entities").fetchone()
    assert tuple(row) == (1, 200)


def test_tombstone_requires_explicit_restore(tmp_path):
    store = SyncStore(tmp_path)
    first, second = device(), device()
    account = store.register("reader", "correct-password", first, "Windows")
    phone = store.login("reader", "correct-password", second, "Android")
    auth1 = store.authenticate("Bearer " + account["accessToken"])
    auth2 = store.authenticate("Bearer " + phone["accessToken"])
    deleted = change("book", "a" * 64, "", 200)
    deleted["operation"] = "delete"
    deleted["payload"] = {"updatedAt": 200}
    store.exchange(auth1, exchange_request(first, [deleted]))
    restored = change("book", "a" * 64, "restored", 300)
    restored["payload"]["restoreDeleted"] = True
    result = store.exchange(auth2, exchange_request(second, [restored]))
    assert not result["conflicts"]
    with store.connect() as db:
        assert db.execute("SELECT deleted FROM entities").fetchone()[0] == 0


def test_blob_hash_is_verified(tmp_path):
    store = SyncStore(tmp_path)
    data = b"book data"
    digest = hashlib.sha256(data).hexdigest()
    assert store.put_blob(digest, data, "application/epub+zip")["size"] == len(data)
    assert store.blob(digest)[0].read_bytes() == data
    with pytest.raises(SyncError):
        store.put_blob("0" * 64, data, "application/octet-stream")


@pytest.fixture
def live_server(tmp_path):
    store = SyncStore(tmp_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield store, server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(port, method, path, body=None, token=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    headers = {}
    encoded = None
    if body is not None:
        encoded = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    connection.request(method, path, encoded, headers)
    response = connection.getresponse()
    value = json.loads(response.read())
    connection.close()
    return response.status, value


def test_http_health_and_unauthorized_exchange(live_server):
    _, port = live_server
    status, health = request(port, "GET", "/api/v1/health")
    assert status == 200 and health["protocol"] == PROTOCOL
    status, result = request(port, "POST", "/api/v1/sync/exchange", exchange_request(device(), []))
    assert status == 401 and not result["ok"]


def test_lan_discovery_reply_contains_server_url():
    stop = threading.Event()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.bind(("127.0.0.1", 0))
        discovery_port = probe.getsockname()[1]
    thread = threading.Thread(target=serve_discovery, args=(stop, 18787, discovery_port), daemon=True)
    thread.start()
    time.sleep(0.05)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(2)
            client.sendto(DISCOVERY_REQUEST, ("127.0.0.1", discovery_port))
            payload = json.loads(client.recvfrom(1024)[0])
        assert payload["protocol"] == "yuejian-sync-discovery-v1"
        assert payload["url"] == "http://127.0.0.1:18787"
    finally:
        stop.set()
        thread.join(timeout=2)
