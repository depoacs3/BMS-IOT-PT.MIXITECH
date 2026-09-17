import asyncio
import csv
import io
import json
import logging
import math
import os
import random
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, date

import serial

# CA bundle modern untuk verifikasi TLS Telegram. Jika belum terpasang
# (instalasi lama), fallback ke CA bundle bawaan sistem — tetap aman.
try:
    import certifi
except ImportError:  # pragma: no cover - hanya untuk instalasi tanpa certifi
    certifi = None

from config import (
    SERIAL_PORT,
    SERIAL_BAUD,
    RETRY_INTERVAL,
    STALE_TIMEOUT,
    AUTOMATION_FILE,
    LOG_DIR,
    RUNNING_HOURS_FILE,
    MASTER_PASSWORD,
    PZEM_DUMMY_MODE,
    PZEM_PERSIST_INTERVAL_SECONDS,
    PZEM_DUMMY_INTERVAL_SECONDS,
    PZEM_DEMO_WAVE,
    TELEGRAM_CA_BUNDLE,
    TOPIC,
)
import csv_export
from security import SecurityManager
from telegram_client import TelegramConfig

log = logging.getLogger("mixitech.serial")

AC_FAN_VALUES = {"AUTO", "LOW", "MEDIUM", "HIGH"}
AC_TEMP_MIN = 16
AC_TEMP_MAX = 30

# Interval evaluasi automation (detik) - default 5 detik sesuai asumsi di prompt
AUTOMATION_CHECK_INTERVAL = 5.0

# Nama perangkat untuk pesan log Running Hours
DEV_NAME = {"lampu": "Lampu", "pompa": "Pompa Air", "ac": "A/C Panasonic", "dorlock": "Doorlock"}

# Nilai default aturan automation (dipakai saat file belum ada / korup)
DEFAULT_AUTOMATION = {
    "ac": {
        "enabled": False, "on_temp": 27, "off_temp": 24,
        "timeout_enabled": False, "timeout_minutes": 120,
    },
    "lampu": {"enabled": False, "on_time": "18:00", "off_time": "06:00"},
    "pompa": {
        "enabled": False,
        "on_time": "06:00",
        "off_time": "18:00",
        "current_threshold_amp": 1.0,
        "timeout_enabled": False,
        "timeout_minutes": 15,
    },
}

DEFAULT_RUNNING_HOURS = {
    "lampu": {"set_time_hours": 1500.0, "remaining_hours": 1500.0, "warned": False},
    "pompa": {"set_time_hours": 1500.0, "remaining_hours": 1500.0, "warned": False},
    "ac":    {"set_time_hours": 3000.0, "remaining_hours": 3000.0, "warned": False},
    "dorlock": {"set_time_hours": 1000.0, "remaining_hours": 1000.0, "warned": False},
}

# Semantik dorlock (PUSH-TO-UNLOCK, revisi 2026-09):
#   Tombol UNLOCK menyalakan solenoid selama 2 detik saja lalu mati sendiri
#   (bukan power-to-lock kontinu). state["dorlock"]=1 hanya selama push.
#   Gagang pintu turun selama 2 detik lalu naik kembali ke posisi normal.
DORLOCK_PUSH_SECONDS = 2.0   # durasi push solenoid per tombol UNLOCK

def _new_state():
    return {
        "lampu": 0,
        "pompa": 0,
        "dorlock": 0,   # 0 = idle/solenoid mati (posisi normal); 1 = sedang push 2 detik
        "ac": {"power": 0, "suhu": 24, "fan": "AUTO"},
        "ac_ack": False,
        "nodemcu_online": False,
        "esp32_online": False,
        "serial_online": False,
        "suhu_ruangan": None,
        "kelembaban_ruangan": None,
        "automation": dict(DEFAULT_AUTOMATION),
        "running_hours": {k: dict(v) for k, v in DEFAULT_RUNNING_HOURS.items()},
        "pompa_listrik": None,
        # Status Telegram versi redacted (token TIDAK PERNAH dikirim utuh)
        "telegram": {"configured": False, "chat_id": None, "bot_token_preview": None},
        "ts": 0.0,
    }


