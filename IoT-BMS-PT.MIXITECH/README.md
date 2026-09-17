# BMS IoT — PT MIXITECH GRAHA TEKNIK

Building Management System berbasis IoT untuk mengontrol 1 Lampu, 1 Pompa Air, 1 Pintu (Doorlock), dan 1 AC Panasonic, yang bisa dikontrol dari dashboard lokal (touchscreen kiosk di Mini PC) dan dashboard remote (web di iot.mixitech.co.id) secara bersamaan dan tetap sinkron. Notifikasi penting (peringatan pompa & peringatan maintenance Running Hours) dikirim otomatis ke grup Telegram (lihat bab 14).

Rentang suhu AC: 16°C – 30°C (step 1°C).

Master Password: 1030
User Password: 7595

---

## DAFTAR ISI

- [Arsitektur Singkat]
- [Kebutuhan Hardware & Software]

1. [Instalasi Python di Windows]
2. [Persiapan File Proyek di Mini PC]
3. [Membuat Virtual Environment (venv)]
4. [Konfigurasi .env (Kredensial HiveMQ & COM Port)]
5. [Instalasi Dependency Python]
6. [Konfigurasi HiveMQ Cloud (1 User Full Akses)]
7. [Menentukan COM Port ESP32 di Windows]
8. [Menjalankan Backend Manual (Pertama Kali)]
9. [Auto-Start 24/7 — BIOS, Task Scheduler, Kiosk]
10. [BIOS: Auto Power On Saat Ada Listrik]
11. [Auto Login Windows]
12. [Uji Coba Menyeluruh]
13. [Kredensial & Keamanan]
14. [Setup Notifikasi Telegram — BotFather & Chat ID Grup]
15. [Pemecahan Masalah]
16. [Flash Firmware ESP32]
17. [Sinkronisasi Kredensial MQTT (Backend + Frontend + Hosting)]
18. [Perawatan Disk & Arsip Log]
19. [Reset Master Password]

---

## Arsitektur Singkat

```
[Dashboard Remote (iot.mixitech.co.id)] --MQTT/WSS--> [HiveMQ Cloud] --MQTT/TLS--> [Backend Mini PC]
[Dashboard Lokal (kiosk)] ---WebSocket localhost:8000---> [Backend Mini PC] --USB Serial--> [ESP32] --ESP-NOW (wireless)--> [NodeMCU] --IR--> [AC Panasonic]
```

- Mini PC (backend Python/FastAPI) adalah satu-satunya jembatan antara serial dan internet.
- ESP32 menangani relay lampu & pompa, meneruskan command AC ke NodeMCU.
- NodeMCU (ESP8266) mengirim kode IR Panasonic ke AC.
- Backend adalah single source of truth: status hanya di-update setelah dikonfirmasi ESP32.

---

## Kebutuhan Hardware & Software

### Hardware
| Item | Keterangan |
|------|-----------|
| Mini PC (Windows 10/11) | Bisa PC biasa, NUC, atau thin client |
| ESP32 Dev Board | Untuk relay lampu, pompa, doorlock, dan sensor DHT22 |
| NodeMCU ESP8266 | Untuk IR AC Panasonic |
| AC Panasonic | Model modern (protokol Panasonic) |
| Kabel USB | Micro USB / USB-C untuk ESP32 |
| Solenoid Doorlock + relay | Doorlock push-to-unlock (relay GPIO22) |
| Sensor PZEM004T | Listrik pompa: tegangan, frekuensi, cos φ, arus |

### Software
| Software | Fungsi |
|----------|--------|
| Python 3.10–3.12 | Runtime backend |
| Google Chrome | Kiosk mode dashboard |
| Git (opsional) | Clone repository |
| Arduino IDE (opsional) | Upload firmware ke ESP32/NodeMCU |

---

## 1. Instalasi Python di Windows

### 1.1 Download Python

