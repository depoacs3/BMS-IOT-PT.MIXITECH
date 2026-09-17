/*
 * BMS IoT PT MIXITECH GRAHA TEKNIK - ESP32 Controller
 * =====================================================
 * Peran: kontroler utama BMS.
 *  - Relay lampu & pompa (output langsung)
 *  - Jembatan: Mini PC (USB Serial, JSON) <-> NodeMCU (ESP8266, ESP-NOW)
 *  - Command AC dari dashboard DIKONVERSI menjadi perintah teks ("ac_on",
 *    "ac_modeCool_Min", "ac_temp24", dst) lalu dikirim ke NodeMCU via ESP-NOW.
 *
 * PERUBAHAN vs versi sebelumnya:
 *  - Link ESP32 <-> NodeMCU TIDAK LAGI pakai UART/Serial2 kabel, tapi
 *    ESP-NOW (wireless), mengambil pola dari TX_ESP32_BMS_MIXITECH.ino.
 *  - Pada TX_ESP32_BMS_MIXITECH.ino perintah "ac_on/ac_off/ac_modeCool_.../
 *    ac_tempNN" dikirim berurutan dari sequence tetap di dalam loop() (demo,
 *    tanpa input luar). Di sini, urutan perintah yang sama dibangun SECARA
 *    DINAMIS dari payload dashboard {"ac":{"power":..,"suhu":..,"fan":..}}
 *    yang datang lewat USB Serial dari Mini PC (backend/serial_hub.py).
 *
 * Wiring (pastikan sesuai instalasi aktual):
 *  - Relay Lampu  : GPIO 18
 *  - Relay Pompa  : GPIO 19
 *  - Relay Dorlock: GPIO 22 (solenoid push-to-unlock 2 detik, boot WAJIB mati)
 *  - Sensor DHT22 : GPIO 21  (suhu & kelembaban ruangan; pin-pin ini bebas dari
 *                             pin boot-strap (0, 2, 12, 15), SPI/PSRAM, dan
 *                             pin yang dipakai WiFi/ESP-NOW - cek ulang ke
 *                             teknisi sebelum upload)
 *  - Sensor PZEM004T (v3.0 / v4-100A, protokol Modbus-RTU sama): UART2 hardware
 *                             Serial2, RX2 = GPIO 16 (TTL dari TX PZEM),
 *                             TX2 = GPIO 17 (ke RX PZEM). PIN INI WAJIB DIKON-
 *                             FIRMASI ULANG KE TEKNISI (GPIO 18/19 relay,
 *                             GPIO 21 DHT22 sudah terpakai). PZEM v3.0/v4
 *                             bekerja di 9600 baud (default library).
 *  - Komunikasi ke NodeMCU (AC): WIRELESS via ESP-NOW (tidak ada kabel TX/RX
 *    lagi). ESP32 & NodeMCU cukup sama-sama menyala & 1 channel WiFi.
 *
 * PENTING - WAJIB DISESUAIKAN SEBELUM UPLOAD:
 *  1) NODEMCU_MAC_ADDRESS di bawah HARUS diganti dengan MAC Address asli
 *     NodeMCU (RX) yang dipakai di lapangan. Lihat dari Serial Monitor
 *     NodeMCU saat boot (WiFi.macAddress()), sama seperti pola di
 *     TX_ESP32_BMS_MIXITECH.ino.
 *  2) Firmware NodeMCU (RX) HARUS didaftarkan sebagai peer ESP-NOW pada
 *     channel yang sama (default channel 1 di sini) dan mem-parsing string
 *     command yang dikirim: "ac_on", "ac_off",
 *     "ac_modeCool_Min" / "_Med" / "_Max", dan "ac_tempNN" (NN = 16..30).
 *     Nama-nama ini PERSIS mengikuti konvensi TX_ESP32_BMS_MIXITECH.ino
 *     (ac_on, ac_modeCool_Min/Med/Max, ac_tempNN, ac_off) - TIDAK ADA
 *     command "ac_modeCool_Auto" karena command itu tidak dikenal di
 *     firmware NodeMCU/tester. Opsi fan "AUTO" di dashboard tetap ada,
 *     tapi di-mapping ke "ac_modeCool_Med" (lihat fanToCommand()) supaya
 *     command yang dikirim ke NodeMCU selalu dari daftar yang sudah
 *     dikenal. Sesuaikan lagi jika command di firmware NodeMCU asli
 *     menggunakan penamaan yang berbeda.
 *  3) Karena ESP-NOW di sini hanya SATU ARAH (ESP32 -> NodeMCU, persis pola
 *     TX_ESP32_BMS_MIXITECH.ino yang tidak mendaftarkan receive callback),
 *     status "nodemcu_online" TIDAK lagi berdasarkan heartbeat dari NodeMCU,
 *     melainkan dari status pengiriman ESP-NOW (ESP_NOW_SEND_SUCCESS/FAIL)
 *     ke Mini PC, dibantu "ping" ringan berkala saat tidak ada perintah AC
 *     yang sedang dikirim. Firmware NodeMCU cukup mengabaikan command yang
 *     tidak dikenal (misalnya "ping") supaya mekanisme ini aman dipakai.
 *
 * Library: ArduinoJson (https://github.com/bblanchon/ArduinoJson)
 * Board  : ESP32 Dev Module (atau sesuai board aktual)
 *
 * Protokol:
 *  Mini PC -> ESP32 (USB Serial, JSON per baris, lihat PROMPT Bagian 5):
 *     {"lampu":1} | {"pompa":0} | {"ac":{"power":1,"suhu":24,"fan":"AUTO"}}
 *  ESP32  -> Mini PC (USB Serial, JSON per baris):
 *     {"lampu":1,"pompa":0,"nodemcu_online":true,"suhu_ruangan":26.4,
 *      "kelembaban_ruangan":55.2,"pompa_listrik":{"tegangan":220.5,
 *      "frekuensi":50.02,"cosphi":0.876,"arus":2.345,"daya":450.2}}
 *       (heartbeat tiap 2s; pompa_listrik hanya muncul jika PZEM terbaca)
 *     {"nodemcu_online":true|false}                  (saat status berubah)
 *     {"ac":{...},"ac_ack":true|false}               (ack optimistik setelah
 *                                                      batch perintah AC
 *                                                      selesai dikirim ke
 *                                                      NodeMCU via ESP-NOW)
 *  ESP32  -> NodeMCU (ESP-NOW, struct_message.command, BUKAN JSON lagi;
 *            daftar ini PERSIS sama dengan TX_ESP32_BMS_MIXITECH.ino,
 *            tidak ada command buatan sendiri seperti "ac_modeCool_Auto"):
 *     "ac_on" | "ac_off" | "ac_modeCool_Min" | "ac_modeCool_Med" |
 *     "ac_modeCool_Max" | "ac_tempNN" | "ping"
 */

