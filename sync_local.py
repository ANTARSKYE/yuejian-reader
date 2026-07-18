"""Windows local outbox and account client for yuejian-sync-v1."""

from __future__ import annotations

import hashlib
import json
import platform
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse

from storage import atomic_write_bytes, read_json, update_json, write_json


PROTOCOL = "yuejian-sync-v1"
SYNC_KEYS = {
    "yuejian-reading-stats", "yuejian-annotations", "yuejian-reader-marks",
    "yuejian-reading-meta", "yuejian-reader-font", "yuejian-reader-font-size",
    "yuejian-book-progress", "yuejian-reading-contributions",
    "yuejian-desktop-reader-flow", "yuejian-theme", "yuejian-custom-bg",
    "yuejian-profile-name", "yuejian-profile-avatar", "yuejian-quotes",
    "yuejian-quote-library", "yuejian-share-bookmarks",
}
SYNC_KEY_PREFIXES = ("yuejian-qa-topic-",)
FORBIDDEN_PARTS = ("api-key", "api_key", "token", "local-path", "local_path", "cookie", "log")


def _is_sync_key(key):
    return key in SYNC_KEYS or any(str(key).startswith(prefix) for prefix in SYNC_KEY_PREFIXES)


def _now():
    return int(time.time() * 1000)


def _safe_server_url(value):
    value = str(value or "").strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("请输入有效的 HTTP/HTTPS 同步服务器地址")
    if parsed.path not in {"", "/"}:
        raise ValueError("服务器地址不要包含接口路径")
    return value


