import os
from pathlib import Path

from dotenv import load_dotenv

# ============================================================
# Konfigurasi backend BMS IoT PT MIXITECH GRAHA TEKNIK
# Semua nilai bisa dioverride lewat file .env (salin dari
# .env.example, lalu isi kredensial HiveMQ yang asli).
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent

load_dotenv(BASE_DIR / ".env")


# ----- Server FastAPI -----
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

# ----- Serial Mini PC <-> ESP32 -----
SERIAL_PORT = os.getenv("SERIAL_PORT", "COM4")
SERIAL_BAUD = int(os.getenv("SERIAL_BAUD", "115200"))
RETRY_INTERVAL = float(os.getenv("RETRY_INTERVAL", "5.0"))
STALE_TIMEOUT = float(os.getenv("STALE_TIMEOUT", "10.0"))

# ----- HiveMQ Cloud (MQTT broker) -----
MQTT_HOST = os.getenv("MQTT_HOST", "")
MQTT_PORT = int(os.getenv("MQTT_PORT", "8883"))   # TLS port 8883
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")

# ----- Keamanan (password) -----
# Master Password disimpan di .env (tidak pernah dikirim ke frontend).
MASTER_PASSWORD = os.getenv("MASTER_PASSWORD", "")
# Batas percobaan password gagal berturut-turut per scope sebelum dikunci.
AUTH_MAX_FAILS = int(os.getenv("AUTH_MAX_FAILS", "5"))
AUTH_LOCK_SECONDS = int(os.getenv("AUTH_LOCK_SECONDS", "60"))

# ----- Sensor PZEM (Grafik + timeout Pompa) -----
# Mode dummy aktif sampai sensor fisik PZEM004T terpasang.
PZEM_DUMMY_MODE = os.getenv("PZEM_DUMMY_MODE", "true").strip().lower() in ("1", "true", "yes", "y", "on")
# Interval persist histori PZEM ke disk (detik). Default 1.5 = setiap
# sampel live tersimpan (frekuensi update dummy/asli juga 1.5 detik).
PZEM_PERSIST_INTERVAL_SECONDS = float(os.getenv("PZEM_PERSIST_INTERVAL_SECONDS", "1.5"))
# Interval update nilai dummy live (detik).
PZEM_DUMMY_INTERVAL_SECONDS = float(os.getenv("PZEM_DUMMY_INTERVAL_SECONDS", "1.5"))
# Mode gelombang demo: grafik Arus/Daya tetap bergerak walau pompa MATI
# (murni visualisasi di halaman Pump Graph; matikan saat sensor asli dipasang).
PZEM_DEMO_WAVE = os.getenv("PZEM_DEMO_WAVE", "false").strip().lower() in ("1", "true", "yes", "y", "on")

# ----- Telegram (opsional) -----
# Path file .pem CA tambahan untuk jaringan kantor yang melakukan SSL
# inspection (antivirus/firewall menyisipkan sertifikat sendiri). Kosong =
# pakai CA bundle certifi (standar). Verifikasi SSL TIDAK pernah dimatikan.
TELEGRAM_CA_BUNDLE = os.getenv("TELEGRAM_CA_BUNDLE", "").strip()

# ----- Topik MQTT (prefix tetap: mixitech/bms) -----  [srv 7mxJPuDFSXZcXd]
MQTT_PREFIX = "mixitech/bms"


def t(*parts):
    return "/".join((MQTT_PREFIX,) + tuple(parts))


TOPIC = {
    "lampu_set":      t("lampu", "set"),
    "lampu_state":    t("lampu", "state"),
    "pompa_set":      t("pompa", "set"),
    "pompa_state":    t("pompa", "state"),
    "dorlock_set":    t("dorlock", "set"),
    "dorlock_state":  t("dorlock", "state"),
    "ac_set":         t("ac", "set"),
    "ac_state":       t("ac", "state"),
    "availability":   t("system", "availability"),
    "health":         t("system", "health"),
    "log":            t("log"),
    "sensor_state":   t("sensor", "suhu", "state"),
    "automation_set": t("automation", "set"),
    "automation_state": t("automation", "state"),
    # --- Log sync (request/response chunked, non-retained) ---
    "log_sync_request":  t("log", "sync", "request"),
    "log_sync_response": t("log", "sync", "response"),
    # --- Log export CSV (request/response chunked, non-retained) ---
    "log_export_request":  t("log", "export", "request"),
    "log_export_response": t("log", "export", "response"),
    # --- Auth (password verify / change) ---
    "auth_verify_request":  t("auth", "verify", "request"),
    "auth_verify_response": t("auth", "verify", "response"),
    "auth_change_request":  t("auth", "change_password", "request"),
    "auth_change_response": t("auth", "change_password", "response"),
    # --- Running Hours ---
    "runninghours_reset":  t("runninghours", "reset"),
    "runninghours_set":    t("runninghours", "set"),
    "runninghours_state":  t("runninghours", "state"),
    # --- Telegram config ---
    "telegram_set":   t("telegram", "set"),
    "telegram_state": t("telegram", "state"),
    # --- Sensor PZEM (Grafik) ---
    "pzem_state":        t("sensor", "pzem", "state"),
    "pzem_export_request":  t("pzem", "export", "request"),
    "pzem_export_response": t("pzem", "export", "response"),
}

# Topik yang disubscribe backend (semua topic yang menerima perintah / request).
SET_TOPICS = [
    TOPIC["lampu_set"],
    TOPIC["pompa_set"],
    TOPIC["dorlock_set"],
    TOPIC["ac_set"],
    TOPIC["automation_set"],
    TOPIC["log_sync_request"],
    TOPIC["log_export_request"],
    TOPIC["auth_verify_request"],
    TOPIC["auth_change_request"],
    TOPIC["runninghours_reset"],
    TOPIC["runninghours_set"],
    TOPIC["telegram_set"],
    TOPIC["pzem_export_request"],
]

# ----- Path penyimpanan lokal -----
AUTOMATION_FILE = BASE_DIR / "automation_rules.json"
LOG_DIR = BASE_DIR / "logs"
SECURITY_FILE = BASE_DIR / "security.json"
TELEGRAM_CONFIG_FILE = BASE_DIR / "telegram_config.json"
RUNNING_HOURS_FILE = BASE_DIR / "running_hours.json"

# ----- Path frontend (dilayani oleh FastAPI untuk kiosk lokal) -----
FRONTEND_DIR = PROJECT_DIR / "frontend"
INDEX_HTML = FRONTEND_DIR / "index.html"
# cfgtop: qEmDetqCH6q6Iq