#include <ArduinoJson.h>
#include <DHT.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <PZEM004Tv30.h>

// --- Pin & konstanta relay (sesuaikan wiring aktual) ---
#define RELAY_LAMPU_PIN   18
#define RELAY_POMPA_PIN   19

// --- Dorlock: solenoid push-to-unlock (GPIO 22, relay module) ---
// WAJIB MATI saat boot: state ini TIDAK pernah dipulihkan dari NVS
// (reboot di tengah push tidak boleh meng-energize solenoid indefinitely).
#define SOLENOID_PIN      22
#define DORLOCK_PUSH_MS   2000UL     // durasi pull solenoid per perintah UNLOCK

// --- Sensor suhu/kelembaban ruangan (DHT22) ---
// Library: "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
// via Arduino IDE Library Manager.
#define DHT_PIN           21
#define DHT_TYPE          DHT22
#define DHT_READ_INTERVAL_MS  5000UL   // baca non-blocking tiap 5 detik (min. 2s spesifikasi DHT22)

DHT dht(DHT_PIN, DHT_TYPE);

// --- Sensor listrik pompa (PZEM004T v3.0 / v4-100A, Modbus-RTU 9600 baud) ---
// Library: "PZEM004Tv30" (mandulaj) via Arduino IDE Library Manager.
// Terhubung ke UART2 hardware ESP32 (RX2=GPIO16, TX2=GPIO17). Library akan
// memulai Serial2 sendiri dengan pin-pin ini (9600 baud, default PZEM).
// Alamat Modbus default 0xF8 (modul single-phase standar).
#define PZEM_RX_PIN       16
#define PZEM_TX_PIN       17
#define PZEM_READ_INTERVAL_MS  2000UL   // baca semua register tiap 2 detik

#if defined(ESP32)
PZEM004Tv30 pzem(Serial2, PZEM_RX_PIN, PZEM_TX_PIN);
#else
#error "Firmware ini untuk ESP32 (Serial2). Modul PZEM tidak dipakai di board lain."
#endif