1. Buka browser, kunjungi [https://www.python.org/downloads/](https://www.python.org/downloads/)
2. Klik tombol Download Python 3.12.x (pilih versi 3.10–3.12, 64-bit)
3. File installer akan terdownload (misal: `python-3.12.4-amd64.exe`)

### 1.2 Install Python — WAJIB centang "Add to PATH"

1. Klik kanan file installer → Run as Administrator
2. **PENTING:** Di halaman pertama installer, centang kotak:
   ```
   ☑ Add python.exe to PATH
   ```
3. Klik Install Now
4. Tunggu sampai selesai → klik Close
5. **Verifikasi instalasi:**
   - Buka Command Prompt (CMD) — tekan `Win + R`, ketik `cmd`, Enter
   - Ketik perintah:
     ```cmd
     python --version
     ```
   - Harus muncul: `Python 3.12.x`
   - Jika muncul error `'python' is not recognized`, berarti PATH belum terdaftar:
     - Buka System Properties → Environment Variables
     - Di System variables, cari `Path` → Edit
     - Tambahkan:
       - `C:\Users\NamaUser\AppData\Local\Programs\Python\Python312\`
       - `C:\Users\NamaUser\AppData\Local\Programs\Python\Python312\Scripts\`
     - Klik OK, buka CMD baru, verifikasi ulang

6. **Verifikasi pip:**
   ```cmd
   python -m pip --version
   ```
   Harus muncul versi pip.

---

## 2. Persiapan File Proyek di Mini PC

### 2.1 Copy/Mindah Folder Proyek

1. Copy seluruh folder `BMS-IOT-PT.MIXITECH` ke Mini PC
   - Bisa via USB flashdisk, network share, atau Git clone
   - Letakkan di lokasi mudah, misal: `C:\BMS-IOT-PT.MIXITECH\`

### 2.2 Struktur Folder (pastikan lengkap)

```
BMS-IOT-PT.MIXITECH/        (zip deploy mengekstrak folder "BMS-IoT-MIXITECH")
├── backend/
│   ├── main.py              # FastAPI: /ws, /api/logs(+export), /api/pzem/export
│   ├── config.py            # Topik MQTT, path file, variabel .env
│   ├── serial_hub.py        # Single source of truth + notifikasi Telegram
│   ├── mqtt_client.py       # Paho MQTT (publish state + request/response)
│   ├── csv_export.py        # Generator CSV (delimiter ';', BOM, CRLF)
│   ├── security.py          # PBKDF2 + brute-force lock (password user)
│   ├── telegram_client.py   # Konfigurasi Telegram (bot_token + chat_id)
│   ├── clear_retained_dorlock.py
│   ├── requirements.txt     # (termasuk certifi untuk TLS Telegram)
│   ├── .env                 # kredensial asli (JANGAN di-share)
│   ├── .env.example         # template tanpa kredensial
│   ├── telegram_config.json # bot_token + chat_id (diisi via PENGATURAN)
│   ├── security.json        # hash password user (PBKDF2)
│   ├── automation_rules.json
│   ├── running_hours.json
│   └── logs/                # events-YYYY-MM.jsonl + pzem-YYYY-MM.jsonl
├── frontend/
│   ├── index.html           # SPA satu file (semua halaman)
│   ├── app.js
│   ├── style.css
│   ├── manifest.json, sw.js, icons/   # PWA kiosk
│   └── assets/              # gambar panel (pump, dorlock, logo)
├── firmware/
│   └── esp32/esp32_main/esp32_main.ino  # relay + DHT22 + PZEM + ESP-NOW
└── deployment/
    ├── install.bat          # venv + dependency (sekali)
    ├── register_tasks.bat   # Task Scheduler auto-start (Run as Admin)
    ├── start_backend.bat
    ├── start_kiosk.bat
    └── kiosk_loader.html
```

---

## 3. Membuat Virtual Environment (venv)

Virtual environment (venv) mengisolasi library Python proyek ini dari sistem. Hanya perlu dilakukan sekali.

1. Buka Command Prompt
2. Masuk ke folder backend:
   ```cmd
   cd C:\BMS-IOT-PT.MIXITECH\backend
   ```
   (Sesuaikan path sesuai letak folder Anda)

3. Buat virtual environment:
   ```cmd
   python -m venv venv
   ```
   Folder `venv\` akan terbuat di dalam `backend\`.

4. Aktivasi venv:
   ```cmd
   venv\Scripts\activate
   ```
   Jika berhasil, muncul `(venv)` di awal baris CMD.

5. Update pip (penting untuk kompatibilitas):
   ```cmd
   python -m pip install --upgrade pip
   ```

---

## 4. Konfigurasi .env (Kredensial HiveMQ & COM Port)

File `.env` menyimpan konfigurasi runtime. Jangan di-commit ke Git (sudah di `.gitignore`).

### 4.1 Buka File .env

Buka `backend\.env` dengan Notepad atau editor teks:

```ini
# ----- Server FastAPI -----
HOST=0.0.0.0
PORT=8000

# ----- Serial Mini PC <-> ESP32 -----
SERIAL_PORT=COM4
SERIAL_BAUD=115200

# ----- HiveMQ Cloud -----
MQTT_HOST=.s1.eu.hivemq.cloud
MQTT_PORT=8883
# User MQTT (satu-satunya, full akses) - dipakai backend & dashboard browser
MQTT_USER=
MQTT_PASS=

# ----- Keamanan (password) -----
MASTER_PASSWORD=
AUTH_MAX_FAILS=5
AUTH_LOCK_SECONDS=60

# ----- Sensor PZEM (Grafik Pompa + timeout arus) -----
PZEM_DUMMY_MODE=false              # true = simulator, false = sensor asli
PZEM_PERSIST_INTERVAL_SECONDS=1.5
PZEM_DUMMY_INTERVAL_SECONDS=1.5
PZEM_DEMO_WAVE=false

# ----- Telegram (opsional) -----
# Isi HANYA jika log backend memunculkan error
# "SSL: CERTIFICATE_VERIFY_FAILED" (SSL inspection jaringan kantor).
# Lihat bab 14.6.
TELEGRAM_CA_BUNDLE=
```

> **Catatan:** Bot Token & Chat ID Telegram TIDAK disimpan di `.env` melainkan di
> `backend/telegram_config.json` (diisi lewat halaman PENGATURAN — lihat bab 14).

### 4.2 Yang Perlu Disesuaikan

| Variabel | Keterangan |
|----------|-----------|
| `SERIAL_PORT` | Ganti `COM4` dengan port COM ESP32 yang sebenarnya (lihat langkah 7) |
| `MQTT_HOST` | Host cluster HiveMQ Cloud Anda (domain `.s1.eu.hivemq.cloud`) |
| `MQTT_USER` | Username HiveMQ Anda (1 user saja, full akses) |
| `MQTT_PASS` | Password HiveMQ Anda |

> **Catatan:** Jika belum punya akun/kredensial HiveMQ, lihat langkah 6 dulu.

---

## 5. Instalasi Dependency Python

Setelah venv aktif (muncul `(venv)`), jalankan:

```cmd
pip install -r requirements.txt
```

Ini akan menginstal:
- `fastapi` — web framework
- `uvicorn[standard]` — ASGI server
- `pyserial` — komunikasi serial ESP32
- `paho-mqtt` — MQTT client HiveMQ
- `python-dotenv` — baca file .env
- `certifi` — CA bundle untuk koneksi TLS ke Telegram (verifikasi SSL)

---

## 6. Konfigurasi HiveMQ Cloud (1 User Full Akses)

### 6.1 Buat Akun HiveMQ Cloud

1. Buka [https://www.hivemq.com/cloud/](https://www.hivemq.com/cloud/)
2. Klik Start Free → daftar dengan email
3. Setelah login, buat New Cluster (pilih free tier)

### 6.2 Buat User (1 User Full Akses)

1. Di dashboard HiveMQ Cloud, klik Access Management
2. Klik Add User
3. Isi:
   - Username: ``
   - Password: `` (atau ganti dengan password yang lebih kuat)
4. Role: Pilih Administrator (full akses, bisa publish & subscribe semua topik)
5. Klik Add User

### 6.3 Salin Host Cluster

1. Di dashboard HiveMQ Cloud, klik Cluster Details
2. Salin Host (misal: `.s1.eu.hivemq.cloud`)
3. Tempel ke `backend/.env` → `MQTT_HOST`

### 6.4 Masukkan Kredensial ke File

#### backend/.env
```ini
MQTT_HOST=.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=
MQTT_PASS=
```

#### frontend/app.js (bagian CONFIG)
```javascript
mqtt: {
  host: ".s1.eu.hivemq.cloud",
  port: 8884,
  path: "/mqtt",
  username: "",
  password: ""
}
```

> **Catatan:** Port dashboard browser pakai 8884 (WebSocket TLS), bukan 8883 (TCP TLS).

---

## 7. Menentukan COM Port ESP32 di Windows

### 7.1 Colok ESP32 ke Mini PC

1. Colok kabel USB ESP32 ke port USB Mini PC
2. Tunggu driver terinstall (CH340G atau CP2102 biasanya otomatis)

### 7.2 Cek COM Port di Device Manager

1. Tekan `Win + X` → Device Manager
2. Cari Ports (COM & LPT)
3. Cari perangkat yang bertuliskan:
   - `USB Serial Port (COMx)` — untuk CH340
   - `Silicon Labs CP210x USB to UART Bridge (COMx)` — untuk CP2102
4. Catat nomor COM-nya, misal: COM5

### 7.3 Ubah di .env

Buka `backend\.env`, ubah:

```ini
SERIAL_PORT=COM5
```

### 7.4 Jika COM Port Tidak Muncul

- Coba ganti kabel USB (beberapa kabel hanya untuk power)
- Install driver manual:
  - CH340: [https://www.wch.cn/download/CH341SER_EXE.html](https://www.wch.cn/download/CH341SER_EXE.html)
  - CP2102: [https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)

---

## 8. Menjalankan Backend Manual (Pertama Kali)

### 8.1 Aktivasi venv & Jalankan

```cmd
cd C:\BMS-IOT-PT.MIXITECH\backend
venv\Scripts\activate
python main.py
```

Jika berhasil, akan muncul:
```
12:00:00 [INFO] mixitech: Backend BMS IoT siap di http://0.0.0.0:8000 (WebSocket /ws)
12:00:00 [INFO] mixitech.serial: Reader serial dimulai -> target COM5
12:00:00 [INFO] mixitech.mqtt: MQTT terhubung ke 83104ec4cbd44006be258886de761d35.s1.eu.hivemq.cloud:8883
```

### 8.2 Buka Dashboard Lokal

1. Buka Chrome, ketik: `http://localhost:8000`
2. Dashboard akan muncul. Jika ESP32 sudah terhubung, status akan hijau.

### 8.3 Test Kendali

- Klik tombol Lampu → relay ESP32 akan ON/OFF
- Klik tombol Pompa → relay ESP32 akan ON/OFF
- Klik tombol AC + ubah suhu (16°C–30°C) → NodeMCU akan mengirim IR ke AC

### 8.4 Matikan Backend

Tekan `Ctrl + C` di CMD untuk menghentikan backend.

---

## 9. Auto-Start 24/7 — BIOS, Task Scheduler, Kiosk

### 9.1 Jalankan install.bat (Sekali)

```cmd
cd C:\BMS-IOT-PT.MIXITECH\deployment
install.bat
```

Script ini akan:
- Cek Python sudah terinstal
- Buat venv jika belum ada
- Install semua dependency
- Precompile .pyc untuk start lebih cepat

### 9.2 Jalankan register_tasks.bat (Sebagai Administrator)

1. Klik kanan `register_tasks.bat` → Run as Administrator
2. Baca peringatan — pastikan akun yang login saat ini adalah akun yang akan auto-login nantinya
3. Tekan Enter untuk melanjutkan
4. Script ini akan:
   - Mendaftarkan Task Scheduler `BMSMixitech-Backend` yang berjalan saat boot sebagai SYSTEM
   - Membuat shortcut di Startup folder untuk kiosk Chrome

### 9.3 Verifikasi Task Terdaftar

1. Buka Task Scheduler (ketik `taskschd.msc` di Run)
2. Cari task `BMSMixitech-Backend`
3. Pastikan: Run whether user is logged on or not, Run with highest privileges

---

## 10. BIOS: Auto Power On Saat Ada Listrik

Ini agar Mini PC otomatis menyala ketika listrik menyala (misal setelah mati lampu).

### 10.1 Masuk BIOS

1. Restart Mini PC
2. Segera tekan tombol masuk BIOS (biasanya: Del, F2, F10, atau Esc)
3. Tergantung merk motherboard, berikut istilah yang dicari:

### 10.2 Cari Pengaturan Power Recovery

| Merk / BIOS | Istilah | Setting |
|-------------|---------|---------|
| AMI BIOS | Power Management → Restore on AC Power Loss | Power On |
| Award BIOS | Power Management Setup → AC Power Loss Recovery | Enabled |
| ASUS | Advanced → APM Configuration → Power On By Ring/PCIe | Enabled |
| Gigabyte | Power Management → AC BACK | Always On / Power On |
| MSI | Settings → Advanced → Wake Up Event Setup → Resume By AC Power Loss | Enabled |
| Intel NUC | Power → After Power Failure | Last State atau Power On |
| Advantech / Industrial | Advanced → Miscellaneous Configuration → Power On after Power Failure | Enabled |

### 10.3 Simpan & Keluar

1. Tekan F10 → Save & Exit
2. Mini PC akan restart. Sekarang jika listrik mati lalu hidup, Mini PC akan otomatis menyala.

---

## 11. Auto Login Windows

Agar Mini PC login otomatis tanpa perlu memasukkan password setiap kali restart.

### 11.1 Buka netplwiz

1. Tekan `Win + R`, ketik: `netplwiz`, Enter
2. Pilih akun yang akan dipakai
3. Hapus centang pada: `Users must enter a user name and password to use this computer`
4. Klik Apply
5. Masukkan password akun dua kali → OK

### 11.2 Verifikasi Auto-Start

1. Restart Mini PC
2. Setelah login otomatis + muncul desktop, Chrome akan terbuka dalam mode kiosk menampilkan dashboard
3. Backend sudah berjalan sejak boot (via Task Scheduler)

---

## 12. Uji Coba Menyeluruh

### 12.1 Saat Listrik Padam & Menyala Kembali

1. Listrik padam → Mini PC mati
2. Listrik menyala → Mini PC auto ON (BIOS setting)
3. Windows boot → auto login
4. Task Scheduler menjalankan `start_backend.bat` → backend Python berjalan
5. Startup folder menjalankan `start_kiosk.bat` → Chrome kiosk terbuka
6. Kiosk loader akan polling `http://localhost:8000` sampai backend siap
7. Dashboard muncul → kontrol siap digunakan

### 12.2 Uji Rentang Suhu AC

1. Buka dashboard
2. Tekan tombol + suhu → suhu naik bertahap 1°C per step, maksimal 30°C
3. Tekan tombol - suhu → suhu turun, minimal 16°C
4. Pastikan AC merespon perubahan suhu

---

## 13. Kredensial & Keamanan

- Hanya 1 user MQTT (`bms_mixietech001`) dengan hak full akses.
- User ini dipakai oleh backend (di `.env`) dan dashboard browser (di `app.js`).
- Kredensial di `backend/.env` jangan di-commit atau di-share file mentahnya.
- `backend/.env.example` adalah template tanpa kredensial asli.
- Token bot Telegram disimpan di `backend/telegram_config.json` (bukan di `.env`), dan tidak
  pernah dikirim utuh ke frontend — hanya preview tersensor. Cara membuatnya: bab 14.

---

## 14. Setup Notifikasi Telegram — BotFather & Chat ID Grup

Backend mengirim notifikasi otomatis ke grup Telegram untuk dua peringatan ini (tampil juga sebagai
log merah di halaman Logging):

| Peringatan | Pemicu |
|---|---|
| `PERINGATAN POMPA` | Pompa menyala tetapi arus tidak pernah mencapai ambang minimum dalam durasi timeout (pompa kering/bermasalah) |
| `PERINGATAN TIMEOUT A/C` | A/C menyala melewati durasi timeout tetapi suhu ruangan belum mencapai target (A/C boros/lemah) |
| `PERINGATAN MAINTENANCE` | Running Hours perangkat (Lampu/Pompa/A/C/Doorlock) mencapai 0 — waktunya maintenance |

Semua pesan berawalan `[BMS IoT]`. Ikuti langkah 14.1 → 14.5 sekali saja saat instalasi.

### 14.1 Membuat Bot lewat BotFather

1. Buka aplikasi Telegram (HP atau desktop).
2. Cari @BotFather di kolom pencarian (pastikan akunnya terverifikasi centang biru), atau buka
   langsung: `https://t.me/BotFather`. BotFather adalah bot resmi Telegram untuk membuat bot.
3. Tekan tombol START (atau kirim perintah `/start`).
4. Kirim perintah:
   ```
   /newbot
   ```
5. BotFather meminta nama bot — ini nama tampilan, bebas. Contoh:
   ```
   BMS IoT Mixitech
   ```
6. BotFather meminta username bot — harus unik di seluruh Telegram dan wajib diakhiri `bot`
   (tanpa spasi). Contoh:
   ```
   bms_mixitech_bot
   ```
7. BotFather membalas dengan pesan selamat datang yang berisi token API, formatnya:
   ```
   1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   - Angka sebelum `:` = ID bot; bagian setelah `:` = secret.
   - Salin dan simpan token ini (dipakai di 14.4). Token = kendali penuh atas bot:
     JANGAN dibagikan ke luar tim / di-upload ke tempat publik.
8. Perintah BotFather yang berguna nanti:
   - `/mybots` → kelola bot Anda
   - `/revoke` → buat token BARU (token lama otomatis mati — dipakai bila token ter-kebocoran)
   - `/deletebot` → hapus bot

### 14.2 Membuat Grup & Memasukkan Bot

1. Di Telegram, buat grup baru: Menu → New Group. Beri nama, contoh: `MIXITECH BMS`.
2. Tambahkan anggota: minimal Anda sendiri, lalu invite bot yang tadi dibuat
   (ketik `@bms_mixitech_bot` di kolom anggota).
3. Disarankan jadikan bot admin grup (Info grup → Edit → Administrators → Add Admin):
   - Bot admin tidak akan terhapus otomatis dan bisa mengirim pesan tanpa batas.
   - Bot admin juga dapat membaca semua pesan grup — ini memudahkan langkah 14.3.

### 14.3 Mengambil Chat ID Grup

> Chat ID grup selalu angka negatif; supergroup berawalan `-100...`. Angka inilah yang
> diketik ke halaman PENGATURAN (bukan nama grup, bukan username).

**Cara A — lewat browser (paling cepat):**

1. Pastikan bot sudah menjadi anggota grup (idealnya admin), lalu kirim satu pesan apa pun di
   grup (misal: `tes`) supaya grup muncul di daftar update bot.
2. Buka browser (Chrome di PC), ketik URL berikut — ganti `<TOKEN>` dengan token dari 14.1:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   (perhatikan ada kata `bot` langsung menempel sebelum token)
3. Browser menampilkan JSON. Cari blok yang berisi `"chat"`:
   ```json
   "chat":{"id":-1004498214085,"title":"MIXITECH BMS","type":"supergroup"}
   ```
4. Salin nilai `"id"`-nya → itulah Chat ID grup (contoh di atas: `-1004498214085`).

   *Jika halaman kosong / `{"result":[]}`:* kirim ulang pesan di grup lalu refresh halaman;
   atau matikan dulu Privacy Mode bot (lihat 14.7); atau gunakan Cara B.

**Cara B — lewat bot penghitung ID (tanpa getUpdates):**

1. Invite salah satu bot penghitung ID ke grup, misal `@getidsbot` atau `@RawDataBot`.
2. Bot langsung membalas di grup dengan data grup, termasuk `Id: -100XXXXXXXXXX`.
3. Catat angkanya, lalu keluarkan bot penghitung itu dari grup agar grup tetap bersih.

### 14.4 Memasukkan Token & Chat ID ke Dashboard

1. Buka dashboard → menu → PENGATURAN (ikon gear).
2. Isi dua field:
   - Bot Token: hasil dari 14.1 (format `1234567890:AAHxxx...`)
   - Chat/Group ID: hasil dari 14.3 (format `-100XXXXXXXXXX`, diawali minus)
   (Field diisi lewat keyboard on-screen — kiosk touchscreen.)
3. Tekan SIMPAN. Backend menyimpannya ke `backend/telegram_config.json`:
   ```json
   {
     "bot_token": "1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
     "chat_id": "-1004498214085"
   }
   ```
   Setelah tersimpan, halaman PENGATURAN hanya menampilkan token tersensor (`••••xxxx`) — token
   penuh tidak pernah dikirim balik ke browser.
4. Alternatif tanpa dashboard: buat/edit `backend/telegram_config.json` manual dengan format di
   atas, lalu restart backend.

### 14.5 Menguji Notifikasi

- Tes langsung dari browser (tanpa lewat backend) — pastikan token & chat id benar:
  ```
  https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Tes%20BMS%20IoT
  ```
  (spasi ditulis `%20`). Jika pesan muncul di grup → token & chat id sudah benar.
- Tes lewat sistem: buka halaman Running Hours, set Set Time perangkat ke nilai kecil
  (mis. `0.1` jam) via SIMPAN, biarkan counter habis → `PERINGATAN MAINTENANCE` muncul di halaman
  Logging DAN masuk ke grup Telegram sebagai `[BMS IoT] PERINGATAN MAINTENANCE: ...`. Jangan lupa
  tekan RESET (atau SIMPAN Set Time normal lagi) setelah selesai uji.
- Pengiriman otomatis dilakukan backend dengan verifikasi SSL penuh + retry 2x untuk gangguan
  jaringan/timeout. Jika gagal, muncul log peringatan "Notifikasi Telegram gagal terkirim" di
  halaman Logging.

### 14.6 Jika Muncul Error SSL di Jaringan Kantor (SSL Inspection)

**Gejala:** log backend memunculkan `[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in
certificate chain` atau pesan di halaman Logging:
`Notifikasi Telegram gagal: verifikasi sertifikat SSL gagal (kemungkinan SSL inspection)...`

**Penyebab:** antivirus/firewall kantor "menyadup" HTTPS (SSL inspection) sehingga sertifikat
Telegram ditandatangani CA internal gedung yang tidak dikenal Python.

**Solusi (tanpa mematikan verifikasi SSL):**

1. Minta/ekspor root certificate gedung dalam format PEM (.pem) dari admin jaringan, atau
   ekspor sendiri dari browser yang sudah dipercaya jaringan tersebut (Details sertifikat → Copy
   to File → Base-64 encoded X.509 (.CER), simpan sebagai `.pem`).
2. Simpan di Mini PC, misal `C:\certs\corporate-root-ca.pem`.
3. Buka `backend\.env`, isi:
   ```ini
   TELEGRAM_CA_BUNDLE=C:\certs\corporate-root-ca.pem
   ```
4. Restart backend. Backend memuat CA standar (certifi) plus file tersebut. Jika path salah,
   backend tetap jalan dengan CA standar dan mencatat peringatan di log.

> Verifikasi SSL tidak pernah dinonaktifkan oleh sistem ini — jangan pula memakai solusi
> "disable verify" karena membuka celah MITM.

### 14.7 Bot Tidak Menerima Pesan Grup (Privacy Mode)

Bukan penghalang untuk MENGIRIM notifikasi, tapi bisa menggagalkan langkah 14.3 Cara A (bot tidak
melihat pesan grup di `getUpdates`):

1. Di BotFather: `/mybots` → pilih bot → Bot Settings → Group Privacy → Turn off.
2. Setelah diubah, remove bot dari grup lalu invite ulang (aturan privacy baru berlaku setelah
   bot masuk lagi).
3. Alternatif tanpa mengubah privacy: jadikan bot admin grup (14.2 langkah 3) — admin selalu
   melihat semua pesan.

---

## Struktur Folder

Struktur lengkap folder proyek (dengan komentar per file) sudah ditunjukkan di bab 2.2 — gunakan
daftar itu sebagai acuan saat memeriksa kelengkapan deploy di Mini PC.

---

## 15. Pemecahan Masalah

| Masalah | Solusi |
|---------|--------|
| `python` tidak dikenali | Python tidak terdaftar di PATH. Lihat langkah 1.2 |
| `venv` gagal dibuat | Pastikan Python 3.10–3.12 dan pip sudah update |
| `pip install` error | Coba: `python -m pip install --upgrade pip` lalu ulang |
| Serial tidak terbaca | Cek COM port di Device Manager, sesuaikan di `.env` |
| MQTT tidak konek | Pastikan host, user, password benar di `.env` dan `app.js` |
| Chrome kiosk tidak muncul | Cek folder Startup, shortcut `BMS-Mixitech-Kiosk` harus ada |
| Auto-start tidak jalan | Buka Task Scheduler, cek task `BMSMixitech-Backend` |
| Listrik mati, Mini PC tidak nyala | Cek pengaturan BIOS (langkah 10) |
| Notifikasi Telegram tidak masuk | Cek token & Chat ID di halaman Pengaturan (bab 14.4/14.5); pastikan bot adalah anggota grup |
| Log: "verifikasi sertifikat SSL gagal" | SSL inspection jaringan kantor — isi `TELEGRAM_CA_BUNDLE` di `.env` (bab 14.6) |
| `getUpdates` kosong saat ambil Chat ID | Kirim pesan di grup dulu, atau matikan Group Privacy (bab 14.7), atau pakai Cara B (14.3) |

---

## 16. Flash Firmware ESP32

File: `firmware/esp32/esp32_main/esp32_main.ino` (board: ESP32 Dev Module). Firmware ini menangani relay Lampu/Pompa/Doorlock, sensor DHT22 & PZEM004T, JEMBATAN perintah A/C ke NodeMCU via ESP-NOW, dan pelaporan heartbeat ke Mini PC lewat USB Serial.

### 16.1 Persiapan Arduino IDE (sekali di laptop teknisi)

1. Install Board package "esp32 by Espressif Systems" (Boards Manager).
2. Install library (Library Manager):
   - `ArduinoJson`
   - `DHT sensor library` (Adafruit) + dependency-nya `Adafruit Unified Sensor`
   - `PZEM004Tv30` (author: mandulaj)
3. Library ESP-NOW (`esp_now.h`, `esp_wifi.h`) dan `Preferences` sudah termasuk board package ESP32 — tidak perlu install terpisah.

### 16.2 Wiring yang didefinisikan firmware (cek fisik sebelum upload)

| Fungsi | Pin | Catatan |
|--------|-----|---------|
| Relay Lampu | GPIO 18 | HIGH = ON |
| Relay Pompa | GPIO 19 | HIGH = ON |
| Relay Doorlock (solenoid) | GPIO 22 | Push-to-unlock, lihat 16.4 |
| DHT22 data | GPIO 21 | baca tiap 5 detik |
| PZEM004T (Modbus-RTU 9600) | RX2 = GPIO 16, TX2 = GPIO 17 | kabel data disilangkan: TX PZEM → GPIO16, RX PZEM → GPIO17 |
| USB ke Mini PC | Serial USB, baud 115200 | satu-satunya jalur perintah dari backend |

Hindari pin boot-strap 0, 2, 12, 15 untuk semua tambahan wiring.

### 16.3 Setting yang WAJIB diperiksa sebelum upload

- `NODEMCU_MAC_ADDRESS` (dekat bagian "KONFIGURASI ESP-NOW"): berisi MAC NodeMCU (RX) unit yang dipakai di lapangan. Jika salah/ketinggalan nilai contoh, SEMUA perintah A/C gagal senyap dan dashboard menampilkan NodeMCU OFFLINE terus — padahal ESP32 & relay sehat. Cara baca MAC NodeMCU: buka Serial Monitor firmware NodeMCU saat boot (mencetak `WiFi.macAddress()`).
- Channel ESP-NOW (`ESPNOW_CHANNEL`, default 1): harus sama dengan channel firmware NodeMCU. Karena NodeMCU tidak connect ke AP manapun, ia biasanya diam di channel 1.
- Rentang suhu A/C di firmware (16–30) sudah dikunci sama dengan backend & frontend — jangan diubah sendiri.

### 16.4 Perilaku penting firmware (untuk diagnosis lapangan)

- Boot selalu aman untuk solenoid: saat power-on/reset, KETIGA relay dipaksa mati dulu, lalu state Lampu & Pompa DIPULIHKAN dari memori internal ESP32 (NVS) — jadi setelah listrik padam-lalu-nyala, lampu/pompa kembali ke kondisi terakhir sebelum mati. Khusus Doorlock, state push SENGAJA tidak pernah dipulihkan (reboot di tengah push tidak boleh membuat solenoid ter-energize terus — solenoid tetap mati).
- Doorlock: perintah `{"dorlock":1}` menahan solenoid ON selama 2 detik lalu mati sendiri (timer non-blocking di dalam firmware, tidak bergantung ke backend). Perintah `{"dorlock":0}` melepas lebih awal.
- Heartbeat JSON ke Mini PC tiap 2 detik berisi state relay, `nodemcu_online`, suhu & kelembaban DHT22, dan `pompa_listrik` (PZEM) hanya jika sensor pernah terbaca. Backend menandai ESP32 OFFLINE jika >10 detik tanpa heartbeat.
- Status NodeMCU disimpulkan dari keberhasilan kirim ESP-NOW (+ ping internal tiap 3 detik saat idle, offline jika >6 detik tanpa kirim sukses). NodeMCU tidak pernah mengirim balik.
- Upload firmware seperti board ESP32 biasa: pilih port COM ESP32 di Arduino IDE → Upload → buka Serial Monitor 115200 untuk melihat `MAC ESP32 (TX ke NodeMCU)` dan pesan `ESP-NOW ke NodeMCU siap.`

### 16.5 Verifikasi setelah flash

1. Colok ESP32 ke Mini PC, set `SERIAL_PORT` benar → log backend memunculkan `ESP32 TERHUBUNG`.
2. Tombol Lampu/Pompa di dashboard → relay bunyi klik, status hijau sesuai.
3. Tombol UNLOCK → solenoid turun ±2 detik lalu naik sendiri.
4. Dashboard remote/lokal menampilkan `NodeMCU` ONLINE (butuh NodeMCU ikut menyala 1 channel).
5. Nilai suhu/kelembaban ruangan muncul; jika PZEM terpasang, tile V/Hz/cosφ/A di Grafik Pompa terisi.

---

## 17. Sinkronisasi Kredensial MQTT (Backend + Frontend + Hosting)

Kredensial HiveMQ yang sama dipakai oleh DUA program berbeda. Jika user/password/host broker diganti, KETIGanya wajib diubah bersamaan — kalau ketinggalan satu, sistem rusak setengah (misal: backend normal tapi dashboard remote gagal connect, atau sebaliknya).

| # | Tempat | File | Isi | Port |
|---|--------|------|-----|------|
| 1 | Backend Mini PC | `backend/.env` | `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASS` | 8883 (MQTT over TLS) |
| 2 | Frontend (sumber) | `frontend/app.js` — blok `CONFIG.mqtt` di awal file | `host`, `port`, `username`, `password` | 8884 (MQTT over WebSocket/TLS) |
| 3 | Hosting remote | folder `frontend/` yang di-deploy ke `iot.mixitech.co.id` | hasil upload ulang SETELAH poin 2 diedit | — |

Prosedur ganti kredensial:

1. Buat user baru di dashboard HiveMQ (Access Management), HAPUS user lama.
2. Edit `backend/.env` di Mini PC → restart backend (Task Scheduler → `BMSMixitech-Backend` → End, lalu Run; atau restart Mini PC).
3. Edit `CONFIG.mqtt` di `frontend/app.js` → deploy ulang folder `frontend/` ke hosting → tekan Ctrl+F5 di browser remote (service worker tidak meng-cache, tapi browser masih bisa menyimpan `app.js` lama).
4. Uji: halaman remote menampilkan status hidup, tombol kontrol bereaksi di sisi Mini PC.

Catatan: jangan ubah `MQTT_PREFIX` (`mixitech/bms`) di `backend/config.py` tanpa menyelaraskan juga blok `CONFIG.topics` di `frontend/app.js` — keduanya harus identik atau broker tidak mempertemukan backend dengan dashboard.

---

## 18. Perawatan Disk & Arsip Log

Semua log ditulis permanen dan TIDAK PERNAH dihapus otomatis (permintaan customer: histori lengkap). Ukurannya tumbuh terus — teknisi yang bertanggung jawab atas pengarsipannya.

| File | Lokasi | Pertumbuhan tipikal |
|------|--------|---------------------|
| Event log (rotasi bulanan) `events-YYYY-MM.jsonl` | `backend/logs/` | kecil — beberapa KB–ratusan KB/bulan, tergantung aktivitas |
| Histori PZEM `pzem-YYYY-MM.jsonl` | `backend/logs/` | terbesar: 1 sampel tiap 1,5 detik ≈ 28.800 baris/hari ≈ 2,3 MB/hari ≈ ±70 MB/bulan |
| Log watchdog backend `backend_run.log` | `deployment/` | tanpa rotasi — append terus sejak task dibuat |

Pedoman:

- Mengarsip: file bulan LALU boleh dipindah (jangan dihapus kalau customer minta histori) ke HDD/backup, misal folder `logs/backup/2026/`. Backend hanya menulis ke file bulan berjalan dan akan membuatnya ulang bila belum ada — jadi memindah file bulan lama selalu aman. Jangan sentuh file bulan berjalan saat backend hidup.
- Halaman Logging & export CSV membaca seluruh file `events-*` yang ADA di folder — makin banyak file di folder, makin lama permintaan histori (masih nyaman sampai tahunan; rutin diarsip = tetap ringan). Export CSV juga dibatasi rentang maks 31 hari per unduhan di semua jalur.
- `backend_run.log`: amankan isinya dulu bila sedang mendiagnosis, lalu boleh dikosongkan (hapus file atau buka Notepad → Save kosong) saat backend sedang di-End — akan dibuat ulang oleh `start_backend.bat`.
- Backup konfigurasi lokasi (sejajar dengan arsip log): `backend/.env`, `backend/security.json`, `backend/automation_rules.json`, `backend/running_hours.json`, `backend/telegram_config.json`. Kehilangan file-file ini = kredensial/PIN/rule/customer hilang; simpan salinan per lokasi di storage internal MIXITECH.
- Cek ketersediaan disk Mini PC secara berkala; dengan ±70 MB/bulan, disk 120 GB baru perlu perhatian serius setelah bertahun-tahun — tapi arsip rutin mencegah kejutan di tempat yang salah (misal disk penuh → gagal tulis log & gagal simpan rule).

---

## 19. Reset Master Password

Master Password (di `backend/.env`, variabel `MASTER_PASSWORD`) adalah kunci terakhir: dipakai di form Ganti Password (halaman Pengaturan) saat User Password lupa, dan otomatis membuka halaman Automation/Running Hours tanpa tercatat sebagai gagal. Master TIDAK tersimpan di `security.json` — hanya ada di `.env`, jadi mengubahnya berarti mengakses fisik Mini PC (sengaja).

### 19.1 Jika lupa User Password (master masih diketahui)

1. Buka halaman dashboard → menu → PENGATURAN.
2. Pada Password Lama, ketik Master Password → isi Password Baru 4–8 digit → SIMPAN. Backend mengenali master di kolom itu dan langsung mereset hash user di `security.json`.

### 19.2 Jika Master Password sendiri yang perlu diganti / lupa total

1. Buka `backend\.env` di Mini PC (perlu akses fisik / remote desktop ke Mini PC).
2. Ganti nilainya pada baris `MASTER_PASSWORD=...` menjadi PIN master baru (angka 4–8 digit).
3. Restart backend: Task Scheduler → task `BMSMixitech-Backend` → End, lalu Run (atau restart Mini PC). Konfigurasi dibaca ulang saat start.
4. Uji di dashboard: buka halaman Running Hours dengan master baru → harus langsung masuk.
5. Bila Master lama lupa total dan `.env` tidak bisa dibuka (misal lupa login Windows Mini PC): pulihkan akses Windows unit lebih dulu (prosedur standar Windows — di luar lingkup proyek), lalu ulangi langkah 1–4.

Catatan keamanan internal: master perbandingan terjadi di backend (`serial_hub.py`) dan tidak pernah dikirim ke browser; nilai default kosong berarti jalur master DINONAKTIFKAN total (hanya User Password yang berlaku). Pastikan `MASTER_PASSWORD` selalu terisi pada file `.env` di unit produksi, karena form ganti-password mengandalkan keberadaan master sebagai satu-satunya recovery jika user lupa PIN.

---

## Deploy Dashboard Remote ke iot.mixitech.co.id

1. Drag-and-drop folder `frontend/` ke iot.mixitech.co.id (static hosting)
2. Pastikan kredensial MQTT di `app.js` sudah benar
3. Dashboard remote bisa diakses di mana saja via internet

---

## Hal yang Perlu Diverifikasi di Hardware

- Model/seri AC Panasonic aktual — firmware NodeMCU memakai asumsi `IRPanasonicAc`
- Pin GPIO aktual sudah di-`#define` di atas tiap file firmware
- **DHT22**: pin data GPIO 21; relay Lampu GPIO 18, relay Pompa GPIO 19, relay Doorlock GPIO 22
  (cek wiring aktual, hindari pin boot-strap 0,2,12,15; solenoid doorlock WAJIB mati saat boot)
- PZEM004T v3.0/v4-100A (listrik pompa): UART2 — RX2 GPIO 16 (dari TX PZEM), TX2 GPIO 17 (ke RX PZEM), 9600 baud; library `PZEM004Tv30`; cek pin ke teknisi (16/17 bebas dari relay/DHT/ESP-NOW)
- COM port ESP32 diatur lewat `.env` (`SERIAL_PORT`)
- Rentang suhu: 16°C – 30°C (step 1°C), sudah diset di backend dan frontend

## Logging & Automation

- Logging (histori event): Semua event (kontrol manual, perubahan automation, status koneksi)
  dicatat dan tersimpan permanen di penyimpanan lokal Mini PC dengan rotasi bulanan
  (`backend/logs/events-YYYY-MM.jsonl` — tidak pernah dihapus otomatis). Setiap entry punya field
  `level` (`info`/`warning`) sehingga halaman Logging men-highlight peringatan dengan warna merah.
  Penyimpanan memakai flush + fsync agar aman dari mati listrik mendadak. Dashboard lokal membaca
  via `GET /api/logs` dan realtime via WebSocket; dashboard remote menerima histori lengkap lewat
  sinkronisasi MQTT chunked (`mixitech/bms/log/sync/request` → `.../response`) dan log realtime via
  topic `mixitech/bms/log`.
- Automation Rule: Aturan AC (threshold suhu), Lampu (jadwal jam), dan Pompa (jadwal jam +
  timeout arus) disimpan di `backend/automation_rules.json` (persisten, atomic write). Eksekusi
  dilakukan di backend setiap 5 detik, bukan di frontend. Saat rule pompa/lampu/AC aktif, kontrol
  manual perangkat terkait terkunci di dashboard (defense-in-depth: backend juga menolak command
  manual). Timeout arus pompa: jika pompa menyala tetapi arus tidak pernah mencapai
  `current_threshold_amp` dalam `timeout_minutes`, backend mencatat log warning DAN mengirim
  notifikasi Telegram.
- Password (Automation Rule & Running Hours): Kedua halaman SELALU meminta password (PIN
  numerik 4–8 digit) setiap kali dibuka — status login tidak pernah diingat frontend. Verifikasi
  dilakukan di backend (`backend/security.json`, PBKDF2 + brute-force lock: 5x gagal → kunci 60
  detik). Password user diatur lewat halaman Pengaturan; jika lupa, gunakan Master Password
  (tersimpan di `backend/.env`) pada form Ganti Password — backend mencocokkan keduanya.

## Fitur Baru (Pengaturan, Running Hours, Grafik, Unduh CSV)

- Halaman PENGATURAN (tidak dikunci password): konfigurasi Telegram (Bot Token + Chat/Group ID,
  disimpan di `backend/telegram_config.json` — file dibuat otomatis saat SIMPAN pertama kali; token
  tidak pernah dikirim balik ke frontend — hanya preview `•••1234`) dan Ganti Password User (isi
  password lama untuk ganti rutin, ATAU Master Password dari `.env` jika lupa — keduanya diverifikasi
  di backend). Panduan lengkap membuat bot sampai ambil Chat ID grup: bab 14. Semua field teks di
  halaman ini diisi lewat keyboard on-screen (QWERTY + layer simbol + shift untuk Bot Token/Chat ID;
  numpad ter-masking untuk PIN) — dirancang untuk kiosk touchscreen Mini PC tanpa keyboard/mouse
  fisik, tanpa memunculkan keyboard Windows.
- Running Hours: penghitung mundur jam operasi per perangkat (Lampu/Pompa/A/C/Doorlock) yang hanya
  turun saat perangkat ON, disimpan di `backend/running_hours.json` (atomic write, persist tiap ~60
  detik). Saat counter mencapai 0 → log warning merah + notifikasi Telegram ke grup. Tombol RESET
  mengembalikan counter ke Set Time; tombol SIMPAN mengubah Set Time sekaligus me-reset counter ke
  nilai baru. Halaman ini dikunci password.
- Grafik PZEM Pompa (tidak dikunci): tile Volt/Hz/Cos φ + grafik Arus & Daya digambar dengan
  `<canvas>` vanilla (tanpa library CDN, tetap jalan saat internet mati). Data bersumber dari state
  `pompa_listrik`. Selama sensor fisik belum terpasang, `PZEM_DUMMY_MODE=true` menjalankan simulator
  di backend; setelah PZEM004T dipasang (UART2 ESP32, field `pompa_listrik` di heartbeat serial),
  cukup set `PZEM_DUMMY_MODE=false` tanpa mengubah kode lain. Grafik dianimasikan mulus:
  render loop terpisah (~30fps) + interpolasi antar-titik + garis kurva + scroll kontinu, dan
  berhenti otomatis saat halaman tidak dibuka (hemat CPU Mini PC 24/7). Selama sensor asli belum
  ada, `PZEM_DEMO_WAVE=true` membuat grafik Arus & Daya terus bergerak (gelombang demo) walau
  pompa MATI — matikan flag ini bersamaan dengan `PZEM_DUMMY_MODE=false` saat sensor terpasang.
- Histori PZEM permanen: backend menyimpan snapshot tiap `PZEM_PERSIST_INTERVAL_SECONDS`
  (default 1,5 detik — setiap sampel live tersimpan) ke `backend/logs/pzem-YYYY-MM.jsonl`
  (rotasi bulanan, tidak pernah dihapus).
- Unduh CSV di halaman Logging & Grafik: pilih rentang tanggal lewat kalender kustom
  (touchscreen, tanpa keyboard), maksimal 31 hari per unduhan. Dashboard lokal mengunduh via REST
  (`GET /api/logs/export`, `GET /api/pzem/export`); dashboard remote menerima CSV via MQTT chunked
  lalu menyimpannya sebagai file dari browser. Baris terbaru berada paling atas (descending).
  Kolom Logging: `date/time;log`; kolom Grafik: `date/time;v;hz;cosphi;i;power` dengan format angka
  yang sama seperti tampilan dashboard: v, hz, power tanpa desimal (dibulatkan); cosphi & i
  satu desimal. File CSV memakai delimiter
  titik-koma (`;`) + encoding UTF-8 dengan BOM agar langsung terpisah kolom saat dibuka di
  Microsoft Excel regional Indonesia (tanpa Text to Columns); field berisi `;`/`"` otomatis
  ter-quote, teks berawalan `= + - @` disanitasi dari formula injection. Jika tidak ada data pada
  rentang yang dipilih, muncul pesan "Tidak ada data untuk rentang tanggal tersebut." — bukan file
  kosong.

### Variabel `.env` baru

| Variabel | Default | Fungsi |
|---|---|---|
| `MASTER_PASSWORD` | (wajib diisi) | Otorisasi ganti password user saat lupa password lama |
| `AUTH_MAX_FAILS` | `5` | Batas percobaan password gagal per scope sebelum terkunci |
| `AUTH_LOCK_SECONDS` | `60` | Durasi kunci sementara setelah batas gagal terlampaui |
| `PZEM_DUMMY_MODE` | `true` | `true` = simulator PZEM; `false` = data asli dari ESP32 |
| `PZEM_PERSIST_INTERVAL_SECONDS` | `1.5` | Interval persist histori PZEM ke disk (detik) |
| `PZEM_DUMMY_INTERVAL_SECONDS` | `1.5` | Interval update nilai dummy live (detik) |
| `PZEM_DEMO_WAVE` | `false` | `true` = gelombang demo agar grafik bergerak walau pompa mati (visualisasi) |
