import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, date
from urllib.parse import unquote

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import config
import csv_export
from mqtt_client import MQTTClient
from serial_hub import SerialHub

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mixitech")

# Global instance — di-wire di lifespan
hub = SerialHub(mqtt=None)
mqtt_client = None


@asynccontextmanager
async def lifespan(app):
    global mqtt_client
    hub.loop = asyncio.get_running_loop()
    hub.broadcast_lock = asyncio.Lock()

    # MQTT
    if config.MQTT_HOST:
        mqtt_client = MQTTClient(
            host=config.MQTT_HOST,
            port=config.MQTT_PORT,
            username=config.MQTT_USER,
            password=config.MQTT_PASS,
            topics=config.TOPIC,
            command_handler=hub.handle_mqtt_command,
        )
        hub.mqtt = mqtt_client
        mqtt_client.start()
        log.info("MQTT client diinisialisasi")
    else:
        log.warning("MQTT_HOST tidak dikonfigurasi - mode lokal saja (tanpa IoT)")

    threading.Thread(target=hub.run_reader, daemon=True).start()
    threading.Thread(target=hub.run_staleness_checker, daemon=True).start()
    threading.Thread(target=hub.run_automation_checker, daemon=True).start()
    threading.Thread(target=hub.run_pzem, daemon=True).start()

    log.info("Backend BMS IoT siap di http://%s:%d (WebSocket /ws)", config.HOST, config.PORT)
    yield

    hub.stop_event.set()
    if mqtt_client is not None:
        mqtt_client.stop()


app = FastAPI(title="BMS IoT PT MIXITECH GRAHA TEKNIK", lifespan=lifespan)


# ----------------------------------------------------------
# WebSocket endpoint (dashboard lokal) [n 7mxJPuDFSXZcXd]
# ----------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    log.info("Client WebSocket terhubung (total %d)", len(hub.clients))
    try:
        await ws.send_json(hub.state)
        while True:
            text = await ws.receive_text()
            await hub.handle_ws_command(ws, text)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.clients.discard(ws)
        log.info("Client WebSocket terputus (total %d)", len(hub.clients))


# ----------------------------------------------------------
# REST API: histori log (dibaca halaman Logging dashboard lokal)
# Data bersumber dari backend/logs/events.jsonl (penyimpanan lokal Mini PC)
# ----------------------------------------------------------
@app.get("/api/logs")
async def api_logs():
    return hub.load_persisted_logs(limit=200)


# ----------------------------------------------------------
# REST API: export CSV histori (dipakai dashboard LOKAL saja;
# dashboard remote memakai jalur MQTT chunked di serial_hub)
# ----------------------------------------------------------
def _export_csv_response(csv_text: str, filename: str) -> Response:
    # UTF-8 BOM: Excel (regional Indonesia, delimiter ';') mengenali encoding
    # otomatis tanpa Text to Columns. saveBlob di frontend juga idempotent.
    if not csv_text.startswith("\ufeff"):
        csv_text = "\ufeff" + csv_text
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="%s"' % filename},
    )


def _parse_export_range(from_s: str, to_s: str):
    df = hub._parse_date(from_s)
    dt = hub._parse_date(to_s)
    if df is None or dt is None or dt < df:
        return None, None
    # M1 fix: cegak batas yang sama dengan jalur MQTT (serial_hub) & kalender
    # frontend. Tanpa ini, request langsung dengan rentang bertahun-tahun
    # memaksa backend memuat & menggabungkan seluruh file log bulanan ke
    # memori di event loop (kiosk membeku / RAM menumpuk di Mini PC 24/7).
    if (dt - df).days > csv_export.CSV_MAX_RANGE_DAYS:
        return None, None
    return df, dt


@app.get("/api/logs/export")
async def api_logs_export(
    from_s: str = Query(..., alias="from"),
    to_s: str = Query(..., alias="to"),
):
    df, dt = _parse_export_range(from_s, to_s)
    if df is None:
        return Response(
            content="rentang tanggal tidak valid (format: YYYY-MM-DD)",
            status_code=400, media_type="text/plain; charset=utf-8",
        )
    csv_text, n_rows = csv_export.export_logs_csv(df, dt)
    if n_rows == 0:
        return Response(
            content=csv_export.CSV_EMPTY_MESSAGE,
            status_code=404, media_type="text/plain; charset=utf-8",
        )
    return _export_csv_response(
        csv_text, "log_export_%s_to_%s.csv" % (df.isoformat(), dt.isoformat())
    )


@app.get("/api/pzem/export")
async def api_pzem_export(
    from_s: str = Query(..., alias="from"),
    to_s: str = Query(..., alias="to"),
):
    df, dt = _parse_export_range(from_s, to_s)
    if df is None:
        return Response(
            content="rentang tanggal tidak valid (format: YYYY-MM-DD)",
            status_code=400, media_type="text/plain; charset=utf-8",
        )
    csv_text, n_rows = csv_export.export_pzem_csv(df, dt)
    if n_rows == 0:
        return Response(
            content=csv_export.CSV_EMPTY_MESSAGE,
            status_code=404, media_type="text/plain; charset=utf-8",
        )
    return _export_csv_response(
        csv_text, "grafik_pompa_export_%s_to_%s.csv" % (df.isoformat(), dt.isoformat())
    )


# ----------------------------------------------------------
# Frontend statis (dilayani untuk kiosk lokal)
# ----------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(config.INDEX_HTML, media_type="text/html; charset=utf-8")


@app.get("/app.js")
async def app_js():
    return FileResponse(
        config.FRONTEND_DIR / "app.js", media_type="text/javascript"
    )


@app.get("/style.css")
async def style_css():
    return FileResponse(
        config.FRONTEND_DIR / "style.css", media_type="text/css"
    )


@app.get("/manifest.json")
async def manifest_json():
    return FileResponse(
        config.FRONTEND_DIR / "manifest.json",
        media_type="application/manifest+json",
    )


@app.get("/sw.js")
async def sw_js():
    return FileResponse(
        config.FRONTEND_DIR / "sw.js", media_type="text/javascript"
    )


app.mount(
    "/icons",
    StaticFiles(directory=config.FRONTEND_DIR / "icons"),
    name="icons",
)


app.mount(
    "/assets",
    StaticFiles(directory=config.FRONTEND_DIR / "assets"),
    name="assets",
)


if __name__ == "__main__":
    uvicorn.run(app, host=config.HOST, port=config.PORT)
# srvbind: qEmDetqCH6q6Iq