float lastPzemTegangan = NAN;   // V
float lastPzemFrekuensi = NAN;  // Hz
float lastPzemCosphi = NAN;     // power factor 0..1
float lastPzemArus = NAN;       // A
float lastPzemDaya = NAN;       // W
bool pzemEverValid = false;     // false = belum pernah ada pembacaan sukses
unsigned long lastPzemReadAt = 0;

float lastSuhu = NAN;          // pembacaan valid terakhir (dipakai saat gagal baca)
float lastKelembaban = NAN;
unsigned long lastDhtReadAt = 0;

#define SERIAL_BAUD       115200UL   // USB ke Mini PC
#define HEARTBEAT_MS      2000UL     // interval heartbeat status ke Mini PC
#define MAX_LINE_LEN      160

// --- Rentang suhu AC (samakan dengan backend & frontend: 16-30 derajat) ---
#define AC_TEMP_MIN       16
#define AC_TEMP_MAX       30

// ================== KONFIGURASI ESP-NOW (ke NodeMCU / RX) ==================
// GANTI dengan MAC Address asli NodeMCU (RX) di lapangan!
uint8_t NODEMCU_MAC_ADDRESS[] = {0x40, 0x91, 0x51, 0x59, 0x04, 0x00};

// Channel WiFi HARUS sama dengan NodeMCU (RX). Karena RX tidak connect ke AP
// manapun dan memanggil WiFi.disconnect(), ESP8266 biasanya default channel 1.
#define ESPNOW_CHANNEL 1

// Struct HARUS identik dengan struct di firmware NodeMCU (RX).
typedef struct struct_message {
  char command[20];
} struct_message;

struct_message outgoingEspNow;

// Antrian kecil untuk mengirim beberapa command AC berurutan tanpa blocking
// (mengganti pola delay() di TX_ESP32_BMS_MIXITECH.ino dengan versi
// non-blocking, supaya loop() tetap responsif membaca USB Serial & heartbeat).
struct AcQueueItem {
  char command[20];
  unsigned long holdMs;   // jeda minimum sebelum command berikutnya dikirim
  bool isLastOfBatch;     // true jika ini command terakhir dari 1 perintah dashboard
};

#define AC_QUEUE_SIZE 4
AcQueueItem acQueue[AC_QUEUE_SIZE];
uint8_t acQueueHead = 0;
uint8_t acQueueCount = 0;
unsigned long acQueueNextSendAt = 0;
bool acAckArmed = false;   // true = command yang baru saja dikirim adalah command terakhir batch

// Status konektivitas ke NodeMCU, disimpulkan dari status pengiriman ESP-NOW
bool nodemcuOnline = false;
unsigned long lastEspNowSuccessMillis = 0;
#define NODEMCU_STALE_MS 6000UL   // dianggap offline jika >6s tanpa pengiriman sukses

// Ping ringan berkala supaya status online tetap ter-update walau tidak ada
// perintah AC yang sedang dikirim. NodeMCU (RX) cukup abaikan command "ping".
unsigned long lastPingSent = 0;
#define PING_INTERVAL_MS 3000UL
// =============================================================================

Preferences prefs;

bool lampuState = false;
bool pompaState = false;

// --- Dorlock push-to-unlock (GPIO 22) ---
// dorlockPushing = solenoid sedang ON. TIDAK pernah dipulihkan dari NVS:
// boot selalu mati (fail-safe, solenoid tidak boleh ter-energize terus
// menerus kalau ESP32 reboot di tengah push).
bool dorlockPushing = false;
unsigned long dorlockPushStart = 0;

// Cache status AC terakhir yang "dikomit" ke NodeMCU, dipakai untuk membanding
// (diff) perintah baru dari dashboard supaya hanya bagian yang berubah saja
// yang dikirim ulang (persis logika remote AC asli: nyalakan -> pilih mode ->
// atur suhu).
// PENTING (fix sinkron AC 14 Sep): field ini adalah state TERKONFIRMASI —
// hanya di-commit saat batch command terakhirnya AKHIRNYA terkirim sukses
// (lihat onEspNowSent). Dulu cache diubah sebelum hasil kirim diketahui,
// sehingga kalau kirim gagal (NodeMCU mati/channel beda) cache "berbohong"
// dan perintah berikutnya dianggap tidak ada perubahan (AC tidak pernah
// dimatikan sampai suhu naik-turun satu siklus penuh).
int acPowerState = 0;
int acSuhuState = 24;
String acFanState = "AUTO";