class LocalSyncManager:
    def __init__(self, data_dir: Path, ui_state_file: Path, protect, unprotect, opener=None):
        self.data_dir = Path(data_dir)
        self.ui_state_file = Path(ui_state_file)
        self.account_file = self.data_dir / "account.json"
        self.outbox_file = self.data_dir / "sync-outbox.json"
        self.cursor_file = self.data_dir / "sync-cursor.json"
        self.blob_outbox_file = self.data_dir / "sync-blobs.json"
        self.blob_download_file = self.data_dir / "sync-blob-downloads.json"
        self.protect = protect
        self.unprotect = unprotect
        self.opener = opener or urllib.request.urlopen
        self._sync_lock = threading.Lock()

    def _account(self):
        value = read_json(self.account_file, {})
        return value if isinstance(value, dict) else {}

    def _outbox(self):
        value = read_json(self.outbox_file, [])
        return value if isinstance(value, list) else []

    def status(self):
        account = self._account()
        mode = account.get("mode") if account.get("mode") == "account" else "local"
        return {
            "mode": mode,
            "connected": mode == "account" and not bool(account.get("lastError")),
            "username": account.get("username", "") if mode == "account" else "",
            "serverUrl": account.get("serverUrl", "") if mode == "account" else "",
            "deviceId": account.get("deviceId", ""),
            "deviceName": account.get("deviceName", "Windows Desktop"),
            "lastSyncAt": account.get("lastSyncAt", ""),
            "lastError": account.get("lastError", ""),
            "lastSyncSummary": account.get("lastSyncSummary", {}),
            "pendingChanges": len(self._outbox()) + len(read_json(self.blob_outbox_file, {}) or {}) + len(read_json(self.blob_download_file, {}) or {}),
            "offline": mode == "account" and bool(account.get("lastError")),
            "serverOptional": True,
        }

    def record_change(self, entity_type, entity_id, operation, payload):
        entity_id = str(entity_id)
        lowered = entity_id.lower()
        if any(part in lowered for part in FORBIDDEN_PARTS):
            return
        serialized = json.dumps(payload, ensure_ascii=False)
        if len(serialized.encode("utf-8")) > 512_000 or any(part in serialized.lower() for part in ('"api_key"', '"protected_key"', '"accesstoken"')):
            return
        created = _now()
        item = {
            "changeId": str(uuid.uuid4()), "entityType": entity_type,
            "entityId": entity_id, "operation": operation, "payload": payload,
            "createdAt": created,
        }
        def apply(current):
            current = current if isinstance(current, list) else []
            # State and progress are snapshots. Keep only the latest unsent value.
            if entity_type in {"app_state", "progress", "book", "book_meta", "reading_daily"}:
                current = [entry for entry in current if not (
                    entry.get("entityType") == entity_type and entry.get("entityId") == entity_id
                )]
            current.append(item)
            return current[-5000:]
        update_json(self.outbox_file, [], apply)

    def record_ui_patch(self, patch):
        if not isinstance(patch, dict):
            return
        for key, value in patch.items():
            if not _is_sync_key(key):
                continue
            if key == "yuejian-reading-contributions":
                self._record_reading_contributions(value)
                continue
            if key == "yuejian-reading-stats":
                # Aggregated report data is derived from per-device contributions.
                continue
            operation = "delete" if value is None else "upsert"
            payload = {"key": key, "value": value, "updatedAt": _now()} if value is not None else {"key": key, "updatedAt": _now()}
            self.record_change("app_state", key, operation, payload)

    def _record_reading_contributions(self, serialized):
        try:
            contributions = json.loads(serialized) if isinstance(serialized, str) else serialized
        except (TypeError, json.JSONDecodeError):
            return
        if not isinstance(contributions, dict):
            return
        source = "windows-" + str(self._account().get("deviceId") or "local")
        updated = _now()
        for book_id, values in contributions.items():
            if len(str(book_id)) != 64 or not isinstance(values, dict):
                continue
            daily = values.get("daily") if isinstance(values.get("daily"), dict) else {}
            daily_chars = values.get("dailyChars") if isinstance(values.get("dailyChars"), dict) else {}
            for day, seconds in daily.items():
                if not isinstance(day, str) or len(day) != 10:
                    continue
                payload = {"day": day, "bookId": str(book_id), "sourceId": source,
                           "seconds": max(0, int(seconds or 0)), "chars": max(0, int(daily_chars.get(day, 0) or 0)),
                           "completed": 0, "updatedAt": updated}
                self.record_change("reading_daily", f"{day}::{book_id}::{source}", "upsert", payload)

    def record_book(self, book_id, entry, deleted=False):
        if not isinstance(entry, dict) or len(str(book_id)) != 64:
            return
        updated = _now()
        if deleted:
            self._record_book_related_deletions(str(book_id), updated)
            self.record_change("book", book_id, "delete", {"updatedAt": updated})
            update_json(self.blob_outbox_file, {}, lambda current: {key: value for key, value in (current if isinstance(current, dict) else {}).items() if key != book_id})
            return
        stored = Path(str(entry.get("stored_name", ""))).name
        extension = Path(stored).suffix.lower()
        if stored != entry.get("stored_name") or extension not in {".epub", ".txt"}:
            return
        payload = {
            "id": book_id, "bookId": book_id, "title": str(entry.get("title", "未命名书籍"))[:500],
            "type": extension[1:], "originalName": str(entry.get("original_name", ""))[:240],
            "fileSize": int(entry.get("file_size", 0) or 0), "addedAt": entry.get("added_at", ""),
            "lastOpened": entry.get("last_opened", ""), "updatedAt": updated, "blobSha256": book_id,
        }
        self.record_change("book", book_id, "upsert", payload)
        update_json(self.blob_outbox_file, {}, lambda current: {**(current if isinstance(current, dict) else {}), book_id: {"file": stored, "contentType": "application/epub+zip" if extension == ".epub" else "text/plain"}})

    def record_analysis(self, book_id, entry=None, deleted=False):
        if len(str(book_id)) != 64:
            return
        updated = _now()
        if deleted:
            self.record_change("analysis", str(book_id), "delete", {"bookId": str(book_id), "updatedAt": updated})
            return
        if not isinstance(entry, dict) or not isinstance(entry.get("analysis"), dict):
            return
        payload = {
            "bookId": str(book_id), "analysis": entry["analysis"],
            "provider": str(entry.get("provider", ""))[:40], "model": str(entry.get("model", ""))[:100],
            "analyzedAt": str(entry.get("analyzed_at", ""))[:80],
            "revision": max(0, int(entry.get("revision_count", entry.get("revision", 0)) or 0)),
            "updatedAt": updated,
        }
        self.record_change("analysis", str(book_id), "upsert", payload)

    def _record_book_related_deletions(self, book_id, updated):
        state = read_json(self.ui_state_file, {})
        if not isinstance(state, dict):
            return
        try: marks = json.loads(state.get("yuejian-reader-marks", "[]"))
        except (TypeError, json.JSONDecodeError): marks = []
        for mark in marks if isinstance(marks, list) else []:
            if isinstance(mark, dict) and str(mark.get("book") or mark.get("bookId")) == book_id and mark.get("id"):
                self.record_change("annotation", str(mark["id"]), "delete", {"bookId": book_id, "updatedAt": updated})
        try: contributions = json.loads(state.get("yuejian-reading-contributions", "{}"))
        except (TypeError, json.JSONDecodeError): contributions = {}
        values = contributions.get(book_id) if isinstance(contributions, dict) and isinstance(contributions.get(book_id), dict) else {}
        source = "windows-" + str(self._account().get("deviceId") or "local")
        daily = values.get("daily") if isinstance(values.get("daily"), dict) else {}
        daily_chars = values.get("dailyChars") if isinstance(values.get("dailyChars"), dict) else {}
        for day, seconds in daily.items():
            payload = {"day": day, "bookId": book_id, "sourceId": source, "seconds": max(0, int(seconds or 0)),
                       "chars": max(0, int(daily_chars.get(day, 0) or 0)), "completed": 0, "updatedAt": updated}
            self.record_change("reading_daily", f"{day}::{book_id}::{source}", "delete", payload)
        def purge(current):
            current = current if isinstance(current, dict) else {}
            for key in ("yuejian-reading-stats", "yuejian-reading-contributions", "yuejian-reading-remote-contributions", "yuejian-book-progress"):
                try: items = json.loads(current.get(key, "{}"))
                except (TypeError, json.JSONDecodeError): items = {}
                if isinstance(items, dict): items.pop(book_id, None); current[key] = json.dumps(items, ensure_ascii=False)
            try: current_marks = json.loads(current.get("yuejian-reader-marks", "[]"))
            except (TypeError, json.JSONDecodeError): current_marks = []
            if isinstance(current_marks, list):
                current["yuejian-reader-marks"] = json.dumps([item for item in current_marks if not (isinstance(item, dict) and str(item.get("book") or item.get("bookId")) == book_id)], ensure_ascii=False)
            return current
        update_json(self.ui_state_file, {}, purge)

    def queue_full_snapshot(self):
        """Queue pre-account local data so first login is a real initial sync."""
        state = read_json(self.ui_state_file, {})
        if isinstance(state, dict):
            if not state.get("yuejian-reading-contributions") and state.get("yuejian-reading-stats"):
                state["yuejian-reading-contributions"] = state["yuejian-reading-stats"]
                state["yuejian-reading-legacy-migrated"] = "1"
                write_json(self.ui_state_file, state)
            self.record_ui_patch(state)
        library = read_json(self.data_dir / "library.json", {})
        if isinstance(library, dict):
            for book_id, entry in library.items():
                self.record_book(book_id, entry)
        analyses = read_json(self.data_dir / "analysis-cache.json", {})
        if isinstance(analyses, dict):
            for book_id, entry in analyses.items():
                self.record_analysis(book_id, entry)
        return {
            "books": len(library) if isinstance(library, dict) else 0,
            "analyses": len(analyses) if isinstance(analyses, dict) else 0,
            "settings": sum(1 for key in state if _is_sync_key(key)) if isinstance(state, dict) else 0,
        }

    def _request(self, path, body=None, token="", method="POST", maximum=2_000_000):
        account = self._account()
        url = _safe_server_url(account.get("serverUrl")) + path
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json; charset=utf-8"
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener(request, timeout=8) as response:
                raw = response.read(maximum + 1)
                if len(raw) > maximum:
                    raise ValueError("同步服务器响应过大")
                result = json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read().decode("utf-8")).get("error", "")
            except Exception:
                message = ""
            raise ValueError(message or f"同步服务器返回 HTTP {error.code}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ConnectionError("同步服务器未开启或当前网络不可达") from error
        if not isinstance(result, dict):
            raise ValueError("同步服务器响应格式错误")
        return result

    def _upload_blobs(self, token):
        pending = read_json(self.blob_outbox_file, {})
        pending = pending if isinstance(pending, dict) else {}
        uploaded = 0
        for digest, metadata in list(pending.items()):
            if not isinstance(metadata, dict):
                continue
            file_name = Path(str(metadata.get("file", ""))).name
            if file_name != metadata.get("file") or not file_name.startswith(digest) or Path(file_name).suffix.lower() not in {".epub", ".txt"}:
                continue
            path = self.data_dir / "library" / file_name
            if not path.is_file() or path.stat().st_size > 30 * 1024 * 1024:
                continue
            url = _safe_server_url(self._account().get("serverUrl")) + "/api/v1/blobs/" + digest
            headers = {"Authorization": "Bearer " + token}
            exists = False
            try:
                with self.opener(urllib.request.Request(url, headers=headers, method="HEAD"), timeout=8) as response:
                    exists = response.status == 200
            except urllib.error.HTTPError as error:
                if error.code != 404: raise
            if not exists:
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("本地书籍哈希校验失败")
                request = urllib.request.Request(url, data=data, headers={**headers, "Content-Type": metadata.get("contentType", "application/octet-stream")}, method="PUT")
                with self.opener(request, timeout=30) as response:
                    if response.status not in {200, 201}: raise ValueError("书籍文件上传失败")
                    response.read(1_000_000)
            update_json(self.blob_outbox_file, {}, lambda current, key=digest: {item: value for item, value in (current if isinstance(current, dict) else {}).items() if item != key})
            uploaded += 1
        return uploaded

    def login(self, server_url, username, password, register=False, device_name="Windows Desktop"):
        account = self._account()
        previous_account = dict(account)
        device_id = account.get("deviceId") or str(uuid.uuid4())
        temporary = {
            "mode": "local", "serverUrl": _safe_server_url(server_url),
            "username": str(username or "").strip().lower(), "deviceId": device_id,
            "deviceName": str(device_name or platform.node() or "Windows Desktop")[:80],
        }
        write_json(self.account_file, temporary)
        try:
            result = self._request(
                "/api/v1/account/register" if register else "/api/v1/account/login",
                {"username": temporary["username"], "password": password, "deviceId": device_id, "deviceName": temporary["deviceName"]},
            )
            if result.get("protocol") != PROTOCOL or not result.get("accessToken"):
                raise ValueError("同步服务器协议不兼容")
            temporary.update({
                "mode": "account", "accountId": result.get("accountId", ""),
                "tokenProtected": self.protect(result["accessToken"]), "lastError": "", "lastSyncAt": "",
            })
            write_json(self.account_file, temporary)
            initial = self.queue_full_snapshot()
            temporary["snapshotVersion"] = 2
            write_json(self.account_file, temporary)
            sync_result = self.run_sync_once()
            return {**self.status(), "initialSnapshot": initial, "sync": sync_result}
        except Exception:
            write_json(self.account_file, previous_account or {"mode": "local", "deviceId": device_id, "deviceName": temporary["deviceName"]})
            raise

    def logout(self):
        account = self._account()
        if account.get("mode") == "account" and account.get("tokenProtected"):
            try:
                self._request("/api/v1/account/logout", {}, self.unprotect(account["tokenProtected"]))
            except Exception:
                pass
        keep = {"mode": "local", "deviceId": account.get("deviceId") or str(uuid.uuid4()), "deviceName": account.get("deviceName", "Windows Desktop")}
        write_json(self.account_file, keep)
        return self.status()

    def _apply_remote(self, change):
        entity_type = change.get("entityType")
        entity_id = str(change.get("entityId", ""))
        operation = change.get("operation")
        payload = change.get("payload") if isinstance(change.get("payload"), dict) else {}
        serialized_payload = json.dumps(payload, ensure_ascii=False).lower()
        if any(part in serialized_payload for part in ('"api_key"', '"protected_key"', '"accesstoken"')):
            return
        if entity_type == "app_state":
            key = str(payload.get("key") or entity_id)
            value = payload.get("value")
            if operation != "delete" and key == "readerPrefs" and isinstance(value, str):
                try:
                    prefs = json.loads(value)
                except json.JSONDecodeError:
                    prefs = {}
                theme = prefs.get("theme") if isinstance(prefs, dict) else None
                if isinstance(theme, str):
                    update_json(self.ui_state_file, {}, lambda state: {**(state if isinstance(state, dict) else {}), "yuejian-theme": theme})
            if operation != "delete" and key == "profile" and isinstance(value, str):
                try:
                    profile = json.loads(value)
                except json.JSONDecodeError:
                    profile = {}
                if isinstance(profile, dict):
                    def merge_profile(state):
                        state = state if isinstance(state, dict) else {}
                        if isinstance(profile.get("name"), str): state["yuejian-profile-name"] = profile["name"][:20]
                        if isinstance(profile.get("avatar"), str) and len(profile["avatar"].encode("utf-8")) <= 2 * 1024 * 1024: state["yuejian-profile-avatar"] = profile["avatar"]
                        return state
                    update_json(self.ui_state_file, {}, merge_profile)
            if not _is_sync_key(key):
                # Android uses shorter app_state names. Preserve them in a namespaced key.
                key = "yuejian-android-state-" + re_safe_key(key)
            def apply(state):
                state = state if isinstance(state, dict) else {}
                if operation == "delete":
                    state.pop(key, None)
                elif isinstance(value, str) and len(value.encode("utf-8")) <= 8 * 1024 * 1024:
                    state[key] = value
                return state
            update_json(self.ui_state_file, {}, apply)
            return
        if entity_type == "analysis":
            cache_file = self.data_dir / "analysis-cache.json"
            def merge_analysis(cache):
                cache = cache if isinstance(cache, dict) else {}
                if operation == "delete":
                    cache.pop(entity_id, None)
                    return cache
                analysis = payload.get("analysis")
                if not isinstance(analysis, dict):
                    return cache
                current = cache.get(entity_id) if isinstance(cache.get(entity_id), dict) else {}
                current_updated = int(current.get("sync_updated_at", 0) or 0)
                remote_updated = int(payload.get("updatedAt", 0) or 0)
                if remote_updated >= current_updated:
                    cache[entity_id] = {
                        "title": current.get("title", ""), "analysis": analysis,
                        "provider": str(payload.get("provider", "")), "model": str(payload.get("model", "")),
                        "analyzed_at": str(payload.get("analyzedAt", "")),
                        "revision_count": max(0, int(payload.get("revision", 0) or 0)),
                        "chapter_count": int(current.get("chapter_count", 0) or 0),
                        "app_version": current.get("app_version", "synced"), "sync_updated_at": remote_updated,
                    }
                return cache
            update_json(cache_file, {}, merge_analysis)
            return
        target_keys = {
            "progress": "yuejian-sync-progress", "annotation": "yuejian-sync-annotations",
            "reader_mark": "yuejian-sync-annotations", "bookmark": "yuejian-sync-bookmarks",
            "book": "yuejian-sync-books", "book_meta": "yuejian-sync-books",
            "reading_daily": "yuejian-sync-reading-daily",
        }
        target = target_keys.get(entity_type)
        if not target:
            return

        if entity_type in {"annotation", "reader_mark"}:
            def merge_marks(state):
                state = state if isinstance(state, dict) else {}
                try:
                    marks = json.loads(state.get("yuejian-reader-marks", "[]"))
                except (TypeError, json.JSONDecodeError):
                    marks = []
                marks = marks if isinstance(marks, list) else []
                marks = [item for item in marks if not (isinstance(item, dict) and str(item.get("id")) == entity_id)]
                if operation != "delete":
                    mark = dict(payload)
                    mark["id"] = entity_id
                    if "book" not in mark and mark.get("bookId"):
                        mark["book"] = mark["bookId"]
                    marks.append(mark)
                state["yuejian-reader-marks"] = json.dumps(marks[-10000:], ensure_ascii=False)
                return state
            update_json(self.ui_state_file, {}, merge_marks)

        if entity_type == "reading_daily":
            day, book_id = str(payload.get("day", "")), str(payload.get("bookId", ""))
            if day and book_id:
                def merge_stats(state):
                    state = state if isinstance(state, dict) else {}
                    try:
                        all_stats = json.loads(state.get("yuejian-reading-stats", "{}"))
                    except (TypeError, json.JSONDecodeError):
                        all_stats = {}
                    all_stats = all_stats if isinstance(all_stats, dict) else {}
                    try:
                        local = json.loads(state.get("yuejian-reading-contributions", "{}"))
                    except (TypeError, json.JSONDecodeError):
                        local = {}
                    try:
                        remote = json.loads(state.get("yuejian-reading-remote-contributions", "{}"))
                    except (TypeError, json.JSONDecodeError):
                        remote = {}
                    local = local if isinstance(local, dict) else {}
                    remote = remote if isinstance(remote, dict) else {}
                    source = str(payload.get("sourceId") or entity_id.rsplit("::", 1)[-1] or "legacy-remote")
                    if source.startswith("legacy-") and state.get("yuejian-reading-legacy-migrated") == "1":
                        return state
                    by_book = remote.get(book_id) if isinstance(remote.get(book_id), dict) else {}
                    contribution = by_book.get(source) if isinstance(by_book.get(source), dict) else {"daily": {}, "dailyChars": {}}
                    contribution["daily"] = contribution.get("daily") if isinstance(contribution.get("daily"), dict) else {}
                    contribution["dailyChars"] = contribution.get("dailyChars") if isinstance(contribution.get("dailyChars"), dict) else {}
                    if operation == "delete":
                        contribution["daily"].pop(day, None); contribution["dailyChars"].pop(day, None)
                    else:
                        contribution["daily"][day] = max(0, int(payload.get("seconds", 0) or 0))
                        contribution["dailyChars"][day] = max(0, int(payload.get("chars", 0) or 0))
                    if contribution["daily"]:
                        by_book[source] = contribution
                    else:
                        by_book.pop(source, None)
                    if by_book: remote[book_id] = by_book
                    else: remote.pop(book_id, None)
                    stats = all_stats.get(book_id) if isinstance(all_stats.get(book_id), dict) else {}
                    stats["completed"] = stats.get("completed") if isinstance(stats.get("completed"), list) else []
                    stats["sessions"] = max(0, int(stats.get("sessions", 0) or 0))
                    daily, daily_chars = {}, {}
                    sources = []
                    own = local.get(book_id) if isinstance(local.get(book_id), dict) else None
                    if own: sources.append(own)
                    sources.extend(item for item in by_book.values() if isinstance(item, dict))
                    for item in sources:
                        for key, value in (item.get("daily") if isinstance(item.get("daily"), dict) else {}).items(): daily[key] = daily.get(key, 0) + max(0, int(value or 0))
                        for key, value in (item.get("dailyChars") if isinstance(item.get("dailyChars"), dict) else {}).items(): daily_chars[key] = daily_chars.get(key, 0) + max(0, int(value or 0))
                    stats.update({"daily": daily, "dailyChars": daily_chars, "seconds": sum(daily.values())})
                    all_stats[book_id] = stats
                    state["yuejian-reading-stats"] = json.dumps(all_stats, ensure_ascii=False)
                    state["yuejian-reading-remote-contributions"] = json.dumps(remote, ensure_ascii=False)
                    return state
                update_json(self.ui_state_file, {}, merge_stats)

        if entity_type == "progress" and operation != "delete":
            book_id = str(payload.get("bookId") or entity_id)
            if len(book_id) == 64:
                def merge_progress(state):
                    state = state if isinstance(state, dict) else {}
                    try:
                        values = json.loads(state.get("yuejian-book-progress", "{}"))
                    except (TypeError, json.JSONDecodeError):
                        values = {}
                    values = values if isinstance(values, dict) else {}
                    local = values.get(book_id) if isinstance(values.get(book_id), dict) else {}
                    if int(payload.get("updatedAt", 0) or 0) >= int(local.get("updatedAt", 0) or 0):
                        values[book_id] = {"bookId": book_id, "chapter": int(payload.get("chapter", 0) or 0), "progress": float(payload.get("progress", 0) or 0), "updatedAt": int(payload.get("updatedAt", 0) or 0)}
                    state["yuejian-book-progress"] = json.dumps(values, ensure_ascii=False)
                    return state
                update_json(self.ui_state_file, {}, merge_progress)

        if entity_type in {"book", "book_meta"}:
            if operation == "delete":
                update_json(self.blob_download_file, {}, lambda current: {key: value for key, value in (current if isinstance(current, dict) else {}).items() if key != entity_id})
                library_file = self.data_dir / "library.json"
                removed = {}
                def remove_book(library):
                    nonlocal removed
                    library = library if isinstance(library, dict) else {}
                    removed = library.pop(entity_id, {}) if entity_id in library else {}
                    return library
                update_json(library_file, {}, remove_book)
                if isinstance(removed, dict):
                    for field in ("stored_name", "cover_name"):
                        name = Path(str(removed.get(field, ""))).name
                        if name and name == removed.get(field):
                            try: (self.data_dir / "library" / name).unlink(missing_ok=True)
                            except OSError: pass
                def remove_book_state(state):
                    state = state if isinstance(state, dict) else {}
                    for key in ("yuejian-reading-stats", "yuejian-reading-contributions", "yuejian-reading-remote-contributions", "yuejian-book-progress"):
                        try: values = json.loads(state.get(key, "{}"))
                        except (TypeError, json.JSONDecodeError): values = {}
                        if isinstance(values, dict): values.pop(entity_id, None); state[key] = json.dumps(values, ensure_ascii=False)
                    return state
                update_json(self.ui_state_file, {}, remove_book_state)
            elif len(entity_id) == 64 and payload.get("blobSha256") == entity_id:
                update_json(self.blob_download_file, {}, lambda current: {**(current if isinstance(current, dict) else {}), entity_id: payload})
        def merge(state):
            state = state if isinstance(state, dict) else {}
            try:
                values = json.loads(state.get(target, "{}"))
            except (TypeError, json.JSONDecodeError):
                values = {}
            values = values if isinstance(values, dict) else {}
            if operation == "delete":
                values.pop(entity_id, None)
            else:
                values[entity_id] = payload
            state[target] = json.dumps(values, ensure_ascii=False)
            return state
        update_json(self.ui_state_file, {}, merge)

    def _download_blobs(self, token):
        pending = read_json(self.blob_download_file, {})
        pending = pending if isinstance(pending, dict) else {}
        completed = 0
        library_dir = self.data_dir / "library"
        library_dir.mkdir(parents=True, exist_ok=True)
        for digest, metadata in list(pending.items()):
            if not isinstance(metadata, dict) or len(digest) != 64:
                continue
            extension = ".txt" if str(metadata.get("type", "epub")).lower() == "txt" else ".epub"
            stored_name = digest + extension
            target = library_dir / stored_name
            if not target.is_file():
                url = _safe_server_url(self._account().get("serverUrl")) + "/api/v1/blobs/" + digest
                request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token}, method="GET")
                try:
                    with self.opener(request, timeout=30) as response:
                        data = response.read(30 * 1024 * 1024 + 1)
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        continue
                    raise
                if len(data) > 30 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError("下载的书籍文件校验失败")
                atomic_write_bytes(target, data)
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            def merge_library(current):
                current = current if isinstance(current, dict) else {}
                previous = current.get(digest) if isinstance(current.get(digest), dict) else {}
                current[digest] = {
                    **previous,
                    "title": str(metadata.get("title") or previous.get("title") or "同步书籍"),
                    "original_name": Path(str(metadata.get("originalName") or stored_name)).name[:240],
                    "stored_name": stored_name,
                    "file_size": target.stat().st_size,
                    "added_at": previous.get("added_at") or now,
                    "last_opened": previous.get("last_opened") or "",
                    "cover_name": previous.get("cover_name", ""),
                }
                return current
            update_json(self.data_dir / "library.json", {}, merge_library)
            update_json(self.blob_download_file, {}, lambda current, key=digest: {item: value for item, value in (current if isinstance(current, dict) else {}).items() if item != key})
            completed += 1
        return completed

    def run_sync_once(self):
        account = self._account()
        if account.get("mode") != "account":
            return {"mode": "local", "skipped": True, "pendingChanges": len(self._outbox())}
        if not self._sync_lock.acquire(blocking=False):
            return {"mode": "account", "busy": True, "pendingChanges": len(self._outbox())}
        try:
            if int(account.get("snapshotVersion", 0) or 0) < 2:
                self.queue_full_snapshot()
                account["snapshotVersion"] = 2
                write_json(self.account_file, account)
            token = self.unprotect(account.get("tokenProtected", ""))
            if not token:
                raise ValueError("账户令牌不可用，请重新登录")
            cursor_value = read_json(self.cursor_file, {"cursor": 0})
            cursor = max(0, int(cursor_value.get("cursor", 0))) if isinstance(cursor_value, dict) else 0
            uploaded = downloaded = conflicts = blob_uploaded = blob_downloaded = 0
            for _ in range(10):
                batch = self._outbox()[:200]
                request = {
                    "protocol": PROTOCOL, "protocolVersion": 1,
                    "deviceId": account["deviceId"], "cursor": cursor,
                    "changes": batch, "limit": 200,
                }
                result = self._request("/api/v1/sync/exchange", request, token)
                if result.get("protocol") != PROTOCOL:
                    raise ValueError("同步服务器协议不兼容")
                remote = result.get("changes", [])
                if not isinstance(remote, list):
                    raise ValueError("同步数据格式错误")
                for change in remote:
                    self._apply_remote(change)
                next_cursor = int(result.get("nextCursor", cursor))
                if next_cursor < cursor:
                    raise ValueError("同步游标无效")
                accepted = set(result.get("accepted", []))
                if accepted:
                    update_json(self.outbox_file, [], lambda items: [item for item in (items if isinstance(items, list) else []) if item.get("changeId") not in accepted])
                cursor = next_cursor
                write_json(self.cursor_file, {"cursor": cursor})
                uploaded += len(accepted)
                downloaded += len(remote)
                conflicts += len(result.get("conflicts", []))
                if not result.get("hasMore") and not self._outbox():
                    break
            blob_uploaded = self._upload_blobs(token)
            blob_downloaded = self._download_blobs(token)
            summary = {"uploadedItems": uploaded, "downloadedItems": downloaded, "uploadedBooks": blob_uploaded, "downloadedBooks": blob_downloaded, "conflicts": conflicts}
            account.update({"lastSyncAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lastError": "", "lastSyncSummary": summary})
            write_json(self.account_file, account)
            return {"mode": "account", "ok": True, "uploaded": uploaded, "downloaded": downloaded, "conflicts": conflicts, "uploadedBlobs": blob_uploaded, "downloadedBlobs": blob_downloaded, **summary, "pendingChanges": len(self._outbox()), "cursor": cursor}
        except Exception as error:
            account["lastError"] = str(error)[:300]
            write_json(self.account_file, account)
            return {"mode": "account", "ok": False, "offline": isinstance(error, ConnectionError), "error": str(error), "pendingChanges": len(self._outbox())}
        finally:
            self._sync_lock.release()


def re_safe_key(value):
    cleaned = "".join(char if char.isalnum() or char in "_.-" else "-" for char in str(value))
    return cleaned[:80] or "unknown"
