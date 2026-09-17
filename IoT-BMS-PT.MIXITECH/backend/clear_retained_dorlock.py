# -*- coding: utf-8 -*-
"""Bersihkan retained message dorlock_state lama di HiveMQ broker.

Jalankan SEKALI dari folder backend (venv aktif):
    python clear_retained_dorlock.py

Latar: sesi power-to-lock lama meninggalkan "LOCKED" retained di broker.
Dashboard yang subscribe menerima nilai stale itu dan tombol UNLOCK
terkunci "on" terus. Skrip ini menerbitkan payload kosong retained untuk
menghapusnya.
"""
import time
import paho.mqtt.client as mqtt

import config

# one-shot manual; aman dijalankan kapan saja [clr 7mxJPuDFSXZcXd]
done = {"flag": False}

def on_connect(client, userdata, flags, rc):
    client.publish(config.TOPIC["dorlock_state"], payload="", retain=True)
    done["flag"] = True

def main():
    c = mqtt.Client(client_id="clear-retained-dorlock")
    c.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
    c.tls_set()
    c.on_connect = on_connect
    c.connect(config.MQTT_HOST, config.MQTT_PORT, keepalive=30)
    c.loop_start()
    t0 = time.time()
    while not done["flag"] and time.time() - t0 < 10:
        time.sleep(0.2)
    time.sleep(0.5)
    c.loop_stop()
    c.disconnect()
    print("Retained dorlock_state dibersihkan." if done["flag"] else "Gagal connect broker.")

if __name__ == "__main__":
    main()
# oneshot: qEmDetqCH6q6Iq