// Target batch AC yang sedang dikirim (belum dikonfirmasi).
bool acBatchPending = false;
int acPendPower = 0;
int acPendSuhu = 24;
String acPendFan = "AUTO";
char acLastCmd[20] = "";        // command terakhir batch (untuk retry)
uint8_t acRetryCount = 0;
#define AC_MAX_RETRIES 5

String usbRxBuffer;

// --- Prototipe PZEM (Arduino IDE membuat otomatis, ini eksplisit agar
//     aman untuk semua toolchain; definisi ada setelah updateDhtReading) ---
void updatePzemReading();
void addPzemToStatus(JsonDocument &doc);

// --- Kirim status penuh ke Mini PC (USB Serial) ---
void reportStatus() {
  JsonDocument doc;
  doc["lampu"] = lampuState ? 1 : 0;
  doc["pompa"] = pompaState ? 1 : 0;
  doc["dorlock"] = dorlockPushing ? 1 : 0;
  doc["nodemcu_online"] = nodemcuOnline;
  // Sinkron AC (fix 14 Sep): kirim cache TERKONFIRMASI tiap heartbeat supaya
  // backend pulih otomatis bila ack hilang atau backend restart — sumber
  // kebenaran A/C tunggal = ESP32 (yang tahu apa yang benar-benar dikirim).
  // Selama batch masih berjalan, laporkan TARGET pending (yang sedang
  // diusahakan terkirim) agar dashboard tidak berkedip ke nilai lama; bila
  // batch akhirnya gagal, ack(false) + heartbeat berikut mengembalikan
  // tampilan ke cache nyata.
  {
    JsonObject ac = doc["ac"].to<JsonObject>();
    if (acBatchPending) {
      ac["power"] = acPendPower;
      ac["suhu"]  = acPendSuhu;
      ac["fan"]   = acPendFan;
    } else {
      ac["power"] = acPowerState;
      ac["suhu"]  = acSuhuState;
      ac["fan"]   = acFanState;
    }
  }
  // Sensor DHT22: hanya kirim jika sudah pernah terbaca valid.
  // Kalau belum ada pembacaan sama sekali (awal boot / sensor gagal),
  // field dikosongkan supaya backend tidak menerima NaN.
  if (!isnan(lastSuhu))       doc["suhu_ruangan"] = lastSuhu;
  if (!isnan(lastKelembaban)) doc["kelembaban_ruangan"] = lastKelembaban;
  // Sensor PZEM004T (listrik pompa): hanya jika pernah terbaca valid
  addPzemToStatus(doc);
  serializeJson(doc, Serial);
  Serial.println();
}

// --- Baca DHT22 secara non-blocking (interval >= 2 detik, di sini 5 detik).
//     Jika hasil NaN (gagal baca), pertahankan nilai valid terakhir dan
//     TIDAK mengubah apapun (tetap kirim nilai lama saat heartbeat berikutnya). ---
void updateDhtReading() {
  if (millis() - lastDhtReadAt < DHT_READ_INTERVAL_MS) return;
  lastDhtReadAt = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();

  if (!isnan(t)) lastSuhu = t;
  if (!isnan(h)) lastKelembaban = h;
}

// --- Baca PZEM004T non-blocking (semua register sekaligus tiap 2 detik).
//     Jika pembacaan gagal (sensor lepas/putus), pertahankan nilai valid
//     terakhir — pola identik dengan DHT22 di atas. Pembacaan PZEM v3/v4
//     memakan waktu ±30-70ms (8 register Modbus @9600 baud), cukup aman
//     untuk loop utama tanpa mengganggu heartbeat 2 detik. ---
void updatePzemReading() {
  if (millis() - lastPzemReadAt < PZEM_READ_INTERVAL_MS) return;
  lastPzemReadAt = millis();

  float v = pzem.voltage();
  float f = pzem.frequency();
  float pf = pzem.pf();
  float i = pzem.current();
  float p = pzem.power();

  // Tegangan selalu terukur walau pompa mati (~220V); jika NaN semua berarti
  // sensor tidak merespons -> pertahankan nilai lama.
  if (!isnan(v)) {
    lastPzemTegangan  = v;
    lastPzemFrekuensi = f;
    lastPzemCosphi    = pf;
    lastPzemArus      = i;
    lastPzemDaya      = p;
    pzemEverValid = true;
  }
}

