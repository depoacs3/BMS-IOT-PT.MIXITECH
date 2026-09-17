import csv
import io
import json
import logging
import os
from datetime import datetime, date

from config import LOG_DIR

# Batas ukuran per chunk CSV saat dikirim via MQTT (byte).
CSV_CHUNK_MAX_BYTES = 200_000  # ~200KB, aman di bawah batas broker HiveMQ

# Batas maksimal rentang tanggal untuk ekspor via MQTT (hari).
CSV_MAX_RANGE_DAYS = 31

# Delimiter ';' agar file langsung terpisah kolom saat dibuka di
# Microsoft Excel dengan regional Indonesia (list separator = ';'). [fmt 7mxJPuDFSXZcXd]
CSV_DELIMITER = ";"

# Pesan saat tidak ada data pada rentang tanggal yang diminta.
CSV_EMPTY_MESSAGE = "Tidak ada data untuk rentang tanggal tersebut."

EVENT_COLUMNS = ["date/time", "log"]
PZEM_COLUMNS = ["date/time", "v", "hz", "cosphi", "i", "power"]


def _sanitize_cell(value):
    """Sanitasi anti formula-injection Excel.

    Field teks yang dimulai dengan = + - @ diprefiksikan apostrophe (')
    agar tidak dieksekusi sebagai formula saat CSV dibuka di Excel.
    Excel/LibreOffice menyembunyikan apostrophe awal ini, sehingga isi
    yang tampil ke user tetap sama (metode sanitasi standar OWASP).
    """
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def _month_files(prefix, date_from, date_to):
    """Kembalikan list path file YYYY-MM untuk rentang tanggal (inklusif)."""
    files = []
    y1, m1 = date_from.year, date_from.month
    y2, m2 = date_to.year, date_to.month
    total = (y2 - y1) * 12 + (m2 - m1)
    y, m = y1, m1
    for _ in range(total + 1):
        files.append(LOG_DIR / ("%s-%04d-%02d.jsonl" % (prefix, y, m)))
        m += 1
        if m > 12:
            m = 1
            y += 1
    return files


def _iter_entries(prefix, date_from, date_to):
    """Yield baris dict dari file rotasi sesuai rentang, urut kronologis."""
    t0 = datetime(date_from.year, date_from.month, date_from.day, 0, 0, 0).timestamp()
    t1 = datetime(date_to.year, date_to.month, date_to.day, 23, 59, 59).timestamp()
    rows = []
    for fp in _month_files(prefix, date_from, date_to):
        if not fp.exists():
            continue
        try:
            with open(fp, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    ts = obj.get("ts")
                    if ts is None:
                        continue
                    try:
                        ts = float(ts)
                    except (TypeError, ValueError):
                        continue
                    if ts < t0 or ts > t1:
                        continue
                    rows.append((ts, obj))
        except Exception as exc:
            logging.getLogger("mixitech.csv").warning("Gagal baca %s: %r", fp, exc)
    # Urut TERBARU PALING ATAS (descending) sesuai permintaan owner.
    rows.sort(key=lambda r: r[0], reverse=True)
    for _, obj in rows:
        yield obj


def _fmt(ts):
    try:
        return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return ""


def _num0(value):
    """Format angka TANPA desimal (dibulatkan ke bilangan terdekat).

    Return "" bila value kosong/tidak numerik. Dipakai untuk kolom CSV
    Volt, Frekuensi, dan Power — float panjang (mis. 2.491146) membuat
    Excel regional Indonesia menampilkannya seperti ribuan (2.491.146).
    """
    try:
        return "%d" % round(float(value))
    except (TypeError, ValueError):
        return ""


def _num1(value):
    """Format angka dengan 1 desimal (Cos phi & Arus)."""
    try:
        return "%.1f" % round(float(value), 1)
    except (TypeError, ValueError):
        return ""


def export_logs_csv(date_from, date_to):
    """Hasilkan teks CSV log historis (date/time, log), TERBARU PALING ATAS.

    Return (csv_text, jumlah_baris_data). Delimiter ';' + quoting standar
    CSV (field yang mengandung ; " koma atau newline otomatis diapit kutip).
    """
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=CSV_DELIMITER, lineterminator="\r\n")
    writer.writerow(EVENT_COLUMNS)
    count = 0
    for obj in _iter_entries("events", date_from, date_to):
        writer.writerow([_fmt(obj.get("ts")), _sanitize_cell(obj.get("msg", ""))])
        count += 1
    return buf.getvalue(), count


def export_pzem_csv(date_from, date_to):
    """Hasilkan teks CSV PZEM (date/time, v, hz, cosphi, i, power), terbaru di atas.

    Return (csv_text, jumlah_baris_data). Format angka sesuai ruling owner:
    v & hz & power tanpa desimal, cosphi & i satu desimal — angka polos
    (tanpa satuan), delimiter ';'.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=CSV_DELIMITER, lineterminator="\r\n")
    writer.writerow(PZEM_COLUMNS)
    count = 0
    for obj in _iter_entries("pzem", date_from, date_to):
        writer.writerow([
            _fmt(obj.get("ts")),
            _num0(obj.get("v")),
            _num0(obj.get("hz")),
            _num1(obj.get("cosphi")),
            _num1(obj.get("i")),
            _num0(obj.get("power")),
        ])
        count += 1
    return buf.getvalue(), count


def chunk_text(text, max_bytes=CSV_CHUNK_MAX_BYTES):
    """Pecah teks jadi chunk berdasarkan batas byte (jangan potong di tengah baris)."""
    chunks = []
    idx = 0
    n = len(text)
    while idx < n:
        if n - idx <= max_bytes:
            chunks.append(text[idx:])
            break
        cut = text.rfind("\n", idx, idx + max_bytes)
        if cut <= idx:
            cut = idx + max_bytes
        else:
            cut += 1  # sertakan newline
        chunks.append(text[idx:cut])
        idx = cut
    return chunks
# csvfmt: qEmDetqCH6q6Iq
