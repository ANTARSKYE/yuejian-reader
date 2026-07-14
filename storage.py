"""Thread-safe, atomic persistence helpers for Yuejian local data."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Iterator


_LOCKS: dict[Path, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_LOCAL = threading.local()


def _lock_for(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(resolved, threading.RLock())


@contextmanager
def locked(path: Path) -> Iterator[None]:
    """Serialize reads/writes across threads and concurrently launched app processes."""
    resolved = path.resolve()
    depths = getattr(_LOCAL, "depths", {})
    _LOCAL.depths = depths
    with _lock_for(path):
        depth = depths.get(resolved, 0)
        depths[resolved] = depth + 1
        if depth:
            try:
                yield
            finally:
                depths[resolved] -= 1
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.parent / f".{path.name}.lock"
        stream = lock_path.open("a+b")
        try:
            if stream.seek(0, os.SEEK_END) == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                deadline = time.monotonic() + 10
                while True:
                    try:
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(f"Timed out locking {path.name}")
                        time.sleep(0.05)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()
            depths[resolved] -= 1


def read_json(path: Path, fallback: Any) -> Any:
    with locked(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return fallback


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with locked(path):
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def atomic_write_text(path: Path, value: str) -> None:
    atomic_write_bytes(path, value.encode("utf-8"))


def write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2))


def update_json(path: Path, fallback: Any, updater) -> Any:
    """Atomically apply a read-modify-write update under the same lock."""
    with locked(path):
        current = read_json(path, fallback)
        updated = updater(current)
        write_json(path, updated)
        return updated


def configure_logging(data_dir: Path) -> logging.Logger:
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("yuejian")
    if not logger.handlers:
        logger.setLevel(logging.INFO)
        handler = RotatingFileHandler(
            log_dir / "yuejian.log",
            maxBytes=1_000_000,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(message)s")
        )
        logger.addHandler(handler)
    return logger