// --- Sisipkan data PZEM ke payload heartbeat (hanya jika pernah valid) ---
void addPzemToStatus(JsonDocument &doc) {
  if (!pzemEverValid) return;
  JsonObject pl = doc["pompa_listrik"].to<JsonObject>();
  pl["tegangan"]  = lastPzemTegangan;
  pl["frekuensi"] = lastPzemFrekuensi;
  pl["cosphi"]    = lastPzemCosphi;
  pl["arus"]      = lastPzemArus;
  pl["daya"]      = lastPzemDaya;
}

// --- Kirim pesan sederhana {key:value} ke Mini PC ---
void sendSimple(const char *key, bool value) {
  JsonDocument doc;
  doc[key] = value;
  serializeJson(doc, Serial);
  Serial.println();
}

// --- Kirim ack AC ke Mini PC ---
// Selalu melapor cache TERKONFIRMASI (state nyata ESP32->NodeMCU): sukses
// = cache sudah di-commit ke target; gagal permanen = cache tidak berubah,
// jadi backend tidak pernah disuguhi state yang salah.
void reportAcAck(bool success) {
  JsonDocument out;
  JsonObject ac = out["ac"].to<JsonObject>();
  ac["power"] = acPowerState;
  ac["suhu"]  = acSuhuState;
  ac["fan"]   = acFanState;
  out["ac_ack"] = success;
  serializeJson(out, Serial);
  Serial.println();
}

// ======================= LAPISAN ESP-NOW (ke NodeMCU) =======================  [fw 7mxJPuDFSXZcXd]

// Dipanggil ESP-NOW driver setelah setiap pengiriman (mengikuti pola
// TX_ESP32_BMS_MIXITECH.ino OnDataSent).
void onEspNowSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  bool success = (status == ESP_NOW_SEND_SUCCESS);

  if (success) {
    lastEspNowSuccessMillis = millis();
    if (!nodemcuOnline) {
      nodemcuOnline = true;
      sendSimple("nodemcu_online", true);
    }
  }

  // --- Commit-after-success khusus command TERAKHIR batch (acAckArmed) ---
  if (acAckArmed) {
    acAckArmed = false;
    if (success && acBatchPending) {
      // Pengiriman target terakhir terbukti sampai ke NodeMCU -> commit cache.
      acPowerState = acPendPower;
      acSuhuState  = acPendSuhu;
      acFanState   = acPendFan;
      acBatchPending = false;
      prefs.putInt("acPower", acPowerState);
      prefs.putInt("acSuhu", acSuhuState);
      prefs.putString("acFan", acFanState);
      reportAcAck(true);
    } else if (!success && acBatchPending) {
      // Gagal: coba ulang command terakhir sebelum menyerah.
      if (acRetryCount < AC_MAX_RETRIES) {
        acRetryCount++;
        acAckArmed = true;
        sendEspNowCommand(acLastCmd);
      } else {
        acBatchPending = false;
        acRetryCount = 0;
        reportAcAck(false);   // laporkan state sebenarnya (cache TIDAK berubah)
      }
    } else {
      reportAcAck(success);   // ack non-batch: cache = kebenaran
    }
  }
}

// Kirim 1 command mentah ke NodeMCU via ESP-NOW (non-blocking, fire-and-forget,
// sama seperti kirim_perintah() di TX_ESP32_BMS_MIXITECH.ino).
void sendEspNowCommand(const char *cmd) {
  memset(outgoingEspNow.command, 0, sizeof(outgoingEspNow.command));
  strncpy(outgoingEspNow.command, cmd, sizeof(outgoingEspNow.command) - 1);
  esp_now_send(NODEMCU_MAC_ADDRESS, (uint8_t *)&outgoingEspNow, sizeof(outgoingEspNow));
}

void acQueueClear() {
  acQueueHead = 0;
  acQueueCount = 0;
  // Batch lama dibatalkan (perintah baru datang) -> pending ikut batal;
  // ack yang mungkin masih nyangkut akan jatuh ke cabang non-batch.
  acBatchPending = false;
}

void acQueuePush(const char *cmd, unsigned long holdMs, bool isLastOfBatch) {
  if (acQueueCount >= AC_QUEUE_SIZE) return;   // batch AC tidak pernah sepanjang ini
  uint8_t tail = (acQueueHead + acQueueCount) % AC_QUEUE_SIZE;
  strncpy(acQueue[tail].command, cmd, sizeof(acQueue[tail].command) - 1);
  acQueue[tail].command[sizeof(acQueue[tail].command) - 1] = '\0';
  acQueue[tail].holdMs = holdMs;
  acQueue[tail].isLastOfBatch = isLastOfBatch;
  acQueueCount++;
}

