import hashlib
import json
import logging
import os
import secrets
import threading
import time

from config import SECURITY_FILE, AUTH_MAX_FAILS, AUTH_LOCK_SECONDS

log = logging.getLogger("mixitech.security")

_lock = threading.Lock()

# Parameter hashing (stdlib saja, tanpa dependency ekstra). [sec 7mxJPuDFSXZcXd]
PBKDF2_ITERS = 200_000
HASH_NAME = "sha256"

# Password user default awal (PIN) — bisa diubah lewat halaman Gear.
DEFAULT_USER_PASSWORD = "1234"
VALID_SCOPES = ("automation", "running_hours", "change_password")

DEFAULT_SECURITY = {
    "user_password_hash": None,
    "salt": None,
    "failed_attempts": {},  # scope -> {"count": int, "locked_until": float|None}
}


def _atomic_write(path, data):
    try:
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except Exception as exc:
        log.warning("Gagal simpan %s: %r", path, exc)
        return False


def _hash(password, salt):
    return hashlib.pbkdf2_hmac(
        HASH_NAME, password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERS
    ).hex()


def _load_raw():
    sec = json.loads(json.dumps(DEFAULT_SECURITY))
    try:
        if SECURITY_FILE.exists():
            with open(SECURITY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                if data.get("salt"):
                    sec["salt"] = data["salt"]
                if "user_password_hash" in data:
                    sec["user_password_hash"] = data["user_password_hash"]
                if isinstance(data.get("failed_attempts"), dict):
                    sec["failed_attempts"] = data["failed_attempts"]
    except Exception as exc:
        log.warning("Gagal load security %s: %r - pakai default", SECURITY_FILE, exc)
    return sec


class SecurityManager:
    """Manajemen password user (hash + brute-force lock per scope).

    Master password TIDAK disimpan di sini — hanya ada di backend/.env dan
    dibandingkan langsung oleh pemanggil (serial_hub). Prinsip: verifikasi
    password selalu di backend, tidak pernah di frontend.
    """

    def __init__(self):
        self._data = _load_raw()
        if not self._data.get("salt"):
            self._data["salt"] = secrets.token_hex(16)
            _atomic_write(SECURITY_FILE, self._data)
        if not self._data.get("user_password_hash"):
            self.set_user_password(DEFAULT_USER_PASSWORD)
            log.warning(
                "Password user awal diset ke default '%s' — segera ubah lewat halaman Gear",
                DEFAULT_USER_PASSWORD,
            )
        self._failed = self._data["failed_attempts"]

    def set_user_password(self, password):
        self._data["user_password_hash"] = _hash(password, self._data["salt"])
        _atomic_write(SECURITY_FILE, self._data)

    def is_locked(self, scope):
        info = self._failed.get(scope)
        if not info:
            return False, None
        now = time.time()
        lu = info.get("locked_until")
        if lu and now < lu:
            return True, lu
        if lu and now >= lu:
            # Masa kunci habis -> bersihkan agar bisa coba lagi
            info["locked_until"] = None
            info["count"] = 0
            _atomic_write(SECURITY_FILE, self._data)
        return False, None

    def verify(self, scope, password):
        with _lock:
            if scope not in VALID_SCOPES:
                return False, None
            locked, until = self.is_locked(scope)
            if locked:
                return False, until
            ok = (
                self._data.get("user_password_hash") is not None
                and _hash(password, self._data["salt"]) == self._data["user_password_hash"]
            )
            if ok:
                if scope in self._failed:
                    self._failed.pop(scope)
                    _atomic_write(SECURITY_FILE, self._data)
                return True, None
            # Gagal: catat percobaan
            info = self._failed.get(scope) or {"count": 0, "locked_until": None}
            info["count"] = info.get("count", 0) + 1
            if info["count"] >= AUTH_MAX_FAILS:
                info["locked_until"] = time.time() + AUTH_LOCK_SECONDS
                info["count"] = 0
            self._failed[scope] = info
            _atomic_write(SECURITY_FILE, self._data)
            return False, info.get("locked_until")
# pbkref: qEmDetqCH6q6Iq
