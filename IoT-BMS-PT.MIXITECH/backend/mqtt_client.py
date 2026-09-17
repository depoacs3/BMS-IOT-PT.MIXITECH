import json
import logging
import ssl
import time

import paho.mqtt.client as mqtt

from config import SET_TOPICS

log = logging.getLogger("mixitech.mqtt")


class MQTTClient:
    """
    Wrapper paho-mqtt untuk HiveMQ Cloud (TLS).

    - Backend subscribe ke semua topic .../set, publish ke .../state,
      .../health, .../log.
    - LWT di-set ke topic system/availability payload "offline" retained,
      supaya broker otomatis mengumumkan backend mati kalau koneksi putus.
    """

    def __init__(self, host, port, username, password, topics, command_handler=None):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.topics = topics
        self.command_handler = command_handler  # callable(topic, payload_str)
        self.connected = False
        self.client = None

    # ----------------------------------------------------------
    # Callback paho (CallbackAPIVersion.VERSION2) [v2 7mxJPuDFSXZcXd]
    # ----------------------------------------------------------
    def on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            log.error("MQTT connect gagal, rc=%s", reason_code)
            return
        self.connected = True
        log.info("MQTT terhubung ke %s:%s", self.host, self.port)
        client.publish(self.topics["availability"], "online", qos=1, retain=True)
        for t in SET_TOPICS:
            client.subscribe(t, qos=1)
        log.info("MQTT subscribe: %s", SET_TOPICS)

    def on_disconnect(self, client, userdata, reason_code, properties=None):
        self.connected = False
        log.warning("MQTT terputus (rc=%s) - auto-reconnect...", reason_code)

    def on_message(self, client, userdata, msg):
        try:
            payload = msg.payload.decode("utf-8", "replace")
        except Exception:
            payload = ""
        if self.command_handler is not None:
            try:
                self.command_handler(msg.topic, payload)
            except Exception as exc:
                log.warning("command handler error (topic=%s): %r", msg.topic, exc)

    # ----------------------------------------------------------
    def start(self):
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id="mixitech-bms-backend"
        )
        self.client.username_pw_set(self.username, self.password)
        self.client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLSv1_2)
        self.client.will_set(
            self.topics["availability"], "offline", qos=1, retain=True
        )
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.connect_async(self.host, self.port, keepalive=60)
        self.client.loop_start()

    def stop(self):
        if self.client is None:
            return
        try:
            self.client.publish(self.topics["availability"], "offline", qos=1, retain=True)
        except Exception:
            pass
        try:
            self.client.disconnect()
        except Exception:
            pass
        self.client.loop_stop()

    def _pub(self, topic, payload, retain=False):
        if self.client is None or not self.connected:
            return
        try:
            self.client.publish(topic, payload, qos=1, retain=retain)
        except Exception as exc:
            log.warning("publish %s gagal: %r", topic, exc)

    def publish(self, topic, payload, retain=False):
        """Publish ke topic apa pun (dipakai untuk request/response non-retained)."""
        self._pub(topic, payload, retain=retain)

    # ---------------------------------------------------------
    # Publish helper untuk state baru (topik retained)
    # ---------------------------------------------------------
    def publish_runninghours_state(self, hours):
        payload = json.dumps(hours, ensure_ascii=False)
        self._pub(self.topics["runninghours_state"], payload, retain=True)

    def publish_telegram_state(self, bot_token_preview=None, chat_id=None, configured=False):
        payload = json.dumps({
            "configured": bool(configured),
            "chat_id": chat_id,
            "bot_token_preview": bot_token_preview,
        }, ensure_ascii=False)
        self._pub(self.topics["telegram_state"], payload, retain=True)

    def publish_pzem_state(self, pzem):
        if pzem is None:
            return
        payload = json.dumps({
            "v": pzem.get("tegangan"),
            "hz": pzem.get("frekuensi"),
            "cosphi": pzem.get("cosphi"),
            "i": pzem.get("arus"),
            "power": pzem.get("daya"),
            "ts": time.time(),
        }, ensure_ascii=False)
        self._pub(self.topics["pzem_state"], payload, retain=True)

    # ----------------------------------------------------------
    # Publish helper (state topics retained)
    # ----------------------------------------------------------
    def publish_lampu_state(self, on):
        self._pub(self.topics["lampu_state"], "ON" if on else "OFF", retain=True)

    def publish_pompa_state(self, on):
        self._pub(self.topics["pompa_state"], "ON" if on else "OFF", retain=True)

    def publish_dorlock_state(self, locked):
        # Push-to-unlock: state dorlock itu EVENT SEMENTARA (push 2 detik),
        # BUKAN kondisi persisten. retain=True membuat broker mengirim nilai
        # lama ("LOCKED" dari sesi power-to-lock) ke setiap dashboard baru ->
        # tombol UNLOCK terkunci "on" selamanya (bug terlaporkan). Karena itu
        # retained DIHILANGKAN: hanya subscriber yang online saat push yang
        # menerima status.
        self._pub(self.topics["dorlock_state"], "LOCKED" if locked else "OPEN", retain=False)

    def publish_ac_state(self, power_on, suhu, fan):
        payload = json.dumps({
            "power": "ON" if power_on else "OFF",
            "suhu": int(suhu),
            "fan": str(fan).upper(),
        })
        self._pub(self.topics["ac_state"], payload, retain=True)

    def publish_health(self, esp32=False, nodemcu=False):
        payload = json.dumps({
            "esp32": bool(esp32),
            "nodemcu": bool(nodemcu),
            "minipc": True,
            "ts": time.time(),
        })
        self._pub(self.topics["health"], payload, retain=True)

    def publish_sensor_state(self, suhu, kelembaban=None):
        payload = json.dumps({
            "suhu": round(float(suhu), 1),
            "kelembaban": None if kelembaban is None else round(float(kelembaban), 1),
            "ts": time.time(),
        })
        self._pub(self.topics["sensor_state"], payload, retain=True)

    def publish_automation_state(self, rules):
        payload = json.dumps(rules, ensure_ascii=False)
        self._pub(self.topics["automation_state"], payload, retain=True)

    def publish_log(self, msg):
        payload = json.dumps({"msg": msg, "ts": time.time()})
        self._pub(self.topics["log"], payload, retain=False)
# paho2: qEmDetqCH6q6Iq