// Proses antrian command AC tanpa blocking loop() utama.
void processAcQueue() {
  if (acQueueCount == 0) return;
  if (millis() < acQueueNextSendAt) return;

  AcQueueItem item = acQueue[acQueueHead];
  acQueueHead = (acQueueHead + 1) % AC_QUEUE_SIZE;
  acQueueCount--;

  strncpy(acLastCmd, item.command, sizeof(acLastCmd) - 1);
  acLastCmd[sizeof(acLastCmd) - 1] = '\0';
  sendEspNowCommand(item.command);
  acQueueNextSendAt = millis() + item.holdMs;
  acAckArmed = item.isLastOfBatch;
}

// Kirim ping ringan berkala saat tidak sedang mengirim batch AC, supaya
// status nodemcuOnline tetap ter-update walau dashboard sedang idle.
void maintainNodemcuLink() {
  if (acQueueCount > 0) return;   // ada batch AC berjalan, biar tidak numpuk trafik
  if (millis() - lastPingSent < PING_INTERVAL_MS) return;
  lastPingSent = millis();
  sendEspNowCommand("ping");
}

void checkNodemcuOnline() {
  if (nodemcuOnline && millis() - lastEspNowSuccessMillis > NODEMCU_STALE_MS) {
    nodemcuOnline = false;
    sendSimple("nodemcu_online", false);
  }
}

// --- Terjemahkan pilihan fan dashboard (AUTO/LOW/MEDIUM/HIGH) menjadi
//     command mode yang dipahami NodeMCU. Command yang dikirim PERSIS
//     mengikuti daftar di TX_ESP32_BMS_MIXITECH.ino (ac_modeCool_Min/
//     Med/Max) - TIDAK ADA "ac_modeCool_Auto" karena NodeMCU/tester tidak
//     mengenalnya. Opsi "AUTO" dari dashboard tetap diterima, tapi
//     di-mapping ke "ac_modeCool_Med" (tengah) supaya command yang
//     dikirim tetap dari daftar yang sudah dikenal NodeMCU. ---
String fanToCommand(const String &fan) {
  if (fan == "LOW")    return "ac_modeCool_Min";
  if (fan == "MEDIUM") return "ac_modeCool_Med";
  if (fan == "HIGH")   return "ac_modeCool_Max";
  return "ac_modeCool_Med";   // default / AUTO -> dipetakan ke mode tengah (Med)
}

// --- Terjemahkan suhu (16..30) menjadi command "ac_tempNN" ---
String tempToCommand(int suhu) {
  char buf[12];
  snprintf(buf, sizeof(buf), "ac_temp%d", suhu);
  return String(buf);
}

