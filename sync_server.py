"""Occasionally-online account and sync server for Yuejian Reader.

This service is deliberately separate from the desktop reading server.  It exposes
only account, yuejian-sync-v1 exchange, and authenticated blob endpoints.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


PROTOCOL = "yuejian-sync-v1"
PROTOCOL_VERSION = 1
MAX_JSON_BODY = 2 * 1024 * 1024
MAX_BLOB_BODY = 30 * 1024 * 1024
DISCOVERY_PORT = 8788
DISCOVERY_REQUEST = b"YUEJIAN_DISCOVER_V1"
PBKDF2_ITERATIONS = 600_000
TOKEN_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_LOCK_SECONDS = 10 * 60
LOGIN_MAX_ATTEMPTS = 8
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,40}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
ENTITY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
ALLOWED_ENTITY_TYPES = {
    "app_state", "progress", "reading_daily", "annotation", "reader_mark",
    "bookmark", "book", "book_meta", "analysis", "profile",
}
NEVER_SYNC_KEYS = {"ai_api_key", "login_token", "local_file_path", "ai-config.secure.json"}


def now_ms() -> int:
    return int(time.time() * 1000)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()


class LoginRateLimiter:
    """Small in-memory guard for a trusted-LAN service; never stores passwords."""
    def __init__(self):
        self._lock = threading.Lock()
        self._attempts = {}

    def check(self, client: str, username: str):
        key = (str(client or ""), str(username or "").strip().lower())
        current = time.monotonic()
        with self._lock:
            values = [stamp for stamp in self._attempts.get(key, []) if current - stamp < LOGIN_LOCK_SECONDS]
            self._attempts[key] = values
            recent = [stamp for stamp in values if current - stamp < LOGIN_WINDOW_SECONDS]
            if len(recent) >= LOGIN_MAX_ATTEMPTS:
                retry = max(1, int(LOGIN_LOCK_SECONDS - (current - values[0])))
                raise SyncError(429, f"登录尝试过多，请在 {retry} 秒后重试")
        return key

    def failed(self, key):
        with self._lock:
            self._attempts.setdefault(key, []).append(time.monotonic())

    def succeeded(self, key):
        with self._lock:
            self._attempts.pop(key, None)


class SyncError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class ClosingConnection(sqlite3.Connection):
    """SQLite context manager that also releases the file handle on exit."""
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class SyncStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "sync.db"
        self.blob_dir = self.root / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def connect(self):
        connection = sqlite3.connect(self.db_path, timeout=20, factory=ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self):
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS users(
                  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                  password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS devices(
                  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
                  token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
                  FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS changes(
                  server_seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
                  change_id TEXT UNIQUE NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                  operation TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS changes_user_seq ON changes(user_id, server_seq);
                CREATE INDEX IF NOT EXISTS changes_created_at ON changes(created_at);
                CREATE TABLE IF NOT EXISTS entities(
                  user_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                  operation TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
                  deleted INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY(user_id, entity_type, entity_id)
                );
                CREATE TABLE IF NOT EXISTS blobs(
                  sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, content_type TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS blob_owners(
                  user_id TEXT NOT NULL, sha256 TEXT NOT NULL,
                  PRIMARY KEY(user_id, sha256)
                );
                CREATE INDEX IF NOT EXISTS devices_user_seen ON devices(user_id, last_seen_at);
                CREATE INDEX IF NOT EXISTS entities_user_updated ON entities(user_id, updated_at);
                """
            )

    @staticmethod
    def _validate_credentials(username: str, password: str):
        if not USERNAME_RE.fullmatch(username or ""):
            raise SyncError(400, "用户名需为 3–40 位字母、数字、点、横线或下划线")
        if not isinstance(password, str) or len(password) < 8 or len(password) > 200:
            raise SyncError(400, "密码长度需为 8–200 位")

    @staticmethod
    def _device(device_id: str, device_name: str):
        try:
            parsed = str(uuid.UUID(device_id))
        except (ValueError, AttributeError):
            raise SyncError(400, "deviceId 必须是 UUID")
        name = str(device_name or "Yuejian device").strip()[:80]
        return parsed, name or "Yuejian device"

    def _issue_device(self, db, user_id: str, device_id: str, device_name: str):
        existing = db.execute("SELECT user_id FROM devices WHERE id=?", (device_id,)).fetchone()
        if existing and existing["user_id"] != user_id:
            raise SyncError(409, "设备标识已属于其他账户")
        token = secrets.token_urlsafe(48)
        current = now_ms()
        db.execute(
            "INSERT INTO devices(id,user_id,name,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,last_seen_at=excluded.last_seen_at",
            (device_id, user_id, device_name, token_hash(token), current, current),
        )
        return token

    def register(self, username: str, password: str, device_id: str, device_name: str):
        username = str(username or "").strip().lower()
        self._validate_credentials(username, password)
        device_id, device_name = self._device(device_id, device_name)
        user_id, salt, current = "acc_" + uuid.uuid4().hex, secrets.token_bytes(24), now_ms()
        try:
            with self.connect() as db:
                db.execute(
                    "INSERT INTO users(id,username,password_hash,salt,created_at) VALUES(?,?,?,?,?)",
                    (user_id, username, password_hash(password, salt), salt.hex(), current),
                )
                token = self._issue_device(db, user_id, device_id, device_name)
        except sqlite3.IntegrityError as error:
            raise SyncError(409, "用户名已存在") from error
        return self._login_result(user_id, username, device_id, token)

    def login(self, username: str, password: str, device_id: str, device_name: str):
        username = str(username or "").strip().lower()
        self._validate_credentials(username, password)
        device_id, device_name = self._device(device_id, device_name)
        with self.connect() as db:
            row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if not row or not secrets.compare_digest(row["password_hash"], password_hash(password, bytes.fromhex(row["salt"]))):
                raise SyncError(401, "用户名或密码错误")
            token = self._issue_device(db, row["id"], device_id, device_name)
            return self._login_result(row["id"], username, device_id, token)

    @staticmethod
    def _login_result(user_id, username, device_id, token):
        return {
            "ok": True, "protocol": PROTOCOL, "protocolVersion": PROTOCOL_VERSION,
            "accountId": user_id, "username": username, "deviceId": device_id,
            "accessToken": token, "serverTime": now_ms(),
        }

    def authenticate(self, authorization: str):
        if not authorization.startswith("Bearer "):
            raise SyncError(401, "需要账户访问令牌")
        digest = token_hash(authorization[7:].strip())
        with self.connect() as db:
            row = db.execute(
                "SELECT d.id device_id,d.user_id,d.name,d.last_seen_at,u.username FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=?",
                (digest,),
            ).fetchone()
            if not row:
                raise SyncError(401, "访问令牌无效或已过期")
            if now_ms() - int(row["last_seen_at"] or 0) > TOKEN_MAX_IDLE_MS:
                db.execute("UPDATE devices SET token_hash='' WHERE id=?", (row["device_id"],))
                raise SyncError(401, "登录已过期，请重新登录")
            db.execute("UPDATE devices SET last_seen_at=? WHERE id=?", (now_ms(), row["device_id"]))
            return dict(row)

    def logout(self, auth):
        with self.connect() as db:
            db.execute("UPDATE devices SET token_hash='' WHERE id=? AND user_id=?", (auth["device_id"], auth["user_id"]))
        return {"ok": True}

    @staticmethod
    def _validate_change(change):
        if not isinstance(change, dict):
            raise SyncError(400, "changes 项格式错误")
        try:
            change_id = str(uuid.UUID(str(change.get("changeId", ""))))
        except ValueError as error:
            raise SyncError(400, "changeId 必须是 UUID") from error
        entity_type = str(change.get("entityType", ""))
        entity_id = str(change.get("entityId", ""))
        operation = str(change.get("operation", ""))
        payload = change.get("payload", {})
        if entity_type not in ALLOWED_ENTITY_TYPES or not ENTITY_RE.fullmatch(entity_type):
            raise SyncError(400, "不支持的实体类型")
        if not entity_id or len(entity_id) > 240 or any(key in entity_id.lower() for key in NEVER_SYNC_KEYS):
            raise SyncError(400, "实体标识无效")
        if operation not in {"upsert", "delete"} or not isinstance(payload, dict):
            raise SyncError(400, "变更操作或 payload 无效")
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > 512_000:
            raise SyncError(413, "单项同步数据过大")
        lowered = serialized.lower()
        if any(key in lowered for key in ('"ai_api_key"', '"protected_key"', '"accesstoken"', '"authorization"')):
            raise SyncError(400, "同步数据包含禁止字段")
        updated = int(payload.get("updatedAt", payload.get("updated", change.get("createdAt", now_ms()))) or 0)
        return change_id, entity_type, entity_id, operation, payload, serialized, max(0, updated)

    def exchange(self, auth, request):
        if request.get("protocol") != PROTOCOL or int(request.get("protocolVersion", 0)) != PROTOCOL_VERSION:
            raise SyncError(400, "同步协议版本不兼容")
        if request.get("deviceId") != auth["device_id"]:
            raise SyncError(403, "deviceId 与访问令牌不匹配")
        cursor = max(0, int(request.get("cursor", 0)))
        limit = max(1, min(500, int(request.get("limit", 200))))
        incoming = request.get("changes", [])
        if not isinstance(incoming, list) or len(incoming) > 500:
            raise SyncError(400, "changes 数量无效")
        accepted, conflicts = [], []
        with self.connect() as db:
            for raw in incoming:
                change_id, entity_type, entity_id, operation, payload, serialized, updated = self._validate_change(raw)
                duplicate = db.execute("SELECT server_seq FROM changes WHERE change_id=?", (change_id,)).fetchone()
                if duplicate:
                    accepted.append(change_id)
                    continue
                current = db.execute(
                    "SELECT updated_at,operation FROM entities WHERE user_id=? AND entity_type=? AND entity_id=?",
                    (auth["user_id"], entity_type, entity_id),
                ).fetchone()
                if current and current["operation"] == "delete" and operation != "delete" and not payload.get("restoreDeleted"):
                    conflicts.append({"changeId": change_id, "entityType": entity_type, "entityId": entity_id, "reason": "deleted_on_another_device"})
                    accepted.append(change_id)
                    continue
                if current and (int(current["updated_at"]) > updated or (
                    int(current["updated_at"]) == updated and current["operation"] == "delete" and operation != "delete"
                )):
                    conflicts.append({"changeId": change_id, "entityType": entity_type, "entityId": entity_id, "reason": "remote_newer"})
                    accepted.append(change_id)
                    continue
                created = max(0, int(raw.get("createdAt", now_ms()) or now_ms()))
                db.execute(
                    "INSERT INTO changes(user_id,device_id,change_id,entity_type,entity_id,operation,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (auth["user_id"], auth["device_id"], change_id, entity_type, entity_id, operation, serialized, created),
                )
                db.execute(
                    "INSERT INTO entities(user_id,entity_type,entity_id,operation,payload,updated_at,deleted) VALUES(?,?,?,?,?,?,?) "
                    "ON CONFLICT(user_id,entity_type,entity_id) DO UPDATE SET operation=excluded.operation,payload=excluded.payload,updated_at=excluded.updated_at,deleted=excluded.deleted",
                    (auth["user_id"], entity_type, entity_id, operation, serialized, updated, 1 if operation == "delete" else 0),
                )
                accepted.append(change_id)
            rows = db.execute(
                "SELECT server_seq,change_id,entity_type,entity_id,operation,payload,created_at FROM changes "
                "WHERE user_id=? AND server_seq>? AND device_id<>? ORDER BY server_seq LIMIT ?",
                (auth["user_id"], cursor, auth["device_id"], limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        changes = [{
            "serverSeq": row["server_seq"], "changeId": row["change_id"],
            "entityType": row["entity_type"], "entityId": row["entity_id"],
            "operation": row["operation"], "payload": json.loads(row["payload"]),
            "createdAt": row["created_at"],
        } for row in rows]
        next_cursor = rows[-1]["server_seq"] if rows else cursor
        return {
            "protocol": PROTOCOL, "protocolVersion": PROTOCOL_VERSION,
            "accepted": accepted, "conflicts": conflicts, "changes": changes,
            "nextCursor": next_cursor, "hasMore": has_more, "serverTime": now_ms(),
        }

    def put_blob(self, sha256: str, data: bytes, content_type: str, user_id: str = ""):
        if not SHA256_RE.fullmatch(sha256) or hashlib.sha256(data).hexdigest() != sha256:
            raise SyncError(400, "blob SHA-256 校验失败")
        if len(data) > MAX_BLOB_BODY:
            raise SyncError(413, "书籍文件超过 30MB")
        target = self.blob_dir / sha256
        temporary = self.blob_dir / (sha256 + ".tmp-" + secrets.token_hex(6))
        temporary.write_bytes(data)
        temporary.replace(target)
        with self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO blobs(sha256,size,content_type,created_at) VALUES(?,?,?,?)",
                (sha256, len(data), (content_type or "application/octet-stream")[:120], now_ms()),
            )
            if user_id:
                db.execute("INSERT OR IGNORE INTO blob_owners(user_id,sha256) VALUES(?,?)", (user_id, sha256))
        return {"ok": True, "sha256": sha256, "size": len(data)}

    def blob(self, sha256: str, user_id: str = ""):
        if not SHA256_RE.fullmatch(sha256):
            raise SyncError(404, "文件不存在")
        with self.connect() as db:
            row = db.execute("SELECT * FROM blobs WHERE sha256=?", (sha256,)).fetchone()
            owner = not user_id or db.execute("SELECT 1 FROM blob_owners WHERE user_id=? AND sha256=?", (user_id, sha256)).fetchone()
        path = self.blob_dir / sha256
        if not row or not owner or not path.is_file():
            raise SyncError(404, "文件不存在")
        return path, dict(row)


def make_handler(store: SyncStore):
    limiter = LoginRateLimiter()
    class SyncHandler(BaseHTTPRequestHandler):
        server_version = "YuejianSync/1.0"

        def log_message(self, format, *args):
            # Never log headers, passwords, or tokens. Keep only normal request line/status.
            super().log_message(format, *args)

        def _json(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _read(self, maximum=MAX_JSON_BODY):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise SyncError(400, "Content-Length 无效") from error
            if length < 0 or length > maximum:
                raise SyncError(413, "请求数据过大")
            return self.rfile.read(length)

        def _payload(self):
            try:
                value = json.loads(self._read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SyncError(400, "JSON 格式错误") from error
            if not isinstance(value, dict):
                raise SyncError(400, "请求必须是 JSON 对象")
            return value

        def _auth(self):
            return store.authenticate(self.headers.get("Authorization", ""))

        def _dispatch(self):
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            if self.command == "GET" and path == "/api/v1/health":
                return self._json(200, {"ok": True, "protocol": PROTOCOL, "protocolVersion": PROTOCOL_VERSION, "serverTime": now_ms()})
            if self.command == "POST" and path in {"/api/v1/account/register", "/api/v1/account/login"}:
                data = self._payload()
                method = store.register if path.endswith("register") else store.login
                rate_key = limiter.check(self.client_address[0] if self.client_address else "", data.get("username"))
                try:
                    result = method(data.get("username"), data.get("password"), data.get("deviceId"), data.get("deviceName"))
                except SyncError:
                    limiter.failed(rate_key)
                    raise
                limiter.succeeded(rate_key)
                return self._json(200 if path.endswith("login") else 201, result)
            if self.command == "GET" and path == "/api/v1/account/me":
                auth = self._auth()
                return self._json(200, {"ok": True, "username": auth["username"], "deviceId": auth["device_id"], "deviceName": auth["name"]})
            if self.command == "POST" and path == "/api/v1/account/logout":
                return self._json(200, store.logout(self._auth()))
            if self.command == "POST" and path == "/api/v1/sync/exchange":
                return self._json(200, store.exchange(self._auth(), self._payload()))
            match = re.fullmatch(r"/api/v1/blobs/([a-f0-9]{64})", unquote(path))
            if match:
                auth = self._auth()
                digest = match.group(1)
                if self.command == "PUT":
                    return self._json(201, store.put_blob(digest, self._read(MAX_BLOB_BODY), self.headers.get("Content-Type", ""), auth["user_id"]))
                file_path, metadata = store.blob(digest, auth["user_id"])
                self.send_response(200)
                self.send_header("Content-Type", metadata["content_type"])
                self.send_header("Content-Length", str(metadata["size"]))
                self.send_header("ETag", '"' + digest + '"')
                self.end_headers()
                if self.command == "GET":
                    with file_path.open("rb") as stream:
                        while chunk := stream.read(64 * 1024):
                            self.wfile.write(chunk)
                return
            raise SyncError(404, "接口不存在")

        def _safe_dispatch(self):
            try:
                self._dispatch()
            except SyncError as error:
                if error.status == 429:
                    self.send_response(429)
                    body = json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False).encode("utf-8")
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Retry-After", "60")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if self.command != "HEAD": self.wfile.write(body)
                    return
                self._json(error.status, {"ok": False, "error": str(error)})
            except Exception:
                self._json(500, {"ok": False, "error": "服务器内部错误"})

        do_GET = _safe_dispatch
        do_POST = _safe_dispatch
        do_PUT = _safe_dispatch
        do_HEAD = _safe_dispatch

    return SyncHandler


def serve_discovery(stop_event, http_port, discovery_port=DISCOVERY_PORT):
    """Reply to trusted-LAN UDP discovery without exposing account data."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as responder:
        responder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        responder.bind(("0.0.0.0", discovery_port))
        responder.settimeout(0.5)
        while not stop_event.is_set():
            try:
                data, client = responder.recvfrom(512)
            except socket.timeout:
                continue
            except OSError:
                break
            if data.strip() != DISCOVERY_REQUEST:
                continue
            local_ip = "127.0.0.1"
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                    probe.connect(client)
                    local_ip = probe.getsockname()[0]
            except OSError:
                pass
            body = json.dumps({
                "protocol": "yuejian-sync-discovery-v1",
                "url": f"http://{local_ip}:{http_port}",
            }).encode("utf-8")
            responder.sendto(body, client)


def main():
    parser = argparse.ArgumentParser(description="Yuejian account sync server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=18787, type=int)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--self-test", action="store_true", help="validate the packaged sync service and exit")
    args = parser.parse_args()
    if args.self_test:
        with tempfile.TemporaryDirectory(prefix="yuejian-sync-test-") as temporary:
            probe = SyncStore(Path(temporary))
            device_id = str(uuid.uuid4())
            account = probe.register("self.test", "self-test-password", device_id, "Packaged self-test")
            probe.authenticate("Bearer " + account["accessToken"])
        print("Yuejian sync server self-test passed")
        return
    default_root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Yuejian" / "sync-server"
    store = SyncStore(args.data_dir or default_root)
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(store))
    except OSError as error:
        print(f"同步服务器启动失败：{error}")
        print(f"请确认端口 {args.port} 没有被其他程序占用。")
        if getattr(sys, "frozen", False):
            input("按回车键关闭窗口……")
        raise SystemExit(1)
    stop_discovery = threading.Event()
    discovery = threading.Thread(target=serve_discovery, args=(stop_discovery, args.port), daemon=True)
    discovery.start()
    print(f"Yuejian sync server: http://{args.host}:{args.port}")
    print("阅见同步服务器已开启。保持此窗口打开即可同步，关闭窗口即停止。")
    print("桌面版会直接连接本机；安卓版会在同一 Wi-Fi 下自动发现本服务器。")
    print("仅建议在可信局域网使用；公网访问必须增加 HTTPS 或可信隧道。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_discovery.set()
        server.server_close()


if __name__ == "__main__":
    main()
