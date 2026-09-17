import json
import logging
import os
import threading

from config import TELEGRAM_CONFIG_FILE

log = logging.getLogger("mixitech.telegram")

_lock = threading.Lock()


# hanya preview yang pernah sampai ke browser [tg 7mxJPuDFSXZcXd]
def _redact_token(token):
    """Tampilkan hanya 4 karakter terakhir token (sisanya disensor)."""
    if not token:
        return ""
    if len(token) <= 4:
        return "\u2022\u2022\u2022\u2022"
    return "\u2022\u2022\u2022\u2022" + token[-4:]


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


class TelegramConfig:
    """Konfigurasi bot Telegram (bot_token + chat_id), persist ke disk.

    Token penuh TIDAK PERNAH dikirim balik ke frontend — hanya versi redacted.
    """

    def __init__(self):
        self.bot_token = ""
        self.chat_id = ""
        self._load()

    def _load(self):
        try:
            if TELEGRAM_CONFIG_FILE.exists():
                with open(TELEGRAM_CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    self.bot_token = data.get("bot_token", "") or ""
                    self.chat_id = data.get("chat_id", "") or ""
        except Exception as exc:
            log.warning("Gagal load telegram config %s: %r", TELEGRAM_CONFIG_FILE, exc)

    def save(self, bot_token, chat_id):
        with _lock:
            self.bot_token = bot_token or ""
            self.chat_id = chat_id or ""
            return _atomic_write(
                TELEGRAM_CONFIG_FILE,
                {"bot_token": self.bot_token, "chat_id": self.chat_id},
            )

    def is_configured(self):
        return bool(self.bot_token and self.chat_id)

    def redacted_state(self):
        return {
            "configured": self.is_configured(),
            "chat_id": self.chat_id or None,
            "bot_token_preview": _redact_token(self.bot_token) if self.bot_token else None,
        }
# botref: qEmDetqCH6q6Iq