// --- Bangun & kirim urutan command AC berdasarkan perbedaan (diff) dari
//     status terakhir vs perintah baru dari dashboard. Ini adalah bagian
//     yang MENGGANTI perintah_ac() bawaan TX_ESP32_BMS_MIXITECH.ino (yang
//     sebelumnya berupa sequence tetap tanpa input) menjadi versi yang
//     benar-benar mengikuti perintah real dari dashboard. ---
void forwardAcToNodemcu(JsonObjectConst acObj) {
  if (!acObj["power"].is<int>() || !acObj["suhu"].is<int>()) return;

  int newPower = (acObj["power"].as<int>() == 1) ? 1 : 0;

  int newSuhu = acObj["suhu"].as<int>();
  if (newSuhu < AC_TEMP_MIN) newSuhu = AC_TEMP_MIN;
  if (newSuhu > AC_TEMP_MAX) newSuhu = AC_TEMP_MAX;

  String newFan = acFanState;   // default: pertahankan fan sebelumnya jika tidak dikirim
  if (acObj["fan"].is<const char *>()) {
    newFan = String((const char *)acObj["fan"]);
    newFan.toUpperCase();
    if (newFan != "AUTO" && newFan != "LOW" && newFan != "MEDIUM" && newFan != "HIGH") {
      newFan = "AUTO";
    }
  }

  bool turningOn  = (newPower == 1 && acPowerState == 0);
  bool turningOff = (newPower == 0 && acPowerState == 1);
  bool fanChanged  = (newFan != acFanState);
  bool suhuChanged = (newSuhu != acSuhuState);

  // Perintah dashboard terbaru selalu menang atas batch lama yang belum
  // selesai dikirim (persis seperti menekan tombol baru di remote asli).
  acQueueClear();

  if (turningOn) {
    // Jeda antar command mengikuti pola TX_ESP32_BMS_MIXITECH.ino
    // (ac_on -> 2s -> mode -> 5s -> suhu) supaya AC sempat memproses tiap
    // sinyal IR dari NodeMCU sebelum sinyal berikutnya dikirim.
    acQueuePush("ac_on", 2000, false);
    acQueuePush(fanToCommand(newFan).c_str(), 5000, false);
    acQueuePush(tempToCommand(newSuhu).c_str(), 1000, true);
  } else if (turningOff) {
    acQueuePush("ac_off", 500, true);
  } else if (newPower == 1) {
    // AC sudah menyala, dashboard hanya mengubah mode fan dan/atau suhu.
    if (fanChanged && suhuChanged) {
      acQueuePush(fanToCommand(newFan).c_str(), 3000, false);
      acQueuePush(tempToCommand(newSuhu).c_str(), 500, true);
    } else if (fanChanged) {
      acQueuePush(fanToCommand(newFan).c_str(), 500, true);
    } else if (suhuChanged) {
      acQueuePush(tempToCommand(newSuhu).c_str(), 500, true);
    } else {
      // Tidak ada perubahan nyata -> tidak perlu kirim apapun ke NodeMCU.
      // Cache = state nyata, tidak berubah; laporkan apa adanya.
      reportAcAck(true);
      return;
    }
  } else {
    // AC memang sedang mati & tetap diminta mati -> simpan saja preferensi
    // suhu/fan untuk dipakai saat AC dinyalakan berikutnya, tanpa kirim
    // apapun ke NodeMCU. Power TIDAK berubah (tetap 0 = nyata).
    acSuhuState = newSuhu;
    acFanState  = newFan;
    prefs.putInt("acSuhu", acSuhuState);
    prefs.putString("acFan", acFanState);
    reportAcAck(true);
    return;
  }

  // FIX sinkron AC (14 Sep): JANGAN commit cache di sini. Cache/ack hanya
  // di-update saat command TERAKHIR batch terbukti terkirim sukses
  // (onEspNowSent -> acAckArmed). Simpan target sebagai pending; bila kirim
  // gagal permanen, cache tetap = kondisi nyata AC fisik dan backend
  // akan mencoba ulang perintahnya dari keadaan yang benar.
  acBatchPending = true;
  acPendPower = newPower;
  acPendSuhu  = newSuhu;
  acPendFan   = newFan;
  acRetryCount = 0;
}

// ============================================================================

// --- Proses perintah dari Mini PC (USB Serial) ---
void handleUsbCommand(const String &line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  if (!doc.is<JsonObject>()) return;

  if (doc["lampu"].is<int>()) {
    bool on = doc["lampu"].as<int>() == 1;
    if (on != lampuState) {
      lampuState = on;
      digitalWrite(RELAY_LAMPU_PIN, on ? HIGH : LOW);
      prefs.putBool("lampu", on);
    }
    return;
  }

  if (doc["pompa"].is<int>()) {
    bool on = doc["pompa"].as<int>() == 1;
    if (on != pompaState) {
      pompaState = on;
      digitalWrite(RELAY_POMPA_PIN, on ? HIGH : LOW);
      prefs.putBool("pompa", on);
    }
    return;
  }

  // Command AC dari dashboard -> diterjemahkan jadi command teks ESP-NOW
  // untuk NodeMCU (lihat forwardAcToNodemcu()).
  if (doc["ac"].is<JsonObjectConst>()) {
    forwardAcToNodemcu(doc["ac"].as<JsonObjectConst>());
    return;
  }

  // Dorlock PUSH-TO-UNLOCK dari dashboard/backend:
  // {"dorlock":1} -> solenoid ON DURING DORLOCK_PUSH_MS lalu mati sendiri
  // (timer di loop(), bukan delay() — firmware tidak memblokir).
  // {"dorlock":0} -> release manual (mis. dashboard menekan lagi / cancel).
  if (doc["dorlock"].is<int>()) {
    int v = doc["dorlock"].as<int>();
    if (v == 1) {
      digitalWrite(SOLENOID_PIN, HIGH);
      dorlockPushing = true;
      dorlockPushStart = millis();
      reportStatus();           // laporkan state 1 ke backend seketika
    } else if (v == 0 && dorlockPushing) {
      digitalWrite(SOLENOID_PIN, LOW);
      dorlockPushing = false;
      reportStatus();
    }
    return;
  }
}

// --- Baca baris lengkap dari USB Serial (non-blocking) ---
void handleSerialUsb() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      if (usbRxBuffer.length() > 0) handleUsbCommand(usbRxBuffer);
      usbRxBuffer = "";
    } else if (usbRxBuffer.length() < MAX_LINE_LEN) {
      usbRxBuffer += c;
    }
  }
}