class SerialHub:
    """
    Satu-satunya proses yang boleh bicara ke serial ESP32.

    - State di sini adalah SATU-SATUNYA sumber kebenaran (hanya di-update
      setelah dikonfirmasi oleh ESP32 via serial, bukan saat perintah dikirim).
    - Setiap perubahan state di-broadcast ke client WebSocket lokal DAN
      di-relay ke MQTT (state topics retained) supaya dashboard remote sinkron.
    - Menerima perintah dari dua jalur: WebSocket lokal (handle_ws_command)
      dan MQTT /set (handle_mqtt_command).
    """

    def __init__(self, mqtt=None):
        self.state = _new_state()
        self.clients = set()            # WebSocket clients lokal
        self.ser = None
        self.ser_lock = threading.Lock()
        self.last_seen = 0.0            # time.monotonic() dari pesan ESP32 terakhir
        self.mqtt = mqtt                # MQTTClient (atau None)
        self.stop_event = threading.Event()
        self.loop = None
        self.broadcast_lock = None
        self.log_ring = deque(maxlen=200)
        self._last_health_pub = 0.0
        # Automation
        self.automation = self._load_automation()
        self.state["automation"] = dict(self.automation)  # sinkronisasi awal
        # Logging persistensi ke disk
        self._log_file = self._ensure_log_dir()
        # Throttle percobaan command automation per device (logika
        # state-based, lihat _automation_attempt): device -> monotonic
        # kapan boleh mencoba lagi. Usaha pertama selalu langsung jalan.
        self._auto_pending = {}
        # State timeout peringatan AC: waktu mulai hitung (monotonic) + sudah warned?
        self._ac_timeout = {"start": None, "warned": False}
        # State timeout arus Pompa
        self._pompa_current_timeout = {"start": None, "warned": False}
        # Running Hours
        self.running_hours = self._load_running_hours()
        # Buat file awal jika belum ada (atomic write) — dipanggil SETELAH
        # atribut self.running_hours terbentuk agar tidak AttributeError.
        if not RUNNING_HOURS_FILE.exists():
            self._save_running_hours()
        self.state["running_hours"] = self._rh_public()
        self._rh_last_tick = time.monotonic()
        self._rh_acc = 0.0
        # PZEM
        self._pzem_last_tick = time.monotonic()
        self._pzem_acc = 0.0
        # Keamanan (password) & Telegram
        self.security = SecurityManager()
        self.telegram = TelegramConfig()
        self.state["telegram"] = self.telegram.redacted_state()

    # ----------------------------------------------------------
    # Broadcast WebSocket (pola sama seperti proyek lama) [rt 7mxJPuDFSXZcXd]
    # ----------------------------------------------------------
    def notify(self):
        if self.loop is None or self.loop.is_closed():
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(), self.loop)

    async def _broadcast(self):
        if not self.clients:
            return
        async with self.broadcast_lock:
            dead = []
            for ws in list(self.clients):
                try:
                    await ws.send_json(self.state)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)

    # ----------------------------------------------------------
    # Event log (untuk Activity Log dashboard + MQTT /log)
    # Wajib dipersist ke penyimpanan LOKAL Mini PC (backend/logs/events-YYYY-MM.jsonl)
    # supaya histori tidak hilang saat backend/Mini PC restart. MQTT /log
    # hanya untuk kirim realtime ke dashboard, BUKAN penyimpanan permanen.
    # ----------------------------------------------------------
    def log_event(self, msg, level="info"):
        entry = {"msg": msg, "ts": time.time(), "level": level}
        self.log_ring.append(entry)
        self._persist_log(entry)
        if self.mqtt is not None:
            self.mqtt.publish_log(msg)
        # Kirim realtime ke WebSocket lokal (dashboard halaman Logging)
        self._notify_log_entry(entry)

    def _notify_log_entry(self, entry):
        if self.loop is None or self.loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_log_entry(entry), self.loop)
        except Exception:
            pass

    async def _broadcast_log_entry(self, entry):
        if not self.clients:
            return
        lock = self.broadcast_lock
        if lock is None:
            return
        async with lock:
            dead = []
            payload = {"log_entry": entry}
            for ws in list(self.clients):
                try:
                    await ws.send_json(payload)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)

    def _ensure_log_dir(self):
        """Buat folder log lokal (backend/logs/) jika belum ada, kembalikan path file."""
        try:
            os.makedirs(LOG_DIR, exist_ok=True)
        except OSError as exc:
            self.log_ring.append({
                "msg": "GAGAL membuat folder log %s: %r - log hanya in-memory" % (LOG_DIR, exc),
                "ts": time.time(), "level": "warning",
            })
            log.warning("Gagal buat folder log %s: %r - log hanya in-memory", LOG_DIR, exc)
        return LOG_DIR

    def _log_path_for_ts(self, ts=None):
        if ts is None:
            ts = time.time()
        d = datetime.fromtimestamp(ts)
        return LOG_DIR / ("events-%04d-%02d.jsonl" % (d.year, d.month))

    def _persist_log(self, entry):
        """Tulis satu entry log (JSON per baris) ke file lokal Mini PC (rotasi per bulan).

        Tidak pernah menghapus file lama. Flush + fsync agar data langsung ke disk
        (Mini PC bisa mati mendadak).
        """
        try:
            fp = self._log_path_for_ts(entry.get("ts"))
            line = json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n"
            with open(fp, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
        except Exception as exc:
            # Jangan diam-diam: catat ke in-memory ring + console supaya kelihatan
            self.log_ring.append({
                "msg": "GAGAL menyimpan log ke disk (%r): %r" % (getattr(self, "_log_file", LOG_DIR), exc),
                "ts": time.time(), "level": "warning",
            })
            log.warning("Gagal menulis log ke disk: %r", exc)

    def load_persisted_logs(self, limit=200):
        """Baca histori log terakhir dari file lokal (dipakai endpoint GET /api/logs).

        Gabung seluruh file rotasi bulanan (terbaru dulu, mundur ke belakang).
        """
        try:
            files = sorted(
                [p for p in LOG_DIR.glob("events-*.jsonl") if p.is_file()],
                reverse=True,
            )
        except Exception as exc:
            log.warning("Gagal list file log: %r", exc)
            return []
        rows = []
        for fp in files:
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rows.append(json.loads(line))
                        except ValueError:
                            continue
            except Exception as exc:
                log.warning("Gagal baca histori log %s: %r", fp, exc)
        rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
        return rows[:limit]

    def _load_all_log_entries(self):
        """Gabung seluruh file rotasi bulanan, urut TERBARU dulu (descending)."""
        try:
            files = sorted(
                [p for p in LOG_DIR.glob("events-*.jsonl") if p.is_file()],
                reverse=True,
            )
        except Exception as exc:
            log.warning("Gagal list file log: %r", exc)
            return []
        rows = []
        for fp in files:
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rows.append(json.loads(line))
                        except ValueError:
                            continue
            except Exception as exc:
                log.warning("Gagal baca histori log %s: %r", fp, exc)
        rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
        return rows

    # ----------------------------------------------------------
    # Log sync via MQTT (request/response chunked, non-retained)
    # Dipakai dashboard remote yang tidak bisa akses REST API Mini PC.
    # ----------------------------------------------------------
    def _handle_log_sync_request(self, msg):
        if self.mqtt is None:
            return
        req_id = msg.get("req_id")
        if not req_id:
            return
        entries = self._load_all_log_entries()
        try:
            cursor = int(msg.get("cursor") or 0)
        except (TypeError, ValueError):
            cursor = 0
        if cursor < 0:
            cursor = 0
        chunk = entries[cursor:cursor + 200]
        next_cursor = cursor + len(chunk)
        done = next_cursor >= len(entries)
        resp = {
            "req_id": req_id,
            "entries": chunk,
            "has_more": (not done),
            "next_cursor": (None if done else str(next_cursor)),
        }
        self.mqtt.publish(TOPIC["log_sync_response"], json.dumps(resp, ensure_ascii=False), retain=False)

    # ----------------------------------------------------------
    # Log / PZEM export CSV via MQTT (request/response chunked)
    # ----------------------------------------------------------
    def _parse_date(self, s):
        if not s:
            return None
        try:
            return datetime.strptime(s, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return None

    def _publish_csv_response(self, response_topic, req_id, csv_text, n_rows=1):
        if n_rows == 0:
            # Tidak ada data: kirim penanda kosong (frontend menampilkan pesan,
            # bukan file CSV kosong yang membingungkan).
            resp = {
                "req_id": req_id,
                "chunk_index": 0,
                "csv_chunk": "",
                "has_more": False,
                "empty": True,
                "message": csv_export.CSV_EMPTY_MESSAGE,
            }
            self.mqtt.publish(response_topic, json.dumps(resp, ensure_ascii=False), retain=False)
            return
        chunks = csv_export.chunk_text(csv_text)
        # UTF-8 BOM di chunk pertama agar Excel mengenali encoding otomatis
        chunks[0] = "\ufeff" + chunks[0]
        for i, c in enumerate(chunks):
            resp = {
                "req_id": req_id,
                "chunk_index": i,
                "csv_chunk": c,
                "has_more": i < len(chunks) - 1,
            }
            self.mqtt.publish(response_topic, json.dumps(resp, ensure_ascii=False), retain=False)

    @staticmethod
    def _csv_range_error_text(kind):
        """CSV pesan error rentang terlalu panjang (delimiter sama dengan export)."""
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=csv_export.CSV_DELIMITER, lineterminator="\r\n")
        w.writerow(["date/time", "log" if kind == "log" else "v"])
        w.writerow(["", "Error: rentang tanggal maksimal %d hari" % csv_export.CSV_MAX_RANGE_DAYS])
        return buf.getvalue()

    def _handle_log_export_request(self, msg):
        if self.mqtt is None:
            return
        req_id = msg.get("req_id")
        df = self._parse_date(msg.get("date_from"))
        dt = self._parse_date(msg.get("date_to"))
        if not req_id or not df or not dt:
            return
        if (dt - df).days > csv_export.CSV_MAX_RANGE_DAYS:
            csv_text = self._csv_range_error_text("log")
            n_rows = 1
        else:
            csv_text, n_rows = csv_export.export_logs_csv(df, dt)
        self._publish_csv_response(TOPIC["log_export_response"], req_id, csv_text, n_rows)

    def _handle_pzem_export_request(self, msg):
        if self.mqtt is None:
            return
        req_id = msg.get("req_id")
        df = self._parse_date(msg.get("date_from"))
        dt = self._parse_date(msg.get("date_to"))
        if not req_id or not df or not dt:
            return
        if (dt - df).days > csv_export.CSV_MAX_RANGE_DAYS:
            csv_text = self._csv_range_error_text("pzem")
            n_rows = 1
        else:
            csv_text, n_rows = csv_export.export_pzem_csv(df, dt)
        self._publish_csv_response(TOPIC["pzem_export_response"], req_id, csv_text, n_rows)

    # ----------------------------------------------------------
    # Relay state ke MQTT (state topics, retained)
    # ----------------------------------------------------------
    def _publish_mqtt_state(self):
        if self.mqtt is None:
            return
        try:
            s = self.state
            self.mqtt.publish_lampu_state(s["lampu"] == 1)
            self.mqtt.publish_pompa_state(s["pompa"] == 1)
            self.mqtt.publish_dorlock_state(s["dorlock"] == 1)
            self.mqtt.publish_ac_state(
                s["ac"]["power"] == 1,
                s["ac"]["suhu"],
                s["ac"]["fan"],
            )
            self.mqtt.publish_health(
                esp32=s["esp32_online"],
                nodemcu=s["nodemcu_online"],
            )
            # Sensor state (suhu_ruangan + kelembaban)
            if s.get("suhu_ruangan") is not None:
                self.mqtt.publish_sensor_state(
                    suhu=s["suhu_ruangan"],
                    kelembaban=s.get("kelembaban_ruangan"),
                )
            # Automation state
            self.mqtt.publish_automation_state(self.automation)
            # Running Hours state (retained)
            self.mqtt.publish_runninghours_state(self.state["running_hours"])
        except Exception as exc:
            log.warning("Gagal publish state ke MQTT: %r", exc)

    def publish_telegram_state(self):
        if self.mqtt is None:
            return
        st = self.telegram.redacted_state()
        self.mqtt.publish_telegram_state(
            bot_token_preview=st["bot_token_preview"],
            chat_id=st["chat_id"],
            configured=st["configured"],
        )

    # ----------------------------------------------------------
    # Reader serial (reconnect loop, pola proyek lama)
    # ----------------------------------------------------------
    def run_reader(self):
        attempts = 0
        log.info("Reader serial dimulai -> target %s", SERIAL_PORT)
        while not self.stop_event.is_set():
            try:
                ok = self._reader_session()
            except Exception as exc:
                log.error("Error tak terduga: %r - lanjut retry", exc)
                ok = True
            if not ok:
                attempts += 1
                if attempts == 1 or attempts % 10 == 0:
                    log.warning(
                        "Port %s belum tersedia - retry tiap %gs",
                        SERIAL_PORT, RETRY_INTERVAL,
                    )
            else:
                attempts = 0
            self.stop_event.wait(RETRY_INTERVAL)

    def _reader_session(self):
        try:
            ser = serial.Serial(port=SERIAL_PORT, baudrate=SERIAL_BAUD, timeout=0.2)
        except (serial.SerialException, OSError, ValueError):
            return False
        with self.ser_lock:
            self.ser = ser
        self.state["serial_online"] = True
        log.info("ESP32 TERHUBUNG ke %s", SERIAL_PORT)
        self.log_event("ESP32 terhubung via %s" % SERIAL_PORT)
        self._publish_mqtt_state()
        if self.mqtt is not None:
            self.publish_telegram_state()
        self.notify()
        try:
            while not self.stop_event.is_set():
                try:
                    raw = ser.readline()
                except (serial.SerialException, OSError):
                    return False
                if raw:
                    line = raw.decode("utf-8", "replace").strip()
                    if line:
                        self._parse_line(line)
            return False
        finally:
            try:
                ser.close()
            except Exception:
                pass
            with self.ser_lock:
                self.ser = None
            self.state["serial_online"] = False
            self.state["esp32_online"] = False
            log.warning("ESP32 terputus dari %s - reconnect...", SERIAL_PORT)
            self.log_event("ESP32 terputus - mencoba reconnect...")
            self._publish_mqtt_state()
            self.notify()

    # ----------------------------------------------------------
    # Parse pesan JSON dari ESP32
    # ----------------------------------------------------------
    def _parse_line(self, line):
        try:
            msg = json.loads(line)
        except (ValueError, json.JSONDecodeError):
            log.warning("Baris korup dari serial: %.60s", line)
            return
        if not isinstance(msg, dict):
            return

        changed = False

        if msg.get("lampu") in (0, 1):
            if self.state["lampu"] != msg["lampu"]:
                self.state["lampu"] = msg["lampu"]
                changed = True

        if msg.get("pompa") in (0, 1):
            if self.state["pompa"] != msg["pompa"]:
                self.state["pompa"] = msg["pompa"]
                changed = True

        if msg.get("dorlock") in (0, 1):
            if self.state["dorlock"] != msg["dorlock"]:
                self.state["dorlock"] = msg["dorlock"]
                changed = True

        ac = msg.get("ac")
        if isinstance(ac, dict):
            power = 1 if str(ac.get("power", 0)) in ("1", "ON", "true") else 0
            suhu = self.state["ac"]["suhu"]
            if ac.get("suhu") is not None:
                try:
                    suhu = int(ac["suhu"])
                except (TypeError, ValueError):
                    pass
            fan = str(ac.get("fan", self.state["ac"]["fan"])).upper()
            if fan not in AC_FAN_VALUES:
                fan = self.state["ac"]["fan"]
            new_ac = {"power": power, "suhu": suhu, "fan": fan}
            if self.state["ac"] != new_ac:
                self.state["ac"] = new_ac
                changed = True
            if "ac_ack" in msg and isinstance(msg["ac_ack"], bool):
                if self.state["ac_ack"] != msg["ac_ack"]:
                    self.state["ac_ack"] = msg["ac_ack"]
                    changed = True

        if isinstance(msg.get("nodemcu_online"), bool):
            if self.state["nodemcu_online"] != msg["nodemcu_online"]:
                self.state["nodemcu_online"] = msg["nodemcu_online"]
                changed = True

        # Sensor DHT22: suhu_ruangan & kelembaban_ruangan (terima int/float)
        for key in ("suhu_ruangan", "kelembaban_ruangan"):
            if msg.get(key) is not None:
                try:
                    val = float(msg[key])
                except (TypeError, ValueError):
                    continue
                if self.state[key] != val:
                    self.state[key] = val
                    changed = True

        # Sensor PZEM (Grafik + timeout Pompa) — sumber tunggal (dummy atau asli)
        if isinstance(msg.get("pompa_listrik"), dict):
            p = msg["pompa_listrik"]
            try:
                norm = {
                    "tegangan": float(p.get("tegangan", 0)),
                    "frekuensi": float(p.get("frekuensi", 0)),
                    "cosphi": float(p.get("cosphi", 0)),
                    "arus": float(p.get("arus", 0)),
                    "daya": float(p.get("daya", 0)),
                }
                self.state["pompa_listrik"] = norm
                changed = True
            except (TypeError, ValueError):
                pass

        if not self.state["esp32_online"]:
            self.state["esp32_online"] = True
            changed = True

        self.last_seen = time.monotonic()
        self.state["ts"] = time.time()

        if changed:
            self._publish_mqtt_state()
            self.notify()

    # ----------------------------------------------------------
    # Staleness checker ESP32 + health publish berkala
    # ----------------------------------------------------------
    def run_staleness_checker(self):
        while not self.stop_event.is_set():
            self.stop_event.wait(2.0)
            now = time.monotonic()
            if self.state["esp32_online"] and now - self.last_seen > STALE_TIMEOUT:
                self.state["esp32_online"] = False
                log.warning(
                    "ESP32 tidak merespons > %.0fs - ditandai OFFLINE", STALE_TIMEOUT
                )
                self.log_event("ESP32 tidak merespons - ditandai OFFLINE")
                self._publish_mqtt_state()
                self.notify()
            if self.mqtt is not None and now - self._last_health_pub > 10.0:
                self._last_health_pub = now
                self.mqtt.publish_health(
                    self.state["esp32_online"], self.state["nodemcu_online"]
                )

    # ----------------------------------------------------------
    # Automation rules: load/save ke backend/automation_rules.json
    # (path relatif ke backend/, jadi langsung berfungsi juga saat
    # folder proyek dipindah ke Mini PC produksi). Save pakai atomic
    # write (temp + os.replace) supaya tidak korup saat listrik mati.
    # ----------------------------------------------------------
    def _load_automation(self):
        rules = json.loads(json.dumps(DEFAULT_AUTOMATION))
        try:
            if AUTOMATION_FILE.exists():
                with open(AUTOMATION_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    for group in ("ac", "lampu", "pompa"):
                        if isinstance(data.get(group), dict):
                            rules[group].update(data[group])
                log.info("Aturan automation dimuat dari %s", AUTOMATION_FILE)
            else:
                self._save_automation(rules)
        except Exception as exc:
            log.warning("Gagal load automation %s: %r - pakai default", AUTOMATION_FILE, exc)
        return rules

    def _save_automation(self, rules):
        try:
            tmp = AUTOMATION_FILE.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rules, f, indent=2, ensure_ascii=False)
            os.replace(tmp, AUTOMATION_FILE)
        except Exception as exc:
            log.warning("Gagal simpan automation %s: %r", AUTOMATION_FILE, exc)
            return False
        return True

    # ----------------------------------------------------------
    # Automation checker (thread terpisah, di-start dari main.py).
    # ----------------------------------------------------------
    def run_automation_checker(self):
        log.info("Automation checker dimulai (interval %.0fs)", AUTOMATION_CHECK_INTERVAL)
        while not self.stop_event.is_set():
            self.stop_event.wait(AUTOMATION_CHECK_INTERVAL)
            try:
                self._check_ac_automation()
                self._check_ac_timeout()
                self._check_lampu_automation()
                self._check_pompa_automation()
                self._check_pompa_current_timeout()
                self._decay_running_hours()
            except Exception as exc:
                log.warning("Automation checker error: %r", exc)

    def _check_ac_automation(self):
        rules = self.automation.get("ac") or {}
        if not rules.get("enabled"):
            return
        suhu = self.state.get("suhu_ruangan")
        if suhu is None:
            return
        try:
            on_temp = float(rules.get("on_temp", 27))
            off_temp = float(rules.get("off_temp", 24))
        except (TypeError, ValueError):
            return
        ac = self.state["ac"]
        try:
            # M4 fix: TANPA dedupe harian untuk AC. Ambang suhu bersifat
            # histeresis (ON >= on_temp, OFF <= off_temp) sehingga tidak bisa
            # oscillate; dedupe harian dulu membuat AC cuma boleh 1x ON + 1x
            # OFF per hari (sore yang panas tidak tertangani lagi).
            if suhu >= on_temp and ac["power"] == 0:
                if not self._automation_attempt("ac_on"):
                    return
                self.send_ac(power=1, suhu=ac["suhu"], fan=ac["fan"])
                self.log_event(
                    "A/C ON otomatis (suhu ruangan %.1f°C >= ambang %s°C)"
                    % (suhu, on_temp)
                )
            elif suhu <= off_temp and ac["power"] == 1:
                if not self._automation_attempt("ac_off"):
                    return
                self.send_ac(power=0, suhu=ac["suhu"], fan=ac["fan"])
                self.log_event(
                    "A/C OFF otomatis (suhu ruangan %.1f°C <= ambang %s°C)"
                    % (suhu, off_temp)
                )
        except Exception as exc:
            log.warning("Automation A/C error: %r", exc)

    def _check_ac_timeout(self):
        """Peringatan timeout A/C (HANYA log, TIDAK mematikan/menyalakan apa pun)."""
        rules = self.automation.get("ac") or {}
        if not rules.get("timeout_enabled"):
            self._ac_timeout = {"start": None, "warned": False}
            return
        try:
            timeout_minutes = float(rules.get("timeout_minutes", 120))
            target = float(rules.get("off_temp", 24))
        except (TypeError, ValueError):
            return
        if timeout_minutes <= 0:
            return

        ac_on = self.state["ac"]["power"] == 1
        suhu = self.state.get("suhu_ruangan")
        now = time.monotonic()
        st = self._ac_timeout

        if not ac_on:
            if st["start"] is not None or st["warned"]:
                self._ac_timeout = {"start": None, "warned": False}
            return

        if suhu is None:
            return

        # Target tercapai -> reset timer
        if suhu <= target:
            if st["start"] is not None or st["warned"]:
                self._ac_timeout = {"start": None, "warned": False}
            return

        if st["start"] is None:
            st["start"] = now
        if st["warned"]:
            return
        if now - st["start"] >= timeout_minutes * 60:
            st["warned"] = True
            self.log_event(
                "PERINGATAN TIMEOUT A/C: A/C menyala > %d menit tapi suhu ruangan "
                "%.1f°C belum mencapai target %s°C"
                % (timeout_minutes, suhu, target),
                level="warning",
            )
            # Update 14 Sep 2026 (owner): TIMEOUT A/C ikut dikirim ke Telegram
            # (dulu log-only). Sekali per kejadian — flag warned baru direset
            # saat suhu target tercapai / A/C mati.
            self._notify_telegram(
                "[BMS IoT] PERINGATAN TIMEOUT A/C: A/C menyala > %d menit tapi suhu "
                "ruangan %.1f°C belum mencapai target %s°C"
                % (timeout_minutes, suhu, target)
            )

    # ----------------------------------------------------------
    # Automation Lampu/Pompa: LOGIKA STATE-BASED (M5 fix).
    # Dulu: menembak tepat di menit jadwal (now_hm == on_time) — kalau
    # ESP32 offline di menit itu / backend restart di tengah jendela aktif,
    # command hilang dan perangkat salah state sampai jadwal besok.
    # Sekarang: tiap tick dievaluasi "perangkat HARUS ON sekarang?"
    # (termasuk jadwal yang melewati tengah malam) dan perintah dikirim
    # bila state != harapan. `_automation_attempt` menjadi throttle:
    # usaha pertama selalu langsung; pengulangan hanya tiap
    # AUTO_RETRY_INTERVAL (mis. saat serial putus, retry diam-diam tiap
    # 2 menit, tanpa spam log/command).
    # ----------------------------------------------------------
    AUTO_RETRY_INTERVAL = 120.0  # detik jeda antar pengulangan command automation

    @staticmethod
    def _hm_to_minutes(hm):
        """'HH:MM' -> menit sejak 00:00; None jika tidak valid."""
        try:
            h, m = str(hm).split(":")
            h, m = int(h), int(m)
        except (ValueError, AttributeError):
            return None
        if not (0 <= h <= 23 and 0 <= m <= 59):
            return None
        return h * 60 + m

    @classmethod
    def _in_schedule_window(cls, now_dt, on_time, off_time):
        """True jika `now_dt` berada di jendela jadwal ON..OFF (wrap tengah
        malam ditangani: on > off berarti jendela lintas hari).
        None jika jadwal tidak valid / ambigu (on == off)."""
        now_m = now_dt.hour * 60 + now_dt.minute
        on_m = cls._hm_to_minutes(on_time)
        off_m = cls._hm_to_minutes(off_time)
        if on_m is None or off_m is None or on_m == off_m:
            return None
        if on_m < off_m:
            return on_m <= now_m < off_m
        return now_m >= on_m or now_m < off_m

    def _automation_attempt(self, device):
        """Throttle per-device: True jika command boleh dikirim sekarang."""
        now = time.monotonic()
        next_ok = self._auto_pending.get(device, 0.0)
        if now < next_ok:
            return False
        self._auto_pending[device] = now + self.AUTO_RETRY_INTERVAL
        return True

    def _check_lampu_automation(self):
        rules = self.automation.get("lampu") or {}
        if not rules.get("enabled"):
            return
        should_on = self._in_schedule_window(
            datetime.now(), rules.get("on_time", "18:00"), rules.get("off_time", "06:00")
        )
        if should_on is None:
            return
        lampu = self.state.get("lampu")
        want = 1 if should_on else 0
        if lampu == want:
            return
        if not self._automation_attempt("lampu"):
            return
        self.send_lampu(want)
        self.log_event(
            "Lampu %s otomatis (jadwal ON %s / OFF %s)"
            % ("ON" if want else "OFF", rules.get("on_time", "18:00"), rules.get("off_time", "06:00"))
        )

    # ----------------------------------------------------------
    # Automation Pompa (tambahan): jadwal ON/OFF + timeout arus
    # ----------------------------------------------------------
    def _is_pompa_auto_enabled(self):
        return bool((self.automation.get("pompa") or {}).get("enabled"))

    def _check_pompa_automation(self):
        rules = self.automation.get("pompa") or {}
        if not rules.get("enabled"):
            return
        should_on = self._in_schedule_window(
            datetime.now(), rules.get("on_time", "06:00"), rules.get("off_time", "18:00")
        )
        if should_on is None:
            return
        pompa = self.state.get("pompa")
        want = 1 if should_on else 0
        if pompa == want:
            return
        if not self._automation_attempt("pompa"):
            return
        self.send_pompa(want)
        self.log_event(
            "Pompa %s otomatis (jadwal ON %s / OFF %s)"
            % ("ON" if want else "OFF", rules.get("on_time", "06:00"), rules.get("off_time", "18:00"))
        )

    def _check_pompa_current_timeout(self):
        """Deteksi pompa bermasalah: saat menyala, jika arus tidak pernah mencapai
        ambang minimum dalam durasi tertentu -> log warning (merah) + notif Telegram.
        """
        rules = self.automation.get("pompa") or {}
        if not rules.get("timeout_enabled"):
            self._pompa_current_timeout = {"start": None, "warned": False}
            return
        try:
            timeout_minutes = float(rules.get("timeout_minutes", 15))
            threshold = float(rules.get("current_threshold_amp", 1.0))
        except (TypeError, ValueError):
            return
        if timeout_minutes <= 0:
            return

        pompa_on = self.state.get("pompa") == 1
        pz = self.state.get("pompa_listrik") or {}
        arus = pz.get("arus", 0) or 0
        now = time.monotonic()
        st = self._pompa_current_timeout

        # Pompa mati -> reset timer
        if not pompa_on:
            if st["start"] is not None or st["warned"]:
                self._pompa_current_timeout = {"start": None, "warned": False}
            return

        # Arus sudah mencukupi -> reset timer (pompa sehat)
        if arus >= threshold:
            if st["start"] is not None or st["warned"]:
                self._pompa_current_timeout = {"start": None, "warned": False}
            return

        # Arus di bawah ambang -> mulai/pertahankan timer
        if st["start"] is None:
            st["start"] = now
        if st["warned"]:
            return
        if now - st["start"] >= timeout_minutes * 60:
            st["warned"] = True
            msg = ("PERINGATAN POMPA: arus tidak mencapai ambang %.2f A selama %d menit "
                   "(arus terukur %.2f A) — kemungkinan pompa bermasalah/kering")
            self.log_event(msg % (threshold, timeout_minutes, arus), level="warning")
            self._notify_telegram(
                "[BMS IoT] " + msg % (threshold, timeout_minutes, arus)
            )

    def _is_ac_auto_enabled(self):
        return bool((self.automation.get("ac") or {}).get("enabled"))

    def _is_lampu_auto_enabled(self):
        return bool((self.automation.get("lampu") or {}).get("enabled"))

    def _apply_automation_rules(self, rules):
        """Validasi + simpan rule baru. Return (ok, pesan_error)."""
        if not isinstance(rules, dict):
            return False, "format rules tidak valid"
        new_ac = rules.get("ac")
        new_lampu = rules.get("lampu")
        new_pompa = rules.get("pompa")
        if new_ac is not None:
            if not isinstance(new_ac, dict):
                return False, "format ac tidak valid"
            try:
                on_temp = float(new_ac.get("on_temp", self.automation["ac"]["on_temp"]))
                off_temp = float(new_ac.get("off_temp", self.automation["ac"]["off_temp"]))
            except (TypeError, ValueError):
                return False, "suhu ambang A/C harus angka"
            if on_temp <= off_temp:
                return False, "A/C ON harus lebih besar dari A/C OFF (hysteresis)"
            try:
                timeout_minutes = int(new_ac.get("timeout_minutes", self.automation["ac"].get("timeout_minutes", 120)))
            except (TypeError, ValueError):
                return False, "durasi timeout A/C harus angka (menit)"
            if timeout_minutes < 1:
                return False, "durasi timeout A/C minimal 1 menit"
            self.automation["ac"]["on_temp"] = on_temp
            self.automation["ac"]["off_temp"] = off_temp
            self.automation["ac"]["enabled"] = bool(new_ac.get("enabled", self.automation["ac"]["enabled"]))
            self.automation["ac"]["timeout_enabled"] = bool(new_ac.get("timeout_enabled", self.automation["ac"].get("timeout_enabled", False)))
            self.automation["ac"]["timeout_minutes"] = timeout_minutes
        if new_lampu is not None:
            if not isinstance(new_lampu, dict):
                return False, "format lampu tidak valid"
            on_time = str(new_lampu.get("on_time", self.automation["lampu"]["on_time"]))
            off_time = str(new_lampu.get("off_time", self.automation["lampu"]["off_time"]))
            if on_time == off_time:
                return False, "jam Lampu ON dan OFF tidak boleh sama"
            self.automation["lampu"]["on_time"] = on_time
            self.automation["lampu"]["off_time"] = off_time
            self.automation["lampu"]["enabled"] = bool(new_lampu.get("enabled", self.automation["lampu"]["enabled"]))
        if new_pompa is not None:
            if not isinstance(new_pompa, dict):
                return False, "format pompa tidak valid"
            on_time = str(new_pompa.get("on_time", self.automation["pompa"]["on_time"]))
            off_time = str(new_pompa.get("off_time", self.automation["pompa"]["off_time"]))
            if on_time == off_time:
                return False, "jam Pompa ON dan OFF tidak boleh sama"
            try:
                threshold = float(new_pompa.get("current_threshold_amp", self.automation["pompa"]["current_threshold_amp"]))
            except (TypeError, ValueError):
                return False, "ambang arus pompa harus angka (Ampere)"
            if threshold <= 0:
                return False, "ambang arus pompa harus > 0"
            try:
                timeout_minutes = int(new_pompa.get("timeout_minutes", self.automation["pompa"]["timeout_minutes"]))
            except (TypeError, ValueError):
                return False, "durasi timeout pompa harus angka (menit)"
            if timeout_minutes < 1:
                return False, "durasi timeout pompa minimal 1 menit"
            self.automation["pompa"]["on_time"] = on_time
            self.automation["pompa"]["off_time"] = off_time
            self.automation["pompa"]["enabled"] = bool(new_pompa.get("enabled", self.automation["pompa"]["enabled"]))
            self.automation["pompa"]["current_threshold_amp"] = threshold
            self.automation["pompa"]["timeout_enabled"] = bool(new_pompa.get("timeout_enabled", self.automation["pompa"].get("timeout_enabled", False)))
            self.automation["pompa"]["timeout_minutes"] = timeout_minutes
        if not self._save_automation(self.automation):
            return False, "gagal menyimpan rules ke disk"
        # Sinkronkan ke state supaya ter-broadcast ke semua dashboard
        self.state["automation"] = json.loads(json.dumps(self.automation))
        # Bersihkan throttle supaya rule baru langsung dievaluasi pada tick
        # berikutnya (state-based: perangkat disinkronkan ke jadwal baru
        # seketika, tidak perlu menunggu menit jadwal berikutnya)
        self._auto_pending = {}
        # Reset state timeout supaya hitung ulang dari awal
        self._ac_timeout = {"start": None, "warned": False}
        self._pompa_current_timeout = {"start": None, "warned": False}
        self.log_event(
            "Aturan automation disimpan: AC %s (ON %s°C / OFF %s°C%s), Lampu %s (ON %s / OFF %s), Pompa %s (ON %s / OFF %s%s)"
            % (
                "AKTIF" if self.automation["ac"]["enabled"] else "nonaktif",
                self.automation["ac"]["on_temp"],
                self.automation["ac"]["off_temp"],
                ", timeout %s menit" % self.automation["ac"]["timeout_minutes"]
                if self.automation["ac"].get("timeout_enabled") else "",
                "AKTIF" if self.automation["lampu"]["enabled"] else "nonaktif",
                self.automation["lampu"]["on_time"],
                self.automation["lampu"]["off_time"],
                "AKTIF" if self.automation["pompa"]["enabled"] else "nonaktif",
                self.automation["pompa"]["on_time"],
                self.automation["pompa"]["off_time"],
                ", timeout arus %s menit" % self.automation["pompa"]["timeout_minutes"]
                if self.automation["pompa"].get("timeout_enabled") else "",
            )
        )
        self._publish_mqtt_state()
        self.notify()
        return True, None

    # ----------------------------------------------------------
    # Running Hours
    # ----------------------------------------------------------
    def _load_running_hours(self):
        rh = json.loads(json.dumps(DEFAULT_RUNNING_HOURS))
        try:
            if RUNNING_HOURS_FILE.exists():
                with open(RUNNING_HOURS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    for dev in ("lampu", "pompa", "ac", "dorlock"):
                        if isinstance(data.get(dev), dict):
                            d = data[dev]
                            rh[dev]["set_time_hours"] = float(d.get("set_time_hours", rh[dev]["set_time_hours"]))
                            rh[dev]["remaining_hours"] = float(d.get("remaining_hours", rh[dev]["set_time_hours"]))
                            rh[dev]["warned"] = bool(d.get("warned", False))
                log.info("Running hours dimuat dari %s", RUNNING_HOURS_FILE)
        except Exception as exc:
            log.warning("Gagal load running hours %s: %r - pakai default", RUNNING_HOURS_FILE, exc)
        return rh

    def _save_running_hours(self):
        try:
            tmp = RUNNING_HOURS_FILE.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.running_hours, f, indent=2, ensure_ascii=False)
            os.replace(tmp, RUNNING_HOURS_FILE)
        except Exception as exc:
            log.warning("Gagal simpan running hours %s: %r", RUNNING_HOURS_FILE, exc)
            return False
        return True

    def _rh_public(self):
        return {k: dict(v) for k, v in self.running_hours.items()}

    def _publish_running_hours(self):
        if self.mqtt is None:
            return
        self.mqtt.publish_runninghours_state(self.state["running_hours"])

    def _decay_running_hours(self):
        now = time.monotonic()
        dt = now - self._rh_last_tick
        self._rh_last_tick = now
        changed = False
        for dev in ("lampu", "pompa", "ac", "dorlock"):
            rh = self.running_hours[dev]
            on = (
                (dev == "lampu" and self.state["lampu"] == 1)
                or (dev == "pompa" and self.state["pompa"] == 1)
                or (dev == "ac" and self.state["ac"]["power"] == 1)
                or (dev == "dorlock" and self.state["dorlock"] == 1)
            )
            if on and rh["remaining_hours"] > 0:
                rh["remaining_hours"] = max(0.0, rh["remaining_hours"] - dt / 3600.0)
                changed = True
                if rh["remaining_hours"] <= 0 and not rh["warned"]:
                    rh["warned"] = True
                    msg = (
                        "PERINGATAN MAINTENANCE: %s sudah mencapai batas Running Hours (%s jam) - waktunya maintenance"
                        % (DEV_NAME[dev], rh["set_time_hours"])
                    )
                    self.log_event(msg, level="warning")
                    # Owner ruling: Telegram utk peringatan pompa + maintenance RH.
                    self._notify_telegram("[BMS IoT] " + msg)
        # Simpan ke disk tiap ~60 detik (bukan tiap tick) supaya I/O tidak boros
        self._rh_acc += dt
        if changed:
            if self._rh_acc >= 60:
                self._rh_acc = 0
                self._save_running_hours()
            self.state["running_hours"] = self._rh_public()
            self._publish_running_hours()
        elif self._rh_acc >= 60:
            self._rh_acc = 0
            self._save_running_hours()

    def _reset_running_hours(self, device):
        if device not in self.running_hours:
            return False, "perangkat tidak valid"
        rh = self.running_hours[device]
        prev = rh["remaining_hours"]
        rh["remaining_hours"] = rh["set_time_hours"]
        rh["warned"] = False
        self._save_running_hours()
        self.state["running_hours"] = self._rh_public()
        self._publish_running_hours()
        self.notify()
        # Catat ke log HANYA jika memang ada perubahan (hindari spam log reset
        # saat counter sudah sama dengan Set Time)
        if abs(prev - rh["set_time_hours"]) > 0.0001:
            self.log_event(
                "Running Hours %s di-reset oleh teknisi (%.1f -> %.1f jam)"
                % (DEV_NAME[device], prev, rh["set_time_hours"])
            )
        return True, None

    # ----------------------------------------------------------
    # Dorlock: PUSH-TO-UNLOCK — tombol UNLOCK menyalakan solenoid
    # selama DORLOCK_PUSH_SECONDS (2 detik) lalu mati otomatis.
    # Frontend satu tombol UNLOCK; tidak ada perintah LOCK manual.
    # ----------------------------------------------------------
    def send_dorlock(self, value):
        value = 1 if value else 0
        payload = (json.dumps({"dorlock": value}) + "\n").encode("utf-8")
        if not self._write(payload):
            self.log_event("Perintah Doorlock tidak terkirim (serial belum terhubung)")
        elif value == 1:
            self.log_event("Doorlock UNLOCK -> solenoid AKTIF (push 2 detik)")
            log.info("Doorlock -> PUSH (2s)")
            self.state["dorlock"] = 1
            self.notify()
            # matikan sendiri setelah 2 detik (thread daemon — app tetap responsif)
            def _auto_off():
                self.stop_event.wait(DORLOCK_PUSH_SECONDS)
                if self.stop_event.is_set():
                    return
                if self.state.get("dorlock") != 1:
                    return  # sudah dimatikan (mis. esp32 mengirim state 0 lebih dulu)
                self.state["dorlock"] = 0
                self.notify()
                if self.mqtt is not None:
                    self.mqtt.publish_dorlock_state(False)
                log.info("Doorlock -> rilis (2s selesai)")
            t = threading.Thread(target=_auto_off, daemon=True)
            t.start()
        else:
            # rilis manual/eksternal (mis. dari firmware) — cukup update state
            self.state["dorlock"] = 0
            self.notify()
            log.info("Doorlock -> rilis")

    def _set_running_hours(self, payload):
        if not isinstance(payload, dict):
            return False, "format tidak valid"
        changed_any = False
        changed_devices = []
        for dev in ("lampu", "pompa", "ac", "dorlock"):
            d = payload.get(dev)
            if isinstance(d, dict) and "set_time_hours" in d:
                try:
                    v = float(d["set_time_hours"])
                except (TypeError, ValueError):
                    return False, "set_time_hours harus angka (jam)"
                if v <= 0:
                    return False, "set_time_hours harus > 0"
                # Sesuai konfirmasi user: SIMPAN otomatis reset Counter Down ke nilai baru
                prev_set = self.running_hours[dev]["set_time_hours"]
                prev_rem = self.running_hours[dev]["remaining_hours"]
                self.running_hours[dev]["set_time_hours"] = v
                self.running_hours[dev]["remaining_hours"] = v
                self.running_hours[dev]["warned"] = False
                changed_any = True
                if abs(prev_set - v) > 0.0001 or abs(prev_rem - v) > 0.0001:
                    changed_devices.append(DEV_NAME[dev])
        if not changed_any:
            return False, "tidak ada field set_time_hours yang diubah"
        self._save_running_hours()
        self.state["running_hours"] = self._rh_public()
        self._publish_running_hours()
        self.notify()
        # Log hanya untuk device yang benar2 berubah nilai
        if changed_devices:
            self.log_event(
                "Running Hours di-update (%s) - Set Time disimpan & counter di-reset"
                % ", ".join(changed_devices)
            )
        return True, None

    def _handle_runninghours_reset_mqtt(self, msg):
        if self.mqtt is None:
            return
        ok, err = self._reset_running_hours(msg.get("device"))
        self.mqtt.publish(TOPIC["runninghours_reset"], json.dumps(
            {"device": msg.get("device"), "ok": ok, "error": err}, ensure_ascii=False
        ), retain=False)

    def _handle_runninghours_set_mqtt(self, msg):
        if self.mqtt is None:
            return
        ok, err = self._set_running_hours(msg)
        self.mqtt.publish(TOPIC["runninghours_set"], json.dumps(
            {"ok": ok, "error": err}, ensure_ascii=False
        ), retain=False)

    # ----------------------------------------------------------
    # Telegram
    # ----------------------------------------------------------
    def _notify_telegram(self, text):
        if not self.telegram.is_configured():
            return
        token = self.telegram.bot_token
        chat = self.telegram.chat_id
        threading.Thread(
            target=self._send_telegram_blocking, args=(token, chat, text), daemon=True
        ).start()

    def _send_telegram_blocking(self, token, chat, text):
        """Kirim pesan Telegram dengan verifikasi SSL penuh + retry ringan.

        - CA bundle: certifi (default). TELEGRAM_CA_BUNDLE (.pem) dimuat
          TAMBAHAN via load_verify_locations untuk jaringan dengan SSL
          inspection (antivirus/firewall gedung) — opsional, tanpa itu
          tetap berfungsi. Verifikasi SSL TIDAK pernah dinonaktifkan.
        - Retry 2x untuk error jaringan/timeout (URLError/socket.timeout),
          TIDAK untuk SSLCertVerificationError (percobaan ulang tidak akan
          mengubah hasil verifikasi sertifikat).
        """
        url = "https://api.telegram.org/bot%s/sendMessage" % token
        data = json.dumps({"chat_id": chat, "text": text}).encode("utf-8")

        # Susun SSL context dengan CA bundle certifi + CA tambahan opsional
        ctx = ssl.create_default_context(
            cafile=certifi.where() if certifi else None
        )
        if TELEGRAM_CA_BUNDLE:
            try:
                ctx.load_verify_locations(cafile=TELEGRAM_CA_BUNDLE)
                log.info(
                    "Telegram: CA bundle tambahan dimuat: %s", TELEGRAM_CA_BUNDLE
                )
            except Exception as exc:
                log.warning(
                    "Telegram: gagal muat TELEGRAM_CA_BUNDLE %r (%r) - "
                    "lanjut dengan CA standar",
                    TELEGRAM_CA_BUNDLE,
                    exc,
                )

        last_exc = None
        for attempt in range(1, 4):  # 1 percobaan + 2 retry
            try:
                req = urllib.request.Request(
                    url, data=data, headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=5, context=ctx) as resp:
                    resp.read()
                return  # sukses
            except urllib.error.HTTPError:
                raise  # error HTTP (4xx/5xx) bukan masalah jaringan — jangan retry
            except ssl.SSLCertVerificationError as exc:
                last_exc = exc
                log.error(
                    "Telegram SSL: verifikasi sertifikat GAGAL "
                    "(SSLCertVerificationError): %s. Kemungkinan SSL inspection "
                    "antivirus/firewall. Ekspor root CA gedung ke file .pem lalu "
                    "set TELEGRAM_CA_BUNDLE di backend/.env. Verifikasi SSL "
                    "TIDAK dinonaktifkan.",
                    exc,
                )
                break  # retry tidak akan mengubah hasil verifikasi
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                # URLError pembungkus socket.timeout / koneksi; OSError cadangan
                reason = getattr(exc, "reason", exc)
                is_timeout = isinstance(
                    reason, (TimeoutError, OSError)
                ) or "timed out" in str(reason).lower()
                if not is_timeout or attempt >= 3:
                    last_exc = exc
                    break
                log.warning(
                    "Telegram: percobaan %d/3 gagal (jaringan/timeout): %r - "
                    "retry...",
                    attempt,
                    exc,
                )
                time.sleep(1.5)
            except Exception as exc:  # pragma: no cover - kesalahan tak terduga
                last_exc = exc
                break

        if last_exc is not None:
            log.warning("Gagal kirim notifikasi Telegram: %r", last_exc)
            try:
                if isinstance(last_exc, ssl.SSLCertVerificationError):
                    self.log_event(
                        "Notifikasi Telegram gagal: verifikasi sertifikat SSL "
                        "gagal (kemungkinan SSL inspection). Set "
                        "TELEGRAM_CA_BUNDLE di backend/.env - lihat log backend.",
                        level="warning",
                    )
                else:
                    self.log_event(
                        "Notifikasi Telegram gagal terkirim: %s" % last_exc,
                        level="warning",
                    )
            except Exception:
                pass

    def _handle_telegram_set(self, msg):
        if not isinstance(msg, dict):
            return
        token = msg.get("bot_token", "")
        chat = msg.get("chat_id", "")
        if not token or not chat:
            return
        self.telegram.save(token, chat)
        self.log_event("Konfigurasi Telegram disimpan")
        # Sinkronkan status redacted ke state tunggal (WS lokal) + MQTT retained
        self.state["telegram"] = self.telegram.redacted_state()
        self.notify()
        if self.mqtt is not None:
            self.publish_telegram_state()

    # ----------------------------------------------------------
    # PZEM (Grafik + timeout Pompa)
    # ----------------------------------------------------------
    def _gen_dummy_pzem(self):
        on = self.state.get("pompa") == 1
        teg = 220.0 + random.uniform(-3, 3)
        fr = 50.0 + random.uniform(-0.15, 0.15)
        cos = random.uniform(0.80, 0.95)

        if PZEM_DEMO_WAVE:
            # Mode demo: gelombang sinus berjalan terus (pompa MATI pun ikut
            # bergerak) supaya grafik Arus/Daya di Pump Graph terlihat hidup.
            t = time.time()
            base = 2.25 if not on else 2.25
            wave = (
                math.sin(t / 3.0) * 0.75
                + math.sin(t / 11.0) * 0.45
                + random.uniform(-0.06, 0.06)
            )
            arus = max(0.05, base + wave)
            cos = 0.85 + math.sin(t / 17.0) * 0.08
            daya = teg * arus * cos
            self.state["pompa_listrik"] = {
                "tegangan": round(teg, 1),
                "frekuensi": round(fr, 2),
                "cosphi": round(cos, 3),
                "arus": round(arus, 3),
                "daya": round(daya, 1),
            }
            return

        if on:
            arus = random.uniform(1.5, 3.0) + random.uniform(-0.1, 0.1)
            if arus < 0:
                arus = 0.0
            daya = teg * arus * cos
        else:
            arus = 0.0
            daya = 0.0
        self.state["pompa_listrik"] = {
            "tegangan": round(teg, 1),
            "frekuensi": round(fr, 2),
            "cosphi": round(cos, 3),
            "arus": round(arus, 3),
            "daya": round(daya, 1),
        }

    def _persist_pzem(self):
        pz = self.state.get("pompa_listrik")
        if not pz:
            return
        try:
            now = time.time()
            d = datetime.fromtimestamp(now)
            fp = LOG_DIR / ("pzem-%04d-%02d.jsonl" % (d.year, d.month))
            entry = {
                "ts": now,
                "v": pz.get("tegangan"),
                "hz": pz.get("frekuensi"),
                "cosphi": pz.get("cosphi"),
                "i": pz.get("arus"),
                "power": pz.get("daya"),
            }
            line = json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n"
            with open(fp, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
        except Exception as exc:
            log.warning("Gagal persist PZEM: %r", exc)

    def run_pzem(self):
        """Thread simulator dummy + persist + publish PZEM.

        - Mode dummy (default): generate nilai tiap ~1.5 detik.
        - Live publish ke MQTT retained tiap iterasi.
        - Persist ke disk tiap PZEM_PERSIST_INTERVAL_SECONDS (default 10 detik).
        Saat sensor asli terpasang (PZEM_DUMMY_MODE=false), nilai masuk lewat
        _parse_line() dan thread ini hanya mem-publish + persist.
        """
        self._pzem_last_tick = time.monotonic()
        self._pzem_acc = 0.0
        while not self.stop_event.is_set():
            self.stop_event.wait(PZEM_DUMMY_INTERVAL_SECONDS)
            if self.stop_event.is_set():
                break
            now = time.monotonic()
            dt = now - self._pzem_last_tick
            self._pzem_last_tick = now

            if PZEM_DUMMY_MODE:
                self._gen_dummy_pzem()
                # Broadcast ke WebSocket lokal supaya dashboard lokal menerima
                # update live (publish MQTT di bawah hanya menjangkau remote).
                self.notify()

            # Persist ke disk juga berlaku saat mode demo gelombang agar CSV
            # memuat pergerakan yang sama seperti yang terlihat di grafik.
            if PZEM_DUMMY_MODE and PZEM_DEMO_WAVE:
                self._pzem_acc += dt
                if self._pzem_acc >= PZEM_PERSIST_INTERVAL_SECONDS:
                    self._pzem_acc = 0.0
                    self._persist_pzem()

            # Publish live (retained) ke dashboard remote
            if self.mqtt is not None:
                self.mqtt.publish_pzem_state(self.state.get("pompa_listrik"))

            # Persist ke disk secara berkala (hemat storage)
            self._pzem_acc += dt
            if self._pzem_acc >= PZEM_PERSIST_INTERVAL_SECONDS:
                self._pzem_acc = 0.0
                self._persist_pzem()

    # ----------------------------------------------------------
    # Tulis perintah ke ESP32
    # ----------------------------------------------------------
    def _write(self, payload):
        with self.ser_lock:
            ser = self.ser
            if ser is None or not ser.is_open:
                return False
            try:
                ser.write(payload)
                return True
            except (serial.SerialException, OSError):
                return False

    # ----------------------------------------------------------
    # Perintah: lampu / pompa / AC (dari WS lokal ATAU MQTT)
    # ----------------------------------------------------------
    def send_lampu(self, value):
        value = 1 if value else 0
        payload = (json.dumps({"lampu": value}) + "\n").encode("utf-8")
        if not self._write(payload):
            self.log_event("Perintah Lampu tidak terkirim (serial belum terhubung)")
            # M3 fix: koreksi dashboard optimistik — kirim state sebenarnya
            # (tetap OFF/ON lama) ke semua client supaya UI tidak "bohong".
            self.notify()
            self._publish_mqtt_state()  # dashboard remote juga terkoreksi
        else:
            self.log_event("Lampu -> %s" % ("ON" if value else "OFF"))
            log.info("Lampu -> %s", "ON" if value else "OFF")

    def send_pompa(self, value):
        value = 1 if value else 0
        payload = (json.dumps({"pompa": value}) + "\n").encode("utf-8")
        if not self._write(payload):
            self.log_event("Perintah Pompa tidak terkirim (serial belum terhubung)")
            self.notify()          # M3 fix: lihat send_lampu
            self._publish_mqtt_state()
        else:
            self.log_event("Pompa -> %s" % ("ON" if value else "OFF"))
            log.info("Pompa -> %s", "ON" if value else "OFF")

    def send_ac(self, power, suhu, fan):
        ac = {"power": 1 if power else 0, "suhu": int(suhu), "fan": fan.upper()}
        payload = (json.dumps({"ac": ac}) + "\n").encode("utf-8")
        if not self._write(payload):
            self.log_event("Perintah A/C tidak terkirim (serial belum terhubung)")
            self.notify()          # M3 fix: lihat send_lampu
            self._publish_mqtt_state()
        else:
            self.log_event(
                "A/C -> power %s, %s C, fan %s"
                % ("ON" if power else "OFF", int(suhu), fan.upper())
            )
            log.info("A/C -> power=%s suhu=%s fan=%s", power, suhu, fan.upper())

    def _route_ac_command(self, ac):
        power = 1 if str(ac.get("power", 0)) in ("1", "ON", "true") else 0
        try:
            suhu = int(ac.get("suhu", 24))
        except (TypeError, ValueError):
            suhu = 24
        suhu = max(AC_TEMP_MIN, min(AC_TEMP_MAX, suhu))
        fan = str(ac.get("fan", "AUTO")).upper()
        if fan not in AC_FAN_VALUES:
            fan = "AUTO"
        self.send_ac(power, suhu, fan)

    # ----------------------------------------------------------
    # Entry point perintah dari WebSocket lokal
    # ----------------------------------------------------------
    async def handle_ws_command(self, ws, text):
        try:
            msg = json.loads(text)
        except (ValueError, json.JSONDecodeError):
            try:
                await ws.send_json({"error": "format JSON tidak valid"})
            except Exception:
                pass
            return
        if not isinstance(msg, dict):
            return

        # Auth: verifikasi password (scope automation / running_hours)
        if "auth_verify" in msg:
            a = msg["auth_verify"] or {}
            scope = a.get("scope")
            pw = a.get("password", "")
            # Jalur master: membuka halaman terkunci saat PIN user lupa.
            # Tidak terkena brute-force lock & tidak dicatat sebagai gagal.
            if MASTER_PASSWORD and pw == MASTER_PASSWORD:
                try:
                    await ws.send_json({"auth_verify_result": {"scope": scope, "ok": True, "locked_until": None, "via_master": True}})
                except Exception:
                    pass
                return
            ok, until = self.security.verify(scope, pw)
            if not ok:
                self.log_event(
                    "Percobaan password salah untuk halaman %s" % (scope or "?"),
                    level="warning",
                )
            try:
                await ws.send_json({"auth_verify_result": {"scope": scope, "ok": ok, "locked_until": until}})
            except Exception:
                pass
            return

        # Auth: ganti password user
        if "auth_change_password" in msg:
            a = msg["auth_change_password"] or {}
            ok, err = self._do_auth_change(
                a.get("master_password"), a.get("new_password"), a.get("current_password")
            )
            try:
                await ws.send_json({"auth_change_password_result": {"ok": ok, "error": err}})
            except Exception:
                pass
            return

        # Running Hours: reset per device
        if "running_hours_reset" in msg:
            r = msg["running_hours_reset"] or {}
            ok, err = self._reset_running_hours(r.get("device"))
            try:
                await ws.send_json({"runninghours_result": {"action": "reset", "device": r.get("device"), "ok": ok, "error": err}})
            except Exception:
                pass
            return

        # Running Hours: set Set Time
        if "running_hours_set" in msg:
            ok, err = self._set_running_hours(msg["running_hours_set"])
            try:
                await ws.send_json({"runninghours_result": {"action": "set", "ok": ok, "error": err}})
            except Exception:
                pass
            return

        # Telegram: simpan konfigurasi (dashboard lokal via WS)
        if "telegram_set" in msg:
            self._handle_telegram_set(msg["telegram_set"] or {})
            return

        # Automation set command
        if "automation" in msg:
            ok, err = self._apply_automation_rules(msg["automation"])
            try:
                if ok:
                    await ws.send_json({"automation": self.state["automation"]})
                else:
                    await ws.send_json({"error": err})
            except Exception:
                pass
            return

        # Tolak manual lampu jika automation lampu aktif
        if "lampu" in msg and msg["lampu"] in (0, 1):
            if self._is_lampu_auto_enabled():
                try:
                    await ws.send_json({"error": "Lampu sedang mode otomatis"})
                except Exception:
                    pass
                return
            self.send_lampu(msg["lampu"])
            return
        if "pompa" in msg and msg["pompa"] in (0, 1):
            if self._is_pompa_auto_enabled():
                try:
                    await ws.send_json({"error": "Pompa sedang mode otomatis"})
                except Exception:
                    pass
                return
            self.send_pompa(msg["pompa"])
            return
        if "dorlock" in msg and msg["dorlock"] in (0, 1):
            self.send_dorlock(msg["dorlock"])
            return
        if isinstance(msg.get("ac"), dict):
            if self._is_ac_auto_enabled():
                try:
                    await ws.send_json({"error": "A/C sedang mode otomatis"})
                except Exception:
                    pass
                return
            self._route_ac_command(msg["ac"])
            return

    # ----------------------------------------------------------
    # Entry point perintah dari MQTT (topic .../set & request)
    # ----------------------------------------------------------
    def handle_mqtt_command(self, topic, payload_str):
        try:
            payload = payload_str.strip()
            if topic == TOPIC["lampu_set"]:
                if self._is_lampu_auto_enabled():
                    return
                if payload in ("ON", "1"):
                    self.send_lampu(1)
                elif payload in ("OFF", "0"):
                    self.send_lampu(0)
                return
            if topic == TOPIC["pompa_set"]:
                if self._is_pompa_auto_enabled():
                    return
                if payload in ("ON", "1"):
                    self.send_pompa(1)
                elif payload in ("OFF", "0"):
                    self.send_pompa(0)
                return
            if topic == TOPIC["dorlock_set"]:
                if payload in ("LOCK", "ON", "1"):
                    self.send_dorlock(1)
                elif payload in ("OPEN", "OFF", "0"):
                    self.send_dorlock(0)
                return
            if topic == TOPIC["ac_set"]:
                if self._is_ac_auto_enabled():
                    return
                try:
                    ac = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(ac, dict):
                    self._route_ac_command(ac)
                return
            if topic == TOPIC["automation_set"]:
                try:
                    rules = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(rules, dict):
                    self._apply_automation_rules(rules)
                return
            if topic == TOPIC["log_sync_request"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_log_sync_request(m)
                return
            if topic == TOPIC["log_export_request"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_log_export_request(m)
                return
            if topic == TOPIC["pzem_export_request"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_pzem_export_request(m)
                return
            if topic == TOPIC["auth_verify_request"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_auth_verify_request(m)
                return
            if topic == TOPIC["auth_change_request"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_auth_change_request(m)
                return
            if topic == TOPIC["runninghours_reset"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_runninghours_reset_mqtt(m)
                return
            if topic == TOPIC["runninghours_set"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_runninghours_set_mqtt(m)
                return
            if topic == TOPIC["telegram_set"]:
                try:
                    m = json.loads(payload)
                except (ValueError, json.JSONDecodeError):
                    return
                if isinstance(m, dict):
                    self._handle_telegram_set(m)
                return
        except Exception as exc:
            log.warning("Command MQTT gagal diproses (topic=%s): %r", topic, exc)

    # ----------------------------------------------------------
    # Auth (request/response via MQTT)
    # ----------------------------------------------------------
    def _handle_auth_verify_request(self, msg):
        if self.mqtt is None:
            return
        req_id = msg.get("req_id")
        scope = msg.get("scope")
        pw = msg.get("password", "")
        # Jalur master (sama dengan WS): buka halaman terkunci saat PIN lupa
        if MASTER_PASSWORD and pw == MASTER_PASSWORD:
            resp = {"req_id": req_id, "scope": scope, "ok": True, "locked_until": None, "via_master": True}
            self.mqtt.publish(TOPIC["auth_verify_response"], json.dumps(resp, ensure_ascii=False), retain=False)
            return
        ok, until = self.security.verify(scope, pw)
        if not ok:
            self.log_event(
                "Percobaan password salah untuk halaman %s" % (scope or "?"),
                level="warning",
            )
        resp = {"req_id": req_id, "scope": scope, "ok": ok, "locked_until": until}
        self.mqtt.publish(TOPIC["auth_verify_response"], json.dumps(resp, ensure_ascii=False), retain=False)

    def _handle_auth_change_request(self, msg):
        if self.mqtt is None:
            return
        req_id = msg.get("req_id")
        ok, err = self._do_auth_change(
            msg.get("master_password"), msg.get("new_password"), msg.get("current_password")
        )
        resp = {"req_id": req_id, "ok": ok, "error": err}
        self.mqtt.publish(TOPIC["auth_change_response"], json.dumps(resp, ensure_ascii=False), retain=False)

    def _do_auth_change(self, master_password, new_password, current_password):
        if not new_password:
            return False, "password baru tidak boleh kosong"
        # Jalur 1: Master Password (skenario lupa)
        if MASTER_PASSWORD and master_password == MASTER_PASSWORD:
            self.security.set_user_password(new_password)
            self.log_event("Password user diubah (otorisasi Master Password)")
            return True, None
        # Jalur 2: Password user lama (ganti rutin)
        if current_password:
            ok, until = self.security.verify("change_password", current_password)
            if ok:
                self.security.set_user_password(new_password)
                self.log_event("Password user diubah (otorisasi password lama)")
                return True, None
            return False, "password lama salah"
        return False, "masukkan password lama"
# hubtag: qEmDetqCH6q6Iq