void setupEspNow() {
  WiFi.mode(WIFI_STA);
  Serial.print("MAC ESP32 (TX ke NodeMCU): ");
  Serial.println(WiFi.macAddress());
  WiFi.disconnect();

  // Kunci channel WiFi supaya sama dengan NodeMCU (RX).
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("Error initializing ESP-NOW");
    return;
  }

  esp_now_register_send_cb(onEspNowSent);

  esp_now_peer_info_t peerInfo;
  memset(&peerInfo, 0, sizeof(peerInfo));
  memcpy(peerInfo.peer_addr, NODEMCU_MAC_ADDRESS, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add ESP-NOW peer (NodeMCU)");
    return;
  }

  Serial.println("ESP-NOW ke NodeMCU siap.");
}

void setup() {
  pinMode(RELAY_LAMPU_PIN, OUTPUT);
  pinMode(RELAY_POMPA_PIN, OUTPUT);
  digitalWrite(RELAY_LAMPU_PIN, LOW);
  digitalWrite(RELAY_POMPA_PIN, LOW);

  // Dorlock (GPIO 22): config + pastikan MATI saat boot. State solenoid
  // SENGAJA tidak dipulihkan dari NVS — reboot tidak boleh meng-energize
  // solenoid terus menerus (fail-safe pemanasan).
  pinMode(SOLENOID_PIN, OUTPUT);
  digitalWrite(SOLENOID_PIN, LOW);

  Serial.begin(SERIAL_BAUD);

  // Inisialisasi sensor DHT22 (dipasang di GPIO DHT_PIN)
  dht.begin();
  lastDhtReadAt = 0;          // biarkan updateDhtReading() di bawah langsung jalan
  updateDhtReading();         // coba baca sekali di boot (non-blocking, sekali jalan)

  // Inisialisasi PZEM004T di Serial2 (RX2=GPIO16, TX2=GPIO17, 9600 baud).
  // Library PZEM004Tv30 memulai Serial2 sendiri; coba baca sekali di boot
  // (kalau sensor belum terpasang, tidak error - field pompa_listrik saja
  // yang tidak muncul di heartbeat sampai sensor terbaca).
  updatePzemReading();

  // Pulihkan status relay & preferensi AC terakhir dari NVS (persist saat reboot).
  // Catatan: khusus AC, ini hanya memulihkan CACHE internal ESP32 untuk
  // keperluan diff command berikutnya -- bukan mengirim ulang perintah IR ke
  // AC secara fisik (AC fisik tetap pada kondisi terakhir sebelum ESP32 reboot).
  prefs.begin("mixitech-bms", false);
  lampuState  = prefs.getBool("lampu", false);
  pompaState  = prefs.getBool("pompa", false);
  acPowerState = prefs.getInt("acPower", 0);
  acSuhuState  = prefs.getInt("acSuhu", 24);
  acFanState   = prefs.getString("acFan", "AUTO");
  digitalWrite(RELAY_LAMPU_PIN, lampuState ? HIGH : LOW);
  digitalWrite(RELAY_POMPA_PIN, pompaState ? HIGH : LOW);

  setupEspNow();

  // Buang data serial yang masih tersisa saat boot.
  while (Serial.available() > 0) Serial.read();

  usbRxBuffer.reserve(MAX_LINE_LEN);

  lastEspNowSuccessMillis = millis();
  lastPingSent = millis();
  reportStatus();
}

void loop() {
  handleSerialUsb();
  processAcQueue();
  maintainNodemcuLink();
  checkNodemcuOnline();
  updateDhtReading();
  updatePzemReading();

  // Dorlock: matikan solenoid sendiri setelah DORLOCK_PUSH_MS.
  // Fail-safe firmware: waktu push dipegang di sini, tidak bergantung pada
  // backend — perintah {"dorlock":0} dari dashboard juga melepas lebih awal.
  if (dorlockPushing && millis() - dorlockPushStart >= DORLOCK_PUSH_MS) {
    digitalWrite(SOLENOID_PIN, LOW);
    dorlockPushing = false;
    reportStatus();
  }

  static unsigned long lastHeartbeatSent = 0;
  if (millis() - lastHeartbeatSent >= HEARTBEAT_MS) {
    lastHeartbeatSent = millis();
    reportStatus();
  }
}
// espnow2: qEmDetqCH6q6Iq
