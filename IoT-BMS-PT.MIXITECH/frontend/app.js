(function () {
  "use strict";

  /* ============================================================
   * BMS IoT PT MIXITECH GRAHA TEKNIK - Dashboard
   * Dual transport:
   *   - WebSocket lokal (ws://<host>:8000/ws) -> PRIORITAS UTAMA
   *   - MQTT (wss://HiveMQ:8884/mqtt)          -> jalur remote
   * ============================================================ */

  // ---- Konfigurasi MQTT (ubah di sini jika cluster berganti) ----
  var CONFIG = {
    mqtt: {
      host: "83104ec4cbd44006be258886de761d35.s1.eu.hivemq.cloud",
      port: 8884,          // WebSocket TLS HiveMQ
      path: "/mqtt",
      username: "bms_mixietech001",
      password: "12345678aB"
    },
    topics: {
      lampu_set:   "mixitech/bms/lampu/set",
      lampu_state: "mixitech/bms/lampu/state",
      pompa_set:   "mixitech/bms/pompa/set",
      pompa_state: "mixitech/bms/pompa/state",
      dorlock_set:   "mixitech/bms/dorlock/set",
      dorlock_state: "mixitech/bms/dorlock/state",
      ac_set:      "mixitech/bms/ac/set",
      ac_state:    "mixitech/bms/ac/state",
      availability:"mixitech/bms/system/availability",
      health:      "mixitech/bms/system/health",
      log:         "mixitech/bms/log",
      sensor_state:"mixitech/bms/sensor/suhu/state",
      automation_set: "mixitech/bms/automation/set",
      automation_state: "mixitech/bms/automation/state",
      // --- Log sync (request/response chunked) ---
      log_sync_request:  "mixitech/bms/log/sync/request",
      log_sync_response: "mixitech/bms/log/sync/response",
      // --- Log / PZEM export CSV (request/response chunked) ---
      log_export_request:  "mixitech/bms/log/export/request",
      log_export_response: "mixitech/bms/log/export/response",
      pzem_export_request:  "mixitech/bms/pzem/export/request",
      pzem_export_response: "mixitech/bms/pzem/export/response",
      // --- Auth (password) ---
      auth_verify_request:  "mixitech/bms/auth/verify/request",
      auth_verify_response: "mixitech/bms/auth/verify/response",
      auth_change_request:  "mixitech/bms/auth/change_password/request",
      auth_change_response: "mixitech/bms/auth/change_password/response",
      // --- Running Hours ---
      runninghours_reset: "mixitech/bms/runninghours/reset",
      runninghours_set:   "mixitech/bms/runninghours/set",
      runninghours_state: "mixitech/bms/runninghours/state",
      // --- Telegram config ---
      telegram_set:   "mixitech/bms/telegram/set",
      telegram_state: "mixitech/bms/telegram/state",
      // --- Sensor PZEM ---
      pzem_state: "mixitech/bms/sensor/pzem/state"
    }
  };

  var AC_TEMP_MIN = 16, AC_TEMP_MAX = 30, AC_TEMP_STEP = 1;
  var FAN_NAMES = ["AUTO", "LOW", "MEDIUM", "HIGH"];
  var CSV_MAX_RANGE_DAYS = 31; // batas rentang unduh CSV (sesuai backend)
  var CSV_EMPTY_MESSAGE = "Tidak ada data untuk rentang tanggal tersebut.";

  // appcfg: 7mxJPuDFSXZcXd

  // ---- State (hanya terisi dari sumber tepercaya: WS / MQTT state) ----
  var state = {
    lampu: 0,
    pompa: 0,
    dorlock: 1,   // 1 = arus ON (TERKUNCI), 0 = arus OFF (TERBUKA)
    ac: { power: 0, suhu: 24, fan: "AUTO" },
    ac_ack: false,
    esp32_online: false,
    nodemcu_online: false,
    serial_online: false,
    suhu_ruangan: null,
    kelembaban_ruangan: null,
    automation: {
      ac: { enabled: false, on_temp: 27, off_temp: 24, timeout_enabled: false, timeout_minutes: 120 },
      lampu: { enabled: false, on_time: "18:00", off_time: "06:00" },
      pompa: { enabled: false, on_time: "06:00", off_time: "18:00", current_threshold_amp: 1.0, timeout_enabled: false, timeout_minutes: 15 }
    },
    running_hours: {
      lampu: { set_time_hours: 1500, remaining_hours: 1500, warned: false },
      pompa: { set_time_hours: 1500, remaining_hours: 1500, warned: false },
      ac:    { set_time_hours: 3000, remaining_hours: 3000, warned: false }
    },
    pompa_listrik: null,
    telegram: { configured: false, chat_id: null, bot_token_preview: null },
    ts: 0
  };

  // ---- Log entries (ditampilkan di halaman Logging) ----
  var logEntries = [];
  var MAX_LOG_ITEMS = 200;

  // ---- Transport state ----
  var ws = null;
  var wsConnected = false;
  var wsEverOpen = false;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var mqttClient = null;
  var mqttConnected = false;
  var useMqttForCommands = false;
  var isLocal = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  var DEMO = /[?&]demo=1/.test(location.search);

  // ---- Optimistic UI (perbaikan bug 14 Sep 2026) ----
  // Gejala: klik "NYALAKAN Pompa" -> pompa fisik nyala tapi tombol kadang
  // tetap abu-abu sampai refresh/tunggu. Penyebab: frontend memang sudah
  // optimistik, TAPI heartbeat ESP32 (siklus 2 dtk) yang TERSUSUN SEBELUM
  // perintah diprosesrelay — masih membawa state lama (pompa=0) — datang
  // sesaat setelah klik dan applyState menimpanya balik (echo basi).
  // Solusi: selama window optimistik (4 dtk, ~2x heartbeat) nilai backend
  // yang BERBEDA dari harapan user ditahan (lastSeen), bukan diterapkan;
  // echo yang sama dengan harapan = konfirmasi -> window ditutup;
  // lewat 4 dtk tanpa konfirmasi -> nilai server terakhir diterapkan
  // (perintah memang gagal -> tombol jujur kembali abu-abu).
  var optimistic = {};     // dev -> {want, lastSeen}
  var optTimers = {};      // dev -> timeout
  var OPTIMISTIC_MS = 4000;

  function expireOptimistic(dev) {
    var o = optimistic[dev];
    clearTimeout(optTimers[dev]);
    delete optimistic[dev];
    delete optTimers[dev];
    if (!o) return;
    if (o.lastSeen !== null && o.lastSeen !== undefined) {
      if (dev === "ac") state.ac = o.lastSeen;
      else state[dev] = o.lastSeen;
    }
    renderAll();
  }

  function markOptimistic(dev, value) {
    clearTimeout(optTimers[dev]);
    optimistic[dev] = { want: value, lastSeen: null };
    optTimers[dev] = setTimeout(function () { expireOptimistic(dev); }, OPTIMISTIC_MS);
  }

  // Return true = incoming DITAHAN (jangan terapkan dulu). false = terapkan normal.
  function optHold(dev, incoming) {
    var o = optimistic[dev];
    if (!o) return false;
    if (JSON.stringify(o.want) === JSON.stringify(incoming)) {
      clearTimeout(optTimers[dev]);
      delete optimistic[dev];
      delete optTimers[dev];
      return false;  // konfirmasi hardware: harapan terbukti, apply normal
    }
    o.lastSeen = incoming;  // beda -> simpan utk dipakai saat window habis
    return true;
  }

  // ---- Request/response via MQTT (pola chunked, dipakai remote) ----
  var pendingMqtt = {};       // req_id -> {handler, timer}
  var logSyncDone = false;    // histori log remote hanya di-sync sekali per sesi
  var logSyncBusy = false;

  // ============================================================
  // Helpers DOM
  // ============================================================
  function $(id) { return document.getElementById(id); }

  function ripple(e, el) {
    var span = document.createElement("span");
    span.className = "ripple";
    var rect = el.getBoundingClientRect();
    span.style.left = (e.clientX - rect.left) + "px";
    span.style.top = (e.clientY - rect.top) + "px";
    el.appendChild(span);
    setTimeout(function () { span.remove(); }, 600);
  }

  function fmt1(v) {
    var n = parseFloat(v);
    return isNaN(n) ? "--" : (Math.round(n * 10) / 10).toFixed(1);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function isoDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  // ============================================================
  // Router SPA (show/hide view)
  // ============================================================
  var VIEW_MAP = {
    dashboard: "view-dashboard",
    menu: "view-menu",
    grafik: "view-grafik",
    logging: "view-logging",
    automation: "view-automation",
    runninghours: "view-runninghours",
    gear: "view-gear"
  };
  var currentView = "dashboard";

  function showView(name) {
    if (name === currentView) return;
    currentView = name;
    Object.keys(VIEW_MAP).forEach(function (k) {
      var el = $(VIEW_MAP[k]);
      if (el) el.hidden = (k !== name);
    });
    // Trigger refresh saat masuk ke halaman tertentu
    if (name === "logging") {
      refreshLogging();
      if (!isLocal) syncLogsRemote();
    } else if (name === "automation") {
      renderAutomationForm();
    } else if (name === "runninghours") {
      rhDirty = {}; // tampilkan nilai backend segar tiap masuk halaman
      renderRunningHours();
    } else if (name === "gear") {
      renderGear();
    } else if (name === "grafik") {
      grafikStart();
    }
    // Render loop grafik harus berhenti saat meninggalkan halaman grafik
    if (name !== "grafik" && typeof grafikStop === "function") {
      grafikStop();
    }
  }

  // ============================================================
  // Rendering per panel
  // ============================================================
  function renderLamp() {
    var on = state.lampu === 1;
    var icon = $("panel-lampu").querySelector(".lamp-icon");
    var btn = $("btn-lamp");
    var lbl = $("btn-lamp-label");

    icon.classList.toggle("on", on);
    btn.classList.toggle("on-lamp", on);
    lbl.textContent = on ? "MATIKAN" : "NYALAKAN";
  }

  function renderPump() {
    var on = state.pompa === 1;
    var btn = $("btn-pump");
    var lbl = $("btn-pump-label");

    btn.classList.toggle("on-pump", on);
    lbl.textContent = on ? "MATIKAN" : "NYALAKAN";

    spinPump(on);
  }

  // ---- Render panel Dorlock + animasi gagang (PUSH-TO-UNLOCK) ----
  // dorlock=1 (push 2s) -> gagang TURUN (rotate -38deg), LED merah, tombol UNLOCK nonaktif
  // dorlock=0 (idle)    -> gagang normal horizontal (rotate 0), LED hijau, tombol UNLOCK siap
  function renderDorlock() {
    // Pemulihan mandiri: kalau push lokal sudah lewat waktunya tapi state
    // masih 1 (broadcast rilis hilang saat tab background), paksa idle.
    if (state.dorlock === 1 && dorlockPushUntil && Date.now() > dorlockPushUntil + 300) {
      state.dorlock = 0;
      dorlockPushUntil = 0;
    }
    var pushing = state.dorlock === 1;
    var lever = $("dorlock-lever-img");
    var led = $("dorlock-led");
    var btn = $("btn-door");
    var lbl = $("btn-door-label");

    if (lever) {
      lever.classList.toggle("dorlock-open", pushing);
      lever.classList.toggle("dorlock-locked", !pushing);
      lever.alt = pushing ? "Gagang ditekan (solenoid aktif)" : "Gagang pintu (siap)";
    }
    if (led) {
      /* 16 Sept 2026 (owner): indikator DIBALIK — tekan UNLOCK (solenoid
         aktif) = HIJAU ("pintu dibuka"), kondisi siap/terkunci = MERAH.
         led-locked.png = strip hijau, led-open.png = strip merah (nama file
         legacy, ikuti warna di alt). */
      led.src = pushing ? "assets/Dorlock/led-locked.png" : "assets/Dorlock/led-open.png";
      led.alt = pushing ? "LED terbuka (hijau)" : "LED terkunci (merah)";
      // glow lembut sesuai warna LED
      led.style.boxShadow = pushing
        ? "0 0 10px rgba(46, 204, 113, 0.55)"
        : "0 0 10px rgba(231, 76, 60, 0.55)";
    }
    if (btn) {
      btn.classList.toggle("on-door", pushing);
      btn.classList.toggle("disabled", pushing);   // cegah spam klik saat push
      btn.classList.toggle("door-open", pushing);  // ikon gembok terbuka selama push
    }
    if (lbl) lbl.textContent = "UNLOCK";
  }

  function renderAc() {
    var on = state.ac.power === 1;
    var btn = $("btn-ac");
    var lbl = $("btn-ac-label");
    var tempEl = $("ac-temp");
    var panelEl = $("panel-ac");

    if (btn) btn.classList.toggle("on-ac", on);
    if (lbl) lbl.textContent = on ? "MATIKAN A/C" : "NYALAKAN A/C";
    if (tempEl) tempEl.textContent = state.ac.suhu;

    var hue = 210 - ((state.ac.suhu - AC_TEMP_MIN) / (AC_TEMP_MAX - AC_TEMP_MIN)) * 210;
    hue = Math.max(0, Math.min(210, hue));
    if (panelEl) panelEl.style.setProperty("--ac-temp-color", "hsl(" + Math.round(hue) + ", 78%, 56%)");

    var fanEl = $("ac-fan");
    var unitEl = $("ac-unit");
    var flowEl = $("ac-airflow");
    if (unitEl) unitEl.classList.toggle("on", on);
    if (flowEl) flowEl.classList.toggle("running", on);
    if (fanEl) {
      fanEl.classList.remove("running", "fan-auto", "fan-low", "fan-med", "fan-high");
      if (on) {
        var cls = "fan-auto";
        if (state.ac.fan === "LOW") cls = "fan-low";
        else if (state.ac.fan === "MEDIUM") cls = "fan-med";
        else if (state.ac.fan === "HIGH") cls = "fan-high";
        fanEl.classList.add("running", cls);
      }
    }

    var btns = document.querySelectorAll(".ac-fan-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].getAttribute("data-fan") === state.ac.fan);
    }
  }

  function renderRoomTemp() {
    var el = $("ac-room-temp-value");
    if (el) {
      var suhu = state.suhu_ruangan;
      el.textContent = (suhu !== null && suhu !== undefined) ? suhu.toFixed(1) : "--";
    }
    var elHum = $("ac-actual-kelembaban");
    if (elHum) {
      var hum = state.kelembaban_ruangan;
      elHum.textContent = (hum !== null && hum !== undefined) ? Math.round(hum) : "--";
    }
  }

  // ---- Render ulang semua panel ----
  function renderAll() {
    renderLamp();
    renderPump();
    renderDorlock();
    renderAc();
    renderRoomTemp();
    renderAutomationLive();
    updateButtonsDisabled();
    updateAutomationLock();
  }

  // ---- Render status live & badge di halaman Automation Rule ----
  function renderAutomationLive() {
    var auto = state.automation || {};
    var acOn = auto.ac && auto.ac.enabled;
    var lampuOn = auto.lampu && auto.lampu.enabled;
    var pompaOn = auto.pompa && auto.pompa.enabled;

    // Badge AKTIF / NONAKTIF
    var acBadge = $("ac-auto-status-badge");
    if (acBadge) {
      acBadge.textContent = acOn ? "AKTIF" : "NONAKTIF";
      acBadge.classList.toggle("badge-on", !!acOn);
      acBadge.classList.toggle("badge-off", !acOn);
    }
    var lampuBadge = $("lampu-auto-status-badge");
    if (lampuBadge) {
      lampuBadge.textContent = lampuOn ? "AKTIF" : "NONAKTIF";
      lampuBadge.classList.toggle("badge-on", !!lampuOn);
      lampuBadge.classList.toggle("badge-off", !lampuOn);
    }
    var pompaBadge = $("pompa-auto-status-badge");
    if (pompaBadge) {
      pompaBadge.textContent = pompaOn ? "AKTIF" : "NONAKTIF";
      pompaBadge.classList.toggle("badge-on", !!pompaOn);
      pompaBadge.classList.toggle("badge-off", !pompaOn);
    }

    // Live status AC
    var el = $("ac-live-suhu");
    if (el) {
      el.textContent = (state.suhu_ruangan !== null && state.suhu_ruangan !== undefined)
        ? state.suhu_ruangan.toFixed(1) : "--";
    }
    el = $("ac-live-power");
    if (el) {
      el.textContent = state.ac.power === 1 ? "MENYALA" : "MATI";
      el.classList.toggle("live-on", state.ac.power === 1);
    }
    el = $("ac-live-set");
    if (el) el.textContent = state.ac.suhu;

    // Live status lampu
    el = $("lampu-live-status");
    if (el) {
      el.textContent = state.lampu === 1 ? "MENYALA" : "MATI";
      el.classList.toggle("live-on", state.lampu === 1);
    }

    // Live status pompa + arus
    el = $("pompa-live-status");
    if (el) {
      el.textContent = state.pompa === 1 ? "MENYALA" : "MATI";
      el.classList.toggle("live-on", state.pompa === 1);
    }
    el = $("pompa-live-arus");
    if (el) {
      var pz = state.pompa_listrik;
      el.textContent = pz ? fmt1(pz.arus) : "--";
    }
  }

  // ============================================================
  // Animasi impeller pompa
  // ============================================================
  var pumpImpeller = $("pump-impeller");
  var pumpFullSpeed = 5.0;
  var pumpSpeed = 0;
  var pumpAngle = 0;
  var pumpTarget = 0;
  var pumpFrame = null;
  var pumpLastTs = null;
  var PUMP_ACCEL_TAU = 4000;
  var PUMP_DECEL_TAU = 550;

  function pumpStep(ts) {
    if (pumpLastTs === null) pumpLastTs = ts;
    var dt = Math.min(ts - pumpLastTs, 100);
    pumpLastTs = ts;
    var tau = pumpTarget > 0 ? PUMP_ACCEL_TAU : PUMP_DECEL_TAU;
    pumpSpeed += (pumpTarget - pumpSpeed) * (1 - Math.exp(-dt / tau));
    pumpAngle = (pumpAngle + pumpSpeed * dt) % 360;
    pumpImpeller.style.transform = "translate(-50%, -50%) rotate(" + pumpAngle + "deg)";
    if (pumpTarget === 0 && pumpSpeed < 0.005) {
      pumpImpeller.style.transform = "";
      pumpSpeed = 0;
      pumpAngle = 0;
      pumpFrame = null;
      return;
    }
    pumpFrame = requestAnimationFrame(pumpStep);
  }

  function spinPump(spinning) {
    pumpTarget = spinning ? pumpFullSpeed : 0;
    if (pumpFrame === null) {
      pumpLastTs = null;
      pumpFrame = requestAnimationFrame(pumpStep);
    }
  }

  // ============================================================
  // Perintah ke hardware (WS lokal / MQTT remote)
  // ============================================================
  function sendCommand(obj) {
    if (useMqttForCommands) return sendMqttCommand(obj);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function sendMqttCommand(obj) {
    if (!mqttClient || !mqttConnected) return false;
    if ("lampu" in obj) {
      mqttClient.publish(CONFIG.topics.lampu_set, obj.lampu === 1 ? "ON" : "OFF");
      return true;
    }
    if ("pompa" in obj) {
      mqttClient.publish(CONFIG.topics.pompa_set, obj.pompa === 1 ? "ON" : "OFF");
      return true;
    }
    if ("dorlock" in obj) {
      mqttClient.publish(CONFIG.topics.dorlock_set, obj.dorlock === 1 ? "LOCK" : "OPEN");
      return true;
    }
    if (obj.ac) {
      var ac = obj.ac;
      mqttClient.publish(CONFIG.topics.ac_set, JSON.stringify({
        power: ac.power === 1 ? "ON" : "OFF",
        suhu: ac.suhu,
        fan: ac.fan
      }));
      return true;
    }
    if (obj.automation) {
      mqttClient.publish(CONFIG.topics.automation_set, JSON.stringify(obj.automation));
      return true;
    }
    return false;
  }

  function commandReady() {
    return useMqttForCommands ? mqttConnected : wsConnected;
  }

  function updateButtonsDisabled() {
    var ok = commandReady();
    var i, ids = ["btn-lamp", "btn-pump", "btn-ac"];
    for (i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.classList.toggle("disabled", !ok);
    }
  }

  // ============================================================
  // Automation Lock: kontrol manual terkunci saat automation aktif
  // ============================================================
  function updateAutomationLock() {
    var auto = state.automation || {};
    var acEnabled = auto.ac && auto.ac.enabled;
    var lampuEnabled = auto.lampu && auto.lampu.enabled;
    var pompaEnabled = auto.pompa && auto.pompa.enabled;
    var panelAc = $("panel-ac");
    var acBadge = $("ac-automation-badge");

    // AC
    if (panelAc) {
      panelAc.classList.toggle("automation-locked", acEnabled);
    }
    if (acBadge) {
      acBadge.hidden = !acEnabled;
    }

    // Lampu & Pompa (hanya tombol, bukan ikon)
    var btnLamp = $("btn-lamp");
    if (btnLamp) {
      btnLamp.classList.toggle("automation-locked-btn", lampuEnabled);
    }
    var btnPump = $("btn-pump");
    if (btnPump) {
      btnPump.classList.toggle("automation-locked-btn", pompaEnabled);
    }
  }

  // ---- Dorlock: PUSH-TO-UNLOCK (revisi 2026-09) ----
  // Satu tombol UNLOCK (tidak ada buka/tutup pintu): klik -> solenoid aktif
  // 2 detik (backend otomatis mematikan), gagang turun lalu naik lagi.
  var DORLOCK_PUSH_MS = 2000;
  var dorlockPushTimer = null;
  var dorlockPushUntil = 0;   // timestamp lokal kapan push harus selesai
  function unlockDoor() {
    if (state.dorlock === 1) return;   // push sedang berjalan — abaikan klik
    if (!commandReady()) {
      // Feedback saat offline: kedipkan tombol sekali supaya user tahu
      // perintah tidak terkirim (sebelumnya: klik tanpa respons sama sekali)
      var b = $("btn-door");
      if (b) {
        b.classList.add("offline-flash");
        setTimeout(function () { b.classList.remove("offline-flash"); }, 400);
      }
      return;
    }
    state.dorlock = 1;                 // optimistik: gagang turun sekarang
    renderAll();
    sendCommand({ dorlock: 1 });
    // Pengaman lokal: pastikan gagang naik lagi walau broadcast backend
    // tidak sempat sampai (serial mati / koneksi putus)
    dorlockPushUntil = Date.now() + DORLOCK_PUSH_MS;
    if (dorlockPushTimer) clearTimeout(dorlockPushTimer);
    dorlockPushTimer = setTimeout(function () {
      dorlockPushTimer = null;
      if (state.dorlock === 1) {
        state.dorlock = 0;
        renderAll();
      }
    }, DORLOCK_PUSH_MS + 300);
  }

  // ---- Aksi tombol (dengan pengecekan lock) ----
  function toggleLamp() {
    if (!commandReady()) return;
    if (state.automation && state.automation.lampu && state.automation.lampu.enabled) return;
    var next = state.lampu === 1 ? 0 : 1;
    state.lampu = next;
    markOptimistic("lampu", next);
    renderAll();
    sendCommand({ lampu: next });
  }

  function togglePump() {
    if (!commandReady()) return;
    if (state.automation && state.automation.pompa && state.automation.pompa.enabled) return;
    var next = state.pompa === 1 ? 0 : 1;
    state.pompa = next;
    markOptimistic("pompa", next);
    renderAll();
    sendCommand({ pompa: next });
  }

  function toggleAc() {
    if (!commandReady()) return;
    if (state.automation && state.automation.ac && state.automation.ac.enabled) return;
    var next = state.ac.power === 1 ? 0 : 1;
    state.ac.power = next;
    markOptimistic("ac", { power: next, suhu: state.ac.suhu, fan: state.ac.fan });
    renderAll();
    sendCommand({ ac: { power: next, suhu: state.ac.suhu, fan: state.ac.fan } });
  }

  function setAcTemp(delta) {
    if (!commandReady()) return;
    if (state.automation && state.automation.ac && state.automation.ac.enabled) return;
    var next = Math.max(AC_TEMP_MIN, Math.min(AC_TEMP_MAX, state.ac.suhu + delta));
    if (next === state.ac.suhu) return;
    state.ac.suhu = next;
    markOptimistic("ac", { power: state.ac.power, suhu: next, fan: state.ac.fan });
    renderAll();
    sendCommand({ ac: { power: state.ac.power, suhu: next, fan: state.ac.fan } });
  }

  function setAcFan(fan) {
    if (!commandReady()) return;
    if (state.automation && state.automation.ac && state.automation.ac.enabled) return;
    if (fan === state.ac.fan) return;
    state.ac.fan = fan;
    markOptimistic("ac", { power: state.ac.power, suhu: state.ac.suhu, fan: fan });
    renderAll();
    sendCommand({ ac: { power: state.ac.power, suhu: state.ac.suhu, fan: fan } });
  }

  // ============================================================
  // Terima state (dari WS atau MQTT) -> update + render
  // ============================================================
  function applyState(partial) {
    var changed = false;
    if ("lampu" in partial && !optHold("lampu", partial.lampu) && partial.lampu !== state.lampu) { state.lampu = partial.lampu; changed = true; }
    if ("pompa" in partial && !optHold("pompa", partial.pompa) && partial.pompa !== state.pompa) { state.pompa = partial.pompa; changed = true; }
    if ("dorlock" in partial && partial.dorlock !== state.dorlock) {
      // Guard stale/retained: state pushing (1) hanya valid selama window
      // push lokal; sumber luar tidak boleh memperpanjang/memaksa pushing
      // di luar window tersebut (mencegah tombol "on terus" selamanya).
      if (partial.dorlock === 1 && !(dorlockPushUntil && Date.now() <= dorlockPushUntil + 300)) {
        // abaikan nilai pushing dari luar tanpa window lokal aktif
      } else {
        state.dorlock = partial.dorlock;
        changed = true;
      }
    }
    if (partial.ac && typeof partial.ac === "object") {
      var a = partial.ac;
      var np = a.power === 1 ? 1 : 0;
      var ns = typeof a.suhu === "number" ? a.suhu : state.ac.suhu;
      var nf = (FAN_NAMES.indexOf(String(a.fan).toUpperCase()) >= 0) ? String(a.fan).toUpperCase() : state.ac.fan;
      if (!optHold("ac", { power: np, suhu: ns, fan: nf })) {
        if (np !== state.ac.power || ns !== state.ac.suhu || nf !== state.ac.fan) {
          state.ac = { power: np, suhu: ns, fan: nf };
          changed = true;
        }
      }
      if ("ac_ack" in partial) state.ac_ack = partial.ac_ack === true;
    }
    if ("esp32_online" in partial && partial.esp32_online !== state.esp32_online) { state.esp32_online = partial.esp32_online; changed = true; }
    if ("nodemcu_online" in partial && partial.nodemcu_online !== state.nodemcu_online) { state.nodemcu_online = partial.nodemcu_online; changed = true; }
    if ("serial_online" in partial) state.serial_online = partial.serial_online === true;
    if ("suhu_ruangan" in partial) {
      var sr = partial.suhu_ruangan;
      if (sr !== state.suhu_ruangan) { state.suhu_ruangan = sr; changed = true; }
    }
    if ("kelembaban_ruangan" in partial) {
      state.kelembaban_ruangan = partial.kelembaban_ruangan;
    }
    if ("automation" in partial && partial.automation) {
      if (JSON.stringify(partial.automation) !== JSON.stringify(state.automation)) {
        state.automation = partial.automation;
        changed = true;
      }
    }
    if ("running_hours" in partial && partial.running_hours) {
      state.running_hours = partial.running_hours;
      renderRunningHours();
    }
    if ("pompa_listrik" in partial && partial.pompa_listrik) {
      state.pompa_listrik = partial.pompa_listrik; // simpan utk panel Automation (Arus)
      setPzemData(partial.pompa_listrik);
    }
    if ("telegram" in partial && partial.telegram) {
      state.telegram = partial.telegram;
      renderGearTelegram();
    }
    if ("ts" in partial) state.ts = partial.ts;

    if (changed) renderAll();
  }

  // ============================================================
  // Logging (riwayat event)
  // ============================================================
  function addLogEntry(entry) {
    if (!entry || !entry.msg) return;
    // Cegah duplikat: entry yang sama bisa tiba nyaris bersamaan via dua jalur
    // (WS log_entry + MQTT /log, atau history fetch + realtime). Cek 20 teratas.
    var limit = logEntries.length > 20 ? 20 : logEntries.length;
    for (var i = 0; i < limit; i++) {
      var e = logEntries[i];
      if (e && e.msg === entry.msg && e.ts === entry.ts) return;
    }
    // Sisipkan pada posisi terurut (ts desc) supaya urutan selalu benar
    // walau histori & realtime datang berseling.
    var pos = 0;
    while (pos < logEntries.length && logEntries[pos].ts > entry.ts) pos++;
    logEntries.splice(pos, 0, entry);
    if (logEntries.length > MAX_LOG_ITEMS) logEntries.length = MAX_LOG_ITEMS;
    // Update DOM jika halaman logging sedang terbuka
    if (currentView === "logging") {
      appendLogDOM(entry);
    }
  }

  function appendLogDOM(entry) {
    var list = $("logging-list");
    if (!list) return;
    var d = new Date(entry.ts * 1000);
    var timeStr = d.toLocaleString("id-ID", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      day: "2-digit", month: "short", year: "numeric"
    });
    var div = document.createElement("div");
    // Highlight merah berdasarkan field terstruktur `level` (bukan tebakan teks)
    div.className = "log-item" + (entry.level === "warning" ? " log-item-warning" : "");
    div.textContent = timeStr + " — " + entry.msg;
    list.insertBefore(div, list.firstChild);
    // Batasi jumlah item DOM
    while (list.children.length > MAX_LOG_ITEMS) {
      list.removeChild(list.lastChild);
    }
  }

  function refreshLogging() {
    var list = $("logging-list");
    if (!list) return;
    // Kosongkan list
    list.innerHTML = "";
    // logEntries tersimpan TERBARU-DULU (index 0 = terbaru, dijaga oleh
    // addLogEntry yang menyisipkan terurut ts). Render dari yang TERLAMA
    // (indeks akhir) ke terbaru, tiap item disisipkan di ATAS list ->
    // hasil akhir: log TERBARU paling atas, lama tergeser ke bawah.
    var arr = logEntries.slice();
    for (var i = arr.length - 1; i >= 0; i--) {
      appendLogDOM(arr[i]);
    }
  }

  // ---- Sync histori log untuk dashboard REMOTE via MQTT chunked ----
  function syncLogsRemote() {
    if (!mqttClient || !mqttConnected || logSyncDone || logSyncBusy) return;
    logSyncBusy = true;
    var reqId = "logsync-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    var collected = [];
    registerMqttRequest(reqId, function (msg) {
      if (!msg || !Array.isArray(msg.entries)) return;
      for (var i = 0; i < msg.entries.length; i++) {
        collected.push(msg.entries[i]);
        addLogEntry(msg.entries[i]);
      }
      // Cukup 2x kapasitas tampilan; histori lebih lama tetap aman di disk
      if (msg.has_more && collected.length < MAX_LOG_ITEMS * 2) {
        mqttClient.publish(CONFIG.topics.log_sync_request, JSON.stringify({
          req_id: reqId, cursor: msg.next_cursor
        }));
      } else {
        logSyncDone = true;
        logSyncBusy = false;
        unregisterMqttRequest(reqId);
        if (currentView === "logging") refreshLogging();
      }
    }, 30000);
    mqttClient.publish(CONFIG.topics.log_sync_request, JSON.stringify({
      req_id: reqId, cursor: null
    }));
  }

  // ---- Helper request/response via MQTT dengan timeout ----
  function registerMqttRequest(reqId, handler, timeoutMs) {
    unregisterMqttRequest(reqId);
    var entry = { handler: handler, timer: null };
    entry.timer = setTimeout(function () {
      unregisterMqttRequest(reqId);
      if (entry.onTimeout) entry.onTimeout();
    }, timeoutMs || 15000);
    pendingMqtt[reqId] = entry;
    return entry;
  }

  function unregisterMqttRequest(reqId) {
    var e = pendingMqtt[reqId];
    if (e && e.timer) clearTimeout(e.timer);
    delete pendingMqtt[reqId];
  }

  function newReqId(prefix) {
    return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  }

  // ============================================================
  // Automation Form
  // ============================================================
  function renderAutomationForm() {
    var auto = state.automation || { ac: {}, lampu: {}, pompa: {} };
    var ac = auto.ac || {};
    var lampu = auto.lampu || {};
    var pompa = auto.pompa || {};

    $("ac-auto-enabled").checked = ac.enabled === true;
    $("ac-on-temp").value = ac.on_temp || 27;
    $("ac-off-temp").value = ac.off_temp || 24;
    $("ac-timeout-enabled").checked = ac.timeout_enabled === true;
    $("ac-timeout-minutes").value = ac.timeout_minutes || 120;

    $("lampu-auto-enabled").checked = lampu.enabled === true;
    $("lampu-on-time").value = lampu.on_time || "18:00";
    $("lampu-off-time").value = lampu.off_time || "06:00";

    $("pompa-auto-enabled").checked = pompa.enabled === true;
    $("pompa-on-time").value = pompa.on_time || "06:00";
    $("pompa-off-time").value = pompa.off_time || "18:00";
    $("pompa-timeout-enabled").checked = pompa.timeout_enabled === true;
    $("pompa-current-threshold").value = pompa.current_threshold_amp || 1;
    $("pompa-timeout-minutes").value = pompa.timeout_minutes || 15;
    validateHysteresis();
  }

  function collectAutomationRules() {
    var onTemp = parseFloat($("ac-on-temp").value);
    var offTemp = parseFloat($("ac-off-temp").value);

    // Validasi hysteresis
    if (onTemp <= offTemp) {
      $("auto-save-status").textContent = "Error: A/C ON harus lebih besar dari A/C OFF (hysteresis)";
      $("auto-save-status").className = "auto-status error";
      $("auto-save-status").hidden = false;
      return null;
    }

    var lampOn = $("lampu-on-time").value;
    var lampOff = $("lampu-off-time").value;
    if (lampOn === lampOff) {
      $("auto-save-status").textContent = "Error: jam Lampu ON dan OFF tidak boleh sama";
      $("auto-save-status").className = "auto-status error";
      $("auto-save-status").hidden = false;
      return null;
    }

    var pomOn = $("pompa-on-time").value;
    var pomOff = $("pompa-off-time").value;
    if (pomOn === pomOff) {
      $("auto-save-status").textContent = "Error: jam Pompa ON dan OFF tidak boleh sama";
      $("auto-save-status").className = "auto-status error";
      $("auto-save-status").hidden = false;
      return null;
    }

    var threshold = parseFloat($("pompa-current-threshold").value);
    if (isNaN(threshold) || threshold <= 0) {
      $("auto-save-status").textContent = "Error: ambang arus pompa harus angka > 0";
      $("auto-save-status").className = "auto-status error";
      $("auto-save-status").hidden = false;
      return null;
    }

    return {
      ac: {
        enabled: $("ac-auto-enabled").checked,
        on_temp: onTemp,
        off_temp: offTemp,
        timeout_enabled: $("ac-timeout-enabled").checked,
        timeout_minutes: parseInt($("ac-timeout-minutes").value, 10) || 120
      },
      lampu: {
        enabled: $("lampu-auto-enabled").checked,
        on_time: lampOn,
        off_time: lampOff
      },
      pompa: {
        enabled: $("pompa-auto-enabled").checked,
        on_time: pomOn,
        off_time: pomOff,
        current_threshold_amp: threshold,
        timeout_enabled: $("pompa-timeout-enabled").checked,
        timeout_minutes: parseInt($("pompa-timeout-minutes").value, 10) || 15
      }
    };
  }

  function sendAutomationRules() {
    var rules = collectAutomationRules();
    if (!rules) return;

    // Kirim ke backend (via WS atau MQTT)
    sendCommand({ automation: rules });

    // Tampilkan status
    var statusEl = $("auto-save-status");
    statusEl.textContent = "Aturan automation dikirim...";
    statusEl.className = "auto-status";
    statusEl.hidden = false;
    setTimeout(function () { statusEl.hidden = true; }, 3000);
  }

  // ============================================================
  // Keypad pop-up (input touchscreen tanpa keyboard/mouse)
   // Dipakai untuk suhu A/C ON/OFF, jam Lampu/Pompa ON/OFF,
   // ambang arus & timeout Pompa, Set Time Running Hours (desimal)
  // ============================================================
  var KP_TITLES = {
    "ac-on-temp": "A/C ON — SUHU NYALA",
    "ac-off-temp": "A/C OFF — SUHU MATI",
    "ac-timeout-minutes": "TIMEOUT A/C — DURASI (MENIT)",
    "lampu-on-time": "LAMPU ON — JAM",
    "lampu-off-time": "LAMPU OFF — JAM",
    "pompa-on-time": "POMPA ON — JAM",
    "pompa-off-time": "POMPA OFF — JAM",
    "pompa-current-threshold": "AMBANG ARUS POMPA (AMPERE)",
    "pompa-timeout-minutes": "TIMEOUT ARUS POMPA — DURASI (MENIT)",
    "rh-set-lampu": "SET TIME LAMPU (JAM)",
    "rh-set-pompa": "SET TIME POMPA (JAM)",
    "rh-set-ac": "SET TIME A/C (JAM)",
    "rh-set-dorlock": "SET TIME DOORLOCK (JAM)"
  };
  var kpState = {
    open: false,
    type: "number",   // number | time | decimal
    targetId: null,
    buffer: "",
    min: 0,
    max: 99
  };

  function kpPad(n) { return String(n).padStart(2, "0"); }

  function openKeypad(inputEl) {
    if (!inputEl) return;
    kpState.targetId = inputEl.id;
    kpState.type = (inputEl.type === "time") ? "time"
      : (inputEl.getAttribute("data-decimal") === "1") ? "decimal" : "number";
    kpState.min = parseFloat(inputEl.min);
    kpState.max = parseFloat(inputEl.max);
    if (isNaN(kpState.min)) kpState.min = 0;
    if (isNaN(kpState.max)) kpState.max = 99;
    // Ambil digit dari nilai saat ini (desimal: sertakan titik)
    var v = inputEl.value || "";
    kpState.buffer = (kpState.type === "decimal")
      ? v.replace(/[^0-9.]/g, "").slice(0, 8)
      : v.replace(/\D/g, "").slice(0, 4);
    kpState.open = true;

    $("keypad-title").textContent = KP_TITLES[inputEl.id] || "INPUT NILAI";
    $("keypad-error").hidden = true;
    $("keypad-display").classList.remove("state-error");
    $("keypad-overlay").hidden = false;
    kpRenderDisplay();
  }

  function kpClose() {
    kpState.open = false;
    $("keypad-overlay").hidden = true;
  }

  function kpRenderDisplay() {
    var disp = $("keypad-display");
    if (kpState.type === "time") {
      // Format HH:MM dari 4 digit buffer
      var chars = (kpState.buffer + "    ").slice(0, 4).split("");
      var html = "";
      for (var i = 0; i < 4; i++) {
        if (i === 2) html += '<span class="kp-sep">:</span>';
        var dim = i >= kpState.buffer.length ? " dim" : "";
        html += '<span class="kp-digit' + dim + '">' + (chars[i] === " " ? "\u00b7" : chars[i]) + "</span>";
      }
      disp.innerHTML = html;
    } else {
      var d = kpState.buffer;
      if (!d) {
        disp.innerHTML = '<span class="kp-digit dim">-</span><span class="kp-digit dim">-</span>';
      } else {
        var h = "";
        for (var j = 0; j < d.length; j++) h += '<span class="kp-digit">' + d[j] + "</span>";
        disp.innerHTML = h;
      }
    }
  }

  function kpShowError(msg) {
    var err = $("keypad-error");
    err.textContent = msg;
    err.hidden = false;
    $("keypad-display").classList.add("state-error");
  }

  function kpDigit(d) {
    if (kpState.type === "decimal") {
      // Desimal: hanya digit, maksimal 8 karakter (titik tidak dipakai)
      if (d === ".") return;
      if (kpState.buffer.length >= 8) return;
      kpState.buffer += d;
    } else if (kpState.type === "time") {
      if (kpState.buffer.length >= 4) return;
      kpState.buffer += d;
    } else {
      // Batas digit menyesuaikan nilai max (mis. 1440 menit = 4 digit)
      var limit = String(kpState.max).length;
      if (kpState.buffer.length >= limit) return;
      kpState.buffer += d;
    }
    $("keypad-error").hidden = true;
    $("keypad-display").classList.remove("state-error");
    kpRenderDisplay();
  }

  function kpBack() {
    kpState.buffer = kpState.buffer.slice(0, -1);
    $("keypad-error").hidden = true;
    $("keypad-display").classList.remove("state-error");
    kpRenderDisplay();
  }

  function kpClear() {
    kpState.buffer = "";
    $("keypad-error").hidden = true;
    $("keypad-display").classList.remove("state-error");
    kpRenderDisplay();
  }

  function kpOK() {
    var target = $(kpState.targetId);
    if (!target) { kpClose(); return; }
    if (kpState.type === "time") {
      if (kpState.buffer.length < 4) {
        kpShowError("Lengkapi jam & menit (HH:MM)");
        return;
      }
      var hh = parseInt(kpState.buffer.slice(0, 2), 10);
      var mm = parseInt(kpState.buffer.slice(2, 4), 10);
      if (hh > 23 || mm > 59) {
        kpShowError("Jam tidak valid (00:00 \u2013 23:59)");
        return;
      }
      target.value = kpPad(hh) + ":" + kpPad(mm);
      kpClose();
    } else if (kpState.type === "decimal") {
      if (!kpState.buffer || kpState.buffer === ".") {
        kpShowError("Masukkan nilai jam");
        return;
      }
      var nd = parseFloat(kpState.buffer);
      if (isNaN(nd)) {
        kpShowError("Nilai tidak valid");
        return;
      }
      if (nd < kpState.min || nd > kpState.max) {
        kpShowError("Nilai harus antara " + kpState.min + " \u2013 " + kpState.max);
        return;
      }
      target.value = nd;
      kpClose();
      // Tandai Set Time Running Hours sebagai diedit-user agar tidak
      // ditimpa broadcast backend sebelum tombol SIMPAN ditekan
      if (target.id.indexOf("rh-set-") === 0) {
        rhDirty[target.id.slice(7)] = true;
      }
    } else {
      if (!kpState.buffer) {
        kpShowError("Masukkan nilai suhu");
        return;
      }
      var n = parseInt(kpState.buffer, 10);
      if (n < kpState.min || n > kpState.max) {
        kpShowError("Nilai harus antara " + kpState.min + " \u2013 " + kpState.max + " \u00b0C");
        return;
      }
      target.value = n;
      kpClose();
      // Update warna hint hysteresis langsung
      validateHysteresis();
    }
  }

  function kpCancel() {
    kpClose();
  }

  function initKeypad() {
    // Klik pada input readonly / tombol pensil -> buka keypad
    var ids = ["ac-on-temp", "ac-off-temp", "ac-timeout-minutes",
               "lampu-on-time", "lampu-off-time",
               "pompa-on-time", "pompa-off-time", "pompa-current-threshold",
               "pompa-timeout-minutes", "rh-set-lampu", "rh-set-pompa", "rh-set-ac",
               "rh-set-dorlock"];
    var i;
    for (i = 0; i < ids.length; i++) {
      (function (id) {
        var el = $(id);
        if (el) el.addEventListener("click", function () { openKeypad(el); });
      })(ids[i]);
    }
    var editBtns = document.querySelectorAll(".auto-edit");
    for (i = 0; i < editBtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var target = $(btn.getAttribute("data-target"));
          if (target) openKeypad(target);
        });
      })(editBtns[i]);
    }
    // Delegasi klik tombol keypad
    $("keypad-overlay").addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      if (t.id === "keypad-close") { kpCancel(); return; }
      if (t.getAttribute("data-k")) { kpDigit(t.getAttribute("data-k")); return; }
      if (t.getAttribute("data-act")) {
        var act = t.getAttribute("data-act");
        if (act === "back") kpBack();
        else if (act === "clear") kpClear();
        else if (act === "ok") kpOK();
        else if (act === "cancel") kpCancel();
      }
    });
    // Dukungan keyboard fisik (untuk dev/testing)
    document.addEventListener("keydown", function (e) {
      if (kpState.open) {
        if (/^[0-9]$/.test(e.key)) { kpDigit(e.key); return; }
        if (e.key === "Backspace") { kpBack(); return; }
        if (e.key === "Enter") { kpOK(); return; }
        if (e.key === "Escape") { kpCancel(); }
        return;
      }
      if (authState.open) {
        if (/^[0-9]$/.test(e.key)) { authDigit(e.key); return; }
        if (e.key === "Backspace") { authBack(); return; }
        if (e.key === "Enter") { authSubmit(); return; }
        if (e.key === "Escape") { authClose(); }
        return;
      }
      if (calState.open) {
        if (e.key === "Escape") { calClose(); }
        return;
      }
    });
  }

  // ============================================================
  // AUTH overlay (PIN numerik 4-8 digit, gaya keypad-overlay)
  // SELALU muncul tiap masuk Automation Rule / Running Hours.
  // Status "sudah login" TIDAK pernah diingat di frontend.
  // Verifikasi dilakukan di BACKEND (WS lokal / MQTT request remote).
  // ============================================================
  var authState = {
    open: false,
    scope: null,        // "automation" | "running_hours"
    targetView: null,   // view yang dituju setelah sukses
    buffer: ""
  };

  function authRender() {
    var disp = $("auth-display");
    var html = "";
    var shown = Math.max(authState.buffer.length, 4);
    for (var i = 0; i < shown; i++) {
      var ch = i < authState.buffer.length ? "\u2022" : "\u00b7";
      var dim = i >= authState.buffer.length ? " dim" : "";
      html += '<span class="kp-digit' + dim + '">' + ch + "</span>";
    }
    disp.innerHTML = html;
  }

  function authShowError(msg) {
    var err = $("auth-error");
    err.textContent = msg;
    err.hidden = false;
    $("auth-display").classList.add("state-error");
  }

  function authClearError() {
    $("auth-error").hidden = true;
    $("auth-display").classList.remove("state-error");
  }

  function openAuth(scope, targetView) {
    authState.open = true;
    authState.scope = scope;
    authState.targetView = targetView;
    authState.buffer = "";
    $("auth-title").textContent = (scope === "automation")
      ? "PASSWORD — AUTOMATION RULE" : "PASSWORD — RUNNING HOURS";
    authClearError();
    authRender();
    $("auth-overlay").hidden = false;
  }

  function authClose() {
    authState.open = false;
    $("auth-overlay").hidden = true;
  }

  function authDigit(d) {
    if (authState.buffer.length >= 8) return;
    authState.buffer += d;
    authClearError();
    authRender();
  }

  function authBack() {
    authState.buffer = authState.buffer.slice(0, -1);
    authClearError();
    authRender();
  }

  function authSetBusy(busy) {
    var ok = $("auth-ok");
    if (ok) {
      ok.disabled = busy;
      ok.textContent = busy ? "MEMERIKSA..." : "OK";
    }
  }

  function authLockedMsg(untilTs) {
    var s = Math.max(1, Math.ceil(untilTs - Date.now() / 1000));
    return "Terkunci karena percobaan gagal berulang. Coba lagi dalam " + s + " detik.";
  }

  function authSubmit() {
    if (authState.buffer.length < 4) {
      authShowError("PIN minimal 4 digit");
      return;
    }
    var scope = authState.scope;
    var target = authState.targetView;
    var password = authState.buffer;
    authSetBusy(true);
    authClearError();

    var onDone = function (ok, lockedUntil) {
      authSetBusy(false);
      if (ok) {
        authClose();
        showView(target);
        return;
      }
      if (lockedUntil) {
        authShowError(authLockedMsg(lockedUntil));
      } else {
        authShowError("Password salah. Coba lagi.");
      }
      authState.buffer = "";
      authRender();
    };

    if (useMqttForCommands) {
      // Remote: request/response via MQTT (verifikasi di backend)
      if (!mqttClient || !mqttConnected) {
        authSetBusy(false);
        authShowError("Koneksi MQTT tidak tersedia");
        return;
      }
      var reqId = newReqId("authv");
      var entry = registerMqttRequest(reqId, function (msg) {
        unregisterMqttRequest(reqId);
        if (!msg || msg.scope !== scope) return;
        onDone(msg.ok === true, msg.locked_until || null);
      }, 12000);
      entry.onTimeout = function () {
        authSetBusy(false);
        authShowError("Tidak ada balasan dari backend (timeout)");
      };
      mqttClient.publish(CONFIG.topics.auth_verify_request, JSON.stringify({
        req_id: reqId, scope: scope, password: password
      }));
    } else {
      // Lokal: via WebSocket
      var wsSend = function () {
        ws.removeEventListener("message", onMsg);
        authSetBusy(false);
        authShowError("Koneksi WebSocket tidak tersedia");
      };
      var timer = setTimeout(function () {
        if (ws) ws.removeEventListener("message", onMsg);
        wsSend();
      }, 12000);
      var onMsg = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data.auth_verify_result && data.auth_verify_result.scope === scope) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMsg);
            onDone(data.auth_verify_result.ok === true, data.auth_verify_result.locked_until || null);
          }
        } catch (err) {}
      };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ auth_verify: { scope: scope, password: password } }));
      } else {
        clearTimeout(timer);
        wsSend();
      }
    }
  }

  function initAuthOverlay() {
    $("auth-overlay").addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t) return;
      if (t.id === "auth-close") { authClose(); return; }
      if (t.getAttribute("data-k")) { authDigit(t.getAttribute("data-k")); return; }
      var act = t.getAttribute("data-act");
      if (act === "aclear") { authState.buffer = ""; authClearError(); authRender(); }
      else if (act === "aback") { authBack(); }
      else if (act === "aok") { authSubmit(); }
      else if (act === "acancel") { authClose(); }
    });
  }

  // ============================================================
  // RUNNING HOURS (halaman terkunci password)
  // ============================================================
  // Set Time yang sedang diedit user (belum SIMPAN) — jangan ditimpa
  // broadcast backend (full-state datang tiap ~1,5s saat PZEM dummy jalan).
  var rhDirty = {};

  function renderRunningHours() {
    var rh = state.running_hours || {};
    var devs = ["lampu", "pompa", "ac", "dorlock"];
    for (var i = 0; i < devs.length; i++) {
      (function (dev) {
        var d = rh[dev];
        var setEl = $("rh-set-" + dev);
        var remEl = $("rh-remain-" + dev);
        var barEl = $("rh-bar-" + dev);
        var badge = $("rh-badge-" + dev);
        if (!d) {
          if (setEl) setEl.value = "";
          if (remEl) remEl.textContent = "--";
          if (barEl) barEl.style.width = "0%";
          return;
        }
        // Jangan timpa nilai yang sedang/baru diedit user (belum disimpan)
        if (setEl && !rhDirty[dev] && document.activeElement !== setEl) setEl.value = d.set_time_hours;
        var rem = parseFloat(d.remaining_hours) || 0;
        var set = parseFloat(d.set_time_hours) || 0;
        var ratio = set > 0 ? rem / set : 0;
        if (remEl) {
          remEl.textContent = rem <= 0 ? "0" : String(Math.round(rem));
          remEl.classList.toggle("rh-expired", rem <= 0);
          remEl.classList.toggle("rh-low", rem > 0 && ratio < 0.25);
        }
        if (barEl) {
          barEl.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + "%";
          barEl.classList.toggle("rh-expired", rem <= 0);
          barEl.classList.toggle("rh-low", rem > 0 && ratio < 0.25);
        }
        if (badge) {
          var on = (dev === "lampu" && state.lampu === 1)
            || (dev === "pompa" && state.pompa === 1)
            || (dev === "ac" && state.ac.power === 1)
            || (dev === "dorlock" && state.dorlock === 1);
          var label = (dev === "dorlock") ? (on ? "TERKUNCI" : "TERBUKA") : (on ? "MENYALA" : "MATI");
          badge.textContent = rem <= 0 ? "MAINTENANCE!" : label;
          badge.classList.toggle("badge-on", on && rem > 0);
          badge.classList.toggle("badge-off", !on && rem > 0);
          badge.classList.toggle("badge-warn", rem <= 0);
        }
      })(devs[i]);
    }
  }

  function sendRunningHoursSet() {
    var payload = {};
    // M6 fix: dorlock ikut — dulu tidak terkirim sehingga SET TIME doorlock
    // yang diedit teknisi diam-diam dibuang oleh tombol SIMPAN.
    var devs = ["lampu", "pompa", "ac", "dorlock"];
    var any = false;
    for (var i = 0; i < devs.length; i++) {
      var el = $("rh-set-" + devs[i]);
      if (!el || el.value === "") continue;
      var v = parseFloat(el.value);
      if (isNaN(v) || v <= 0) {
        var st = $("rh-save-status");
        st.textContent = "Error: Set Time " + namesRH(devs[i]) + " harus angka > 0";
        st.className = "auto-status error";
        st.hidden = false;
        setTimeout(function () { st.hidden = true; }, 3500);
        return;
      }
      payload[devs[i]] = { set_time_hours: v };
      any = true;
    }
    if (!any) return;
    // Setelah dikirim, nilai backend yang akan jadi acuan (echo broadcast)
    rhDirty = {};
    if (useMqttForCommands) {
      if (mqttClient && mqttConnected) {
        mqttClient.publish(CONFIG.topics.runninghours_set, JSON.stringify(payload));
      }
    } else {
      sendCommand({ running_hours_set: payload });
    }
    var st2 = $("rh-save-status");
    st2.textContent = "Set Time dikirim ke backend...";
    st2.className = "auto-status";
    st2.hidden = false;
    setTimeout(function () { st2.hidden = true; }, 3000);
  }

  function namesRH(dev) {
    return dev === "lampu" ? "Lampu" : dev === "pompa" ? "Pompa Air" : dev === "dorlock" ? "Doorlock" : "A/C";
  }

  function sendRunningHoursReset(dev) {
    if (useMqttForCommands) {
      if (mqttClient && mqttConnected) {
        mqttClient.publish(CONFIG.topics.runninghours_reset, JSON.stringify({ device: dev }));
      }
    } else {
      sendCommand({ running_hours_reset: { device: dev } });
    }
    var st = $("rh-save-status");
    st.textContent = "RESET " + namesRH(dev).toUpperCase() + " dikirim ke backend...";
    st.className = "auto-status";
    st.hidden = false;
    setTimeout(function () { st.hidden = true; }, 3000);
  }

  // ============================================================
  // PENGATURAN (Gear): Telegram + Ganti Password
  // ============================================================
  function renderGear() {
    renderGearTelegram();
  }

  function renderGearTelegram() {
    var badge = $("tg-status-badge");
    if (!badge) return;
    var tg = state.telegram || { configured: false, chat_id: null, bot_token_preview: null };
    if (tg.configured) {
      badge.textContent = "AKTIF" + (tg.chat_id ? " \u2022 " + tg.chat_id : "");
      badge.classList.add("badge-on");
      badge.classList.remove("badge-off");
    } else {
      badge.textContent = "BELUM DIATUR";
      badge.classList.remove("badge-on");
      badge.classList.add("badge-off");
    }
  }

  function sendTelegramConfig() {
    var token = ($("tg-bot-token").value || "").trim();
    var chat = ($("tg-chat-id").value || "").trim();
    var st = $("gear-save-status");
    if (!token || !chat) {
      st.textContent = "Error: Bot Token dan Chat ID wajib diisi";
      st.className = "auto-status error";
      st.hidden = false;
      setTimeout(function () { st.hidden = true; }, 3500);
      return;
    }
    if (useMqttForCommands) {
      if (mqttClient && mqttConnected) {
        mqttClient.publish(CONFIG.topics.telegram_set, JSON.stringify({ bot_token: token, chat_id: chat }));
      }
    } else {
      sendCommand({ telegram_set: { bot_token: token, chat_id: chat } });
    }
    st.textContent = "Konfigurasi Telegram dikirim ke backend...";
    st.className = "auto-status";
    st.hidden = false;
    setTimeout(function () { st.hidden = true; }, 3000);
  }

  function sendChangePassword() {
    var oldPw = ($("pwd-old").value || "");
    var newPw = ($("pwd-new").value || "");
    var confPw = ($("pwd-confirm").value || "");
    var st = $("gear-save-status");

    if (!newPw) {
      gearStatus("Error: password baru tidak boleh kosong", true);
      return;
    }
    if (newPw.length < 4 || newPw.length > 8 || !/^[0-9]+$/.test(newPw)) {
      gearStatus("Error: Password baru harus 4\u20138 digit angka", true);
      return;
    }
    if (newPw !== confPw) {
      gearStatus("Error: ulangi password baru tidak sama", true);
      return;
    }
    if (!oldPw) {
      gearStatus("Error: isi password lama", true);
      return;
    }

    // Satu field untuk dua jalur: backend memutuskan (master dulu, lalu password lama)
    var payload = {
      master_password: oldPw,
      current_password: oldPw,
      new_password: newPw
    };

    var onDone = function (ok, err) {
      if (ok) {
        $("pwd-old").value = ""; $("pwd-new").value = ""; $("pwd-confirm").value = "";
        gearStatus("", false);   // tanpa keterangan (permintaan user)
      } else {
        gearStatus("Error: " + (err || "gagal ganti password"), true);
      }
    };

    if (useMqttForCommands) {
      if (!mqttClient || !mqttConnected) {
        gearStatus("Error: koneksi MQTT tidak tersedia", true);
        return;
      }
      var reqId = newReqId("authc");
      var entry = registerMqttRequest(reqId, function (msg) {
        unregisterMqttRequest(reqId);
        if (!msg) return;
        onDone(msg.ok === true, msg.error || null);
      }, 12000);
      entry.onTimeout = function () {
        gearStatus("Error: tidak ada balasan backend (timeout)", true);
      };
      mqttClient.publish(CONFIG.topics.auth_change_request, JSON.stringify(
        Object.assign({ req_id: reqId }, payload)
      ));
    } else {
      var timer = null;
      var onMsg = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data.auth_change_password_result) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMsg);
            onDone(data.auth_change_password_result.ok === true, data.auth_change_password_result.error || null);
          }
        } catch (err) {}
      };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ auth_change_password: payload }));
        timer = setTimeout(function () {
          ws.removeEventListener("message", onMsg);
          gearStatus("Error: tidak ada balasan backend (timeout)", true);
        }, 12000);
      } else {
        gearStatus("Error: koneksi WebSocket tidak tersedia", true);
      }
    }
  }

  function gearStatus(msg, isError) {
    var st = $("gear-save-status");
    st.textContent = msg;
    st.className = "auto-status" + (isError ? " error" : "");
    st.hidden = false;
    setTimeout(function () { st.hidden = true; }, 4000);
  }

  // ============================================================
  // GRAFIK PZEM: buffer + canvas vanilla (TANPA library CDN)
  // Animasi halus (PROMPT_ANIMASI_GRAFIK_POMPA.md):
  //   - render loop terpisah dari data loop (rAF ~30fps)
  //   - interpolasi displayed -> target per titik (tanpa lompatan)
  //   - garis kurva (quadratic melalui midpoint antar titik)
  //   - scroll kontinu: sumbu-X digerakkan jam nyata, mengalir ke kiri
  //   - HiDPI via devicePixelRatio; loop berhenti saat halaman ditutup
  // ============================================================
  var PZEM_WINDOW_SEC = 180;   // jendela grafik: ~120 sampel x 1.5s
  var PZEM_CLEANUP_SEC = 240;  // buang sampel lebih tua dari window + margin
  var GR_EASE_RATE = 7;        // laju easing displayed->target (per detik, frame-rate independent)
  var GR_TIP_DAMP = 0.6;       // redaman ekstrapolasi ujung garis (anti overshoot)
  var GR_FRAME_MIN_MS = 33;    // batas render ~30fps (hemat CPU Mini PC 24/7)

  // Satu seri = satu garis. target = data asli backend (dipakai skala Y),
  // displayed = nilai yang dianimasikan dan digambar ke canvas.
  var pzemSeries = {
    arus: { samples: [], canvas: "chart-arus", colorVar: "--blue", colorFallback: "#1E50D8", unit: "A", color: "" },
    daya: { samples: [], canvas: "chart-daya", colorVar: "--green", colorFallback: "#188652", unit: "W", color: "" }
  };
  var grBorder = "#E3E6EF";
  var grMuted = "#8A90A6";
  var grGrid = "#C3C9D9";      // grid chart: kontras lebih tinggi dari --border
  var grafikRafId = null;
  var grafikLastDraw = 0;
  var grLabelLastSec = -1;
  var grLabelStart = "";
  var grLabelEnd = "";

  function pushSample(series, t, target) {
    var arr = series.samples;
    var prev = arr.length ? arr[arr.length - 1] : null;
    arr.push({ t: t, target: target, displayed: prev ? prev.displayed : target });
  }

  function easeSamples(series, dt) {
    var arr = series.samples;
    if (!arr.length) return;
    // k = 1 - exp(-rate*dt): konvergensi konsisten walau frame drop (vs faktor per-frame)
    var k = 1 - Math.exp(-GR_EASE_RATE * dt);
    var last = arr.length - 1;
    for (var i = 0; i <= last; i++) {
      var s = arr[i];
      s.displayed += (s.target - s.displayed) * k;
    }
    // Anti-jitter ujung: ujung garis adalah titik paling baru & paling terlihat.
    // Ekstrapolasi menuju waktu sekarang (bukan melompat saat sampel baru datang),
    // dengan redaman GR_TIP_DAMP supaya tidak melewati target (overshoot).
    var tip = arr[last];
    var tipPrev = last > 0 ? arr[last - 1] : null;
    if (tipPrev && tip.t > tipPrev.t) {
      var slope = (tip.target - tipPrev.target) / (tip.t - tipPrev.t);
      var extrap = tip.displayed + slope * (nowSec() - tip.t) * GR_TIP_DAMP;
      tip.drawY = extrap;
    } else {
      tip.drawY = tip.displayed;
    }
  }

  function nowSec() { return Date.now() / 1000; }

  function trimSamples(series, now) {
    var arr = series.samples;
    var cutoff = now - PZEM_CLEANUP_SEC;
    var drop = 0;
    while (drop < arr.length && arr[drop].t < cutoff) drop++;
    if (drop > 0) arr.splice(0, drop); // jarang: hapus batch sekaligus
  }

  function setPzemData(pz) {
    if (!pz) return;
    var now = Date.now() / 1000;
    pushSample(pzemSeries.arus, now, parseFloat(pz.arus) || 0);
    pushSample(pzemSeries.daya, now, parseFloat(pz.daya) || 0);
    trimSamples(pzemSeries.arus, now);
    trimSamples(pzemSeries.daya, now);
    // Tile nilai instan — tidak diubah (di luar cakupan animasi grafik)
    var el;
    el = $("pzem-volt"); if (el) el.textContent = pz.tegangan != null ? Math.round(pz.tegangan).toString() : "--";
    el = $("pzem-hz"); if (el) el.textContent = pz.frekuensi != null ? Math.round(pz.frekuensi).toString() : "--";
    el = $("pzem-cosphi"); if (el) el.textContent = pz.cosphi != null ? (Math.round(pz.cosphi * 10) / 10).toFixed(1) : "--";
    el = $("pzem-arus-now"); if (el) el.textContent = pz.arus != null ? (Math.round(pz.arus * 10) / 10).toFixed(1) : "--";
    // Panel Automation (POMPA AIR) — tampilkan arus dari PZEM004T juga
    el = $("pompa-live-arus"); if (el) el.textContent = pz.arus != null ? (Math.round(pz.arus * 10) / 10).toFixed(1) : "--";
    el = $("pzem-daya-now"); if (el) el.textContent = pz.daya != null ? Math.round(pz.daya) : "--";
    // Tidak perlu gambar di sini — render loop yang menggambar
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Cache warna (dipanggil saat masuk halaman & ganti tema) — supaya
  // render loop tidak memanggil getComputedStyle setiap frame
  function refreshChartColors() {
    pzemSeries.arus.color = cssVar(pzemSeries.arus.colorVar, pzemSeries.arus.colorFallback);
    pzemSeries.daya.color = cssVar(pzemSeries.daya.colorVar, pzemSeries.daya.colorFallback);
    grBorder = cssVar("--border", "#E3E6EF");
    grMuted = cssVar("--muted", "#8A90A6");
    grGrid = cssVar("--chart-grid", "#C3C9D9");
  }

  // ---- Render loop (terpisah dari data loop) ----
  function grafikStart() {
    refreshChartColors();
    if (grafikRafId !== null) return;
    grafikLastDraw = 0;
    grafikRafId = requestAnimationFrame(grafikFrame);
  }

  function grafikStop() {
    if (grafikRafId !== null) {
      cancelAnimationFrame(grafikRafId);
      grafikRafId = null;
    }
  }

  function grafikFrame(ts) {
    // Pengaman ekstra: loop mati sendiri bila halaman sudah tidak dibuka
    if (currentView !== "grafik" || document.hidden) {
      grafikRafId = null;
      return;
    }
    if (ts - grafikLastDraw >= GR_FRAME_MIN_MS) {
      var dt = grafikLastDraw ? Math.min((ts - grafikLastDraw) / 1000, 0.25) : GR_FRAME_MIN_MS / 1000;
      grafikLastDraw = ts;
      easeSamples(pzemSeries.arus, dt);
      easeSamples(pzemSeries.daya, dt);
      drawLineChart(pzemSeries.arus);
      drawLineChart(pzemSeries.daya);
    }
    grafikRafId = requestAnimationFrame(grafikFrame);
  }

  function drawLineChart(series) {
    var canvas = $(series.canvas);
    if (!canvas) return;
    var wrap = canvas.parentElement;
    var cssW = wrap.clientWidth || 600;
    var cssH = 170;
    // HiDPI: ukuran internal = ukuran CSS x dpr (garis tajam di touchscreen)
    var dpr = window.devicePixelRatio || 1;
    var needW = Math.round(cssW * dpr);
    var needH = Math.round(cssH * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var padL = 46, padR = 12, padT = 12, padB = 22;
    var w = cssW - padL - padR, h = cssH - padT - padB;

    // Sumbu-X berbasis waktu nyata -> scroll kontinu tanpa lompatan.
    // Tepi kanan = sekarang; semua titik bergeser ke kiri tiap frame.
    var now = Date.now() / 1000;
    var t0 = now - PZEM_WINDOW_SEC;
    var spanT = PZEM_WINDOW_SEC;

    var arr = series.samples;
    var vmin = Infinity, vmax = -Infinity;
    var firstIdx = -1;
    var i, s;
    for (i = 0; i < arr.length; i++) {
      if (arr[i].t < t0) continue;
      if (firstIdx < 0) firstIdx = i;
      if (arr[i].target < vmin) vmin = arr[i].target;
      if (arr[i].target > vmax) vmax = arr[i].target;
    }
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    if (vmax - vmin < 1e-6) { vmax = vmin + 1; }
    // Skala Y LEMBUT: skala mengejar rentang data dengan easing kecil,
    // bukan dihitung ulang kasar tiap frame -> sumbu tidak "bernapas".
    var spanRaw = vmax - vmin;
    var tMin = vmin - spanRaw * 0.08;
    var tMax = vmax + spanRaw * 0.08;
    if (typeof series.scMin !== "number" || !isFinite(series.scMin)) {
      series.scMin = tMin;
      series.scMax = tMax;
    }
    series.scMin += (tMin - series.scMin) * 0.06;
    series.scMax += (tMax - series.scMax) * 0.06;
    var sMin = series.scMin;
    var span = Math.max(series.scMax - sMin, 1e-6);

    // Grid + label sumbu Y (dashed, kontras lebih tinggi dari --border)
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = grMuted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var g = 0; g <= 4; g++) {
      var gy = padT + h - (h * g / 4);
      var val = sMin + span * g / 4;
      ctx.strokeStyle = grGrid;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(padL + w, gy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(series.unit === "A" ? val.toFixed(1) : Math.round(val), padL - 6, gy);
    }

    // Grid VERTIKAL (garis waktu) + label jam di bawah tiap garis:
    // 5 garis membagi window 180s menjadi 4 blok 45 detik
    ctx.textAlign = "center";
    for (var v = 0; v <= 4; v++) {
      var tv = t0 + spanT * v / 4;
      var gx = padL + w * v / 4;
      if (v > 0 && v < 4) {                 // garis tengah saja (tepi = bingkai area)
        ctx.strokeStyle = grGrid;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(gx, padT);
        ctx.lineTo(gx, padT + h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      var dv = new Date(tv * 1000);
      ctx.fillText(pad2(dv.getHours()) + ":" + pad2(dv.getMinutes()) + ":" + pad2(dv.getSeconds()), gx, padT + h + 7);
    }

    if (firstIdx < 0) {
      ctx.fillStyle = grMuted;
      ctx.textAlign = "center";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("Menunggu data sensor...", padL + w / 2, padT + h / 2);
      return;
    }

    // Kumpulkan titik gambar (x tetap dari waktu; ujung memakai drawY hasil
    // ekstrapolasi easeSamples -> garis tumbuh kontinu, bukan melompat)
    var pts = [];
    var tipPt = null;   // penanda titik data terkini (ujung kanan kurva)
    for (i = firstIdx; i < arr.length; i++) {
      s = arr[i];
      if (s.t > now + 0.05) break;
      var x = padL + w * (s.t - t0) / spanT;
      if (x > padL + w + 2) break;
      var yv = (i === arr.length - 1 && typeof s.drawY === "number") ? s.drawY : s.displayed;
      var y = padT + h - (h * (yv - sMin) / span);
      pts.push(x, y);
      tipPt = [x, y];
    }

    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // AREA FILL gradient tipis di bawah kurva — digambar SEBELUM garis
    // supaya kurva tetap tajam di atasnya; warna dari series (dark mode ikut)
    if (pts.length >= 4) {
      var nF = pts.length / 2;
      var grd = ctx.createLinearGradient(0, padT, 0, padT + h);
      grd.addColorStop(0, series.color + "3C");   // ~24% alpha
      grd.addColorStop(1, series.color + "00");   // transparan
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(pts[0], padT + h);
      for (var f = 0; f < nF; f++) ctx.lineTo(pts[2 * f], pts[2 * f + 1]);
      ctx.lineTo(pts[2 * (nF - 1)], padT + h);
      ctx.closePath();
      ctx.fill();
    }

    if (pts.length >= 4) {
      // Kurva MONOTONE CUBIC (Fritsch-Carlson): halus melewati semua titik,
      // tanpa overshoot/wobble seperti midpoint-quadratic versi lama.
      var n = pts.length / 2;
      var xs = new Array(n), ys = new Array(n);
      for (i = 0; i < n; i++) { xs[i] = pts[2 * i]; ys[i] = pts[2 * i + 1]; }
      var dxs = new Array(n - 1), dys = new Array(n - 1), ms = new Array(n - 1);
      for (i = 0; i < n - 1; i++) {
        dxs[i] = xs[i + 1] - xs[i];
        dys[i] = ys[i + 1] - ys[i];
        ms[i] = dys[i] / dxs[i];
      }
      var m1 = new Array(n);
      m1[0] = ms[0];
      m1[n - 1] = ms[n - 2];
      for (i = 1; i < n - 1; i++) {
        m1[i] = (ms[i - 1] * ms[i] <= 0) ? 0 : (ms[i - 1] + ms[i]) / 2;
      }
      for (i = 0; i < n - 1; i++) {
        if (ms[i] === 0) { m1[i] = 0; m1[i + 1] = 0; continue; }
        var a2 = m1[i] / ms[i];
        var b2 = m1[i + 1] / ms[i];
        var s2 = a2 * a2 + b2 * b2;
        if (s2 > 9) {
          var tau = 3 / Math.sqrt(s2);
          m1[i] = tau * a2 * ms[i];
          m1[i + 1] = tau * b2 * ms[i];
        }
      }
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (i = 0; i < n - 1; i++) {
        ctx.bezierCurveTo(
          xs[i] + dxs[i] / 3, ys[i] + m1[i] * dxs[i] / 3,
          xs[i + 1] - dxs[i] / 3, ys[i + 1] - m1[i + 1] * dxs[i] / 3,
          xs[i + 1], ys[i + 1]
        );
      }
      ctx.stroke();
    } else if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      ctx.lineTo(pts[2], pts[3]);
      ctx.stroke();
    }

    // PENANDA titik data terkini: dot solid + ring + glow (warna series)
    if (tipPt) {
      var tx = Math.min(tipPt[0], padL + w);
      var ty = tipPt[1];
      ctx.save();
      ctx.shadowColor = series.color;
      ctx.shadowBlur = 9;
      ctx.fillStyle = series.color;
      ctx.beginPath();
      ctx.arc(tx, ty, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 6.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label waktu kini digambar per garis vertikal di atas — label kiri/kanan
    // lama tidak dibutuhkan lagi (kembali ke komposisi v34)
  }

  // ============================================================
  // CALENDAR overlay (pilih rentang tanggal, touchscreen)
  // ============================================================
  var calState = {
    open: false,
    y: 2026, m: 0,          // bulan yang sedang ditampilkan (m: 0-11)
    from: null, to: null,   // Date
    cb: null,               // callback(fromISO, toISO)
    target: null            // "logging" | "grafik"
  };
  var CAL_DAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
  var CAL_MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                    "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

  function openCalendar(target, cb) {
    var now = new Date();
    calState.open = true;
    calState.y = now.getFullYear();
    calState.m = now.getMonth();
    calState.from = null;
    calState.to = null;
    calState.cb = cb;
    calState.target = target;
    $("cal-error").hidden = true;
    $("calendar-overlay").hidden = false;
    renderCalendar();
  }

  function calClose() {
    calState.open = false;
    $("calendar-overlay").hidden = true;
  }

  function renderCalendar() {
    var label = $("cal-month-label");
    label.textContent = CAL_MONTHS[calState.m] + " " + calState.y;
    var grid = $("cal-grid");
    var html = "";
    for (var i = 0; i < CAL_DAYS.length; i++) {
      html += '<span class="cal-dow">' + CAL_DAYS[i] + "</span>";
    }
    var first = new Date(calState.y, calState.m, 1);
    var offset = (first.getDay() + 6) % 7; // Senin = 0
    var daysInMonth = new Date(calState.y, calState.m + 1, 0).getDate();
    var todayIso = isoDate(new Date());
    for (var c = 0; c < offset; c++) {
      html += '<span class="cal-day cal-empty"></span>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var dt = new Date(calState.y, calState.m, d);
      var iso = isoDate(dt);
      var cls = "cal-day";
      var fIso = calState.from ? isoDate(calState.from) : null;
      var tIso = calState.to ? isoDate(calState.to) : null;
      if (iso === fIso) cls += " cal-from";
      if (iso === tIso) cls += " cal-to";
      if (calState.from && calState.to && iso > fIso && iso < tIso) cls += " cal-inrange";
      if (iso === todayIso) cls += " cal-today";
      html += '<button type="button" class="' + cls + '" data-date="' + iso + '">' + d + "</button>";
    }
    grid.innerHTML = html;

    var info = $("cal-range-info");
    if (calState.from && calState.to) {
      info.textContent = "From: " + isoDate(calState.from) + "  \u2192  To: " + isoDate(calState.to);
    } else if (calState.from) {
      info.textContent = "From: " + isoDate(calState.from) + "  \u2192  tap tanggal kedua (To)";
    } else {
      info.textContent = "Tap tanggal pertama (From), lalu tanggal kedua (To)";
    }
  }

  function calPick(iso) {
    var picked = new Date(iso + "T00:00:00");
    if (!calState.from || (calState.from && calState.to)) {
      calState.from = picked;
      calState.to = null;
    } else {
      if (picked < calState.from) {
        calState.from = picked;
      } else {
        calState.to = picked;
      }
    }
    $("cal-error").hidden = true;
    renderCalendar();
  }

  function calDownload() {
    if (!calState.from || !calState.to) {
      $("cal-error").textContent = "Pilih tanggal From dan To dulu";
      $("cal-error").hidden = false;
      return;
    }
    var fIso = isoDate(calState.from);
    var tIso = isoDate(calState.to);
    var days = Math.round((calState.to - calState.from) / 86400000) + 1;
    if (days > CSV_MAX_RANGE_DAYS) {
      $("cal-error").textContent = "Rentang maksimal " + CSV_MAX_RANGE_DAYS + " hari (dipilih: " + days + " hari)";
      $("cal-error").hidden = false;
      return;
    }
    calClose();
    if (calState.cb) calState.cb(fIso, tIso);
  }

  function initCalendar() {
    $("cal-prev").addEventListener("click", function () {
      calState.m--; if (calState.m < 0) { calState.m = 11; calState.y--; }
      renderCalendar();
    });
    $("cal-next").addEventListener("click", function () {
      calState.m++; if (calState.m > 11) { calState.m = 0; calState.y++; }
      renderCalendar();
    });
    $("cal-grid").addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button.cal-day") : null;
      if (t && t.getAttribute("data-date")) calPick(t.getAttribute("data-date"));
    });
    $("cal-ok").addEventListener("click", calDownload);
    $("cal-cancel").addEventListener("click", calClose);
    $("cal-close").addEventListener("click", calClose);
  }

  // ============================================================
  // ON-SCREEN KEYBOARD (QWERTY + numpad) — input teks touchscreen
  // untuk field Bot Token, Chat/Group ID & form Ganti Password di
  // halaman Pengaturan (kiosk tanpa keyboard/mouse fisik).
  // mode "text": QWERTY lengkap + shift + simbol; mode "pin": numpad.
  // ============================================================
  var OSK_Q = ["1","2","3","4","5","6","7","8","9","0","-","="];
  var OSK_W = ["q","w","e","r","t","y","u","i","o","p","[","]"];
  var OSK_A = ["a","s","d","f","g","h","j","k","l",";","'"];
  var OSK_S = ["\\","z","x","c","v","b","n","m",",",".","/"];
  // Layer simbol (untuk token Telegram yang mengandung ":" dll)
  var OSK_SYM1 = ["!","@","#","$","%","^","&","*","(",")","_","+"];
  var OSK_SYM2 = [":",";","'","\"","-","=","[","]","{","}","~"];
  var OSK_SYM3 = [",",".","?","/","<",">","\\","|","`"];
  var OSK_SHIFT_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 7h-4v7H9v-7H5z"/></svg>';
  var OSK_BACK_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z"/><path d="M18 9l-6 6M12 9l6 6"/></svg>';

  var oskState = {
    open: false,
    mode: "text",      // "text" | "pin"
    layer: "abc",      // "abc" | "sym" (layer huruf / simbol)
    targetId: null,
    buffer: "",
    maxLength: 64,
    shift: false,
    mask: false
  };

  function oskKeyBtn(label, dataChar, dataAct, extraCls, iconSvg) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "osk-key" + (extraCls ? " " + extraCls : "");
    if (iconSvg) { b.innerHTML = iconSvg; }
    else { b.textContent = label; }
    if (dataChar !== null && dataChar !== undefined) b.setAttribute("data-char", dataChar);
    if (dataAct) b.setAttribute("data-act", dataAct);
    return b;
  }

  function renderOsk() {
    var rows = $("osk-rows");
    rows.innerHTML = "";
    var r, i, row;

    if (oskState.mode === "pin") {
      var pinGroups = [["1","2","3"], ["4","5","6"], ["7","8","9"], ["C","0","back"]];
      for (r = 0; r < pinGroups.length; r++) {
        row = document.createElement("div");
        row.className = "osk-row";
        for (i = 0; i < pinGroups[r].length; i++) {
          var k = pinGroups[r][i];
          if (k === "C") {
            row.appendChild(oskKeyBtn("C", null, "oclear", "osk-fn"));
          } else if (k === "back") {
            row.appendChild(oskKeyBtn("", null, "oback", "osk-fn", OSK_BACK_SVG));
          } else {
            row.appendChild(oskKeyBtn(k, k));
          }
        }
        rows.appendChild(row);
      }
    } else {
      var letters, shift = oskState.shift;
      if (oskState.layer === "sym") {
        letters = [OSK_SYM1, OSK_SYM2, OSK_SYM3];
      } else {
        letters = [OSK_Q, OSK_W, OSK_A, OSK_S];
      }
      var sym = (oskState.layer === "sym");
      for (r = 0; r < letters.length; r++) {
        row = document.createElement("div");
        row.className = "osk-row";
        // Tombol kiri baris ke-3: shift (abc) atau kembali ke huruf (sym)
        if (r === 2) {
          if (sym) {
            row.appendChild(oskKeyBtn("ABC", null, "olayer", "osk-fn"));
          } else {
            row.appendChild(oskKeyBtn("", null, "oshift", "osk-fn" + (shift ? " osk-active" : ""), OSK_SHIFT_SVG));
          }
        }
        for (i = 0; i < letters[r].length; i++) {
          var ch = letters[r][i];
          var out = (!sym && shift) ? ch.toUpperCase() : ch;
          row.appendChild(oskKeyBtn(out, ch));
        }
        if (r === 2) row.appendChild(oskKeyBtn("", null, "oback", "osk-fn", OSK_BACK_SVG));
        rows.appendChild(row);
      }
      // Baris bawah: 123!@ / @ / @gmail.com / spasi + TEMPEL/SALIN
      // (hanya mode teks — untuk menempel Bot Token & Chat ID dari clipboard;
      // backspace cukup satu, sudah ada di ujung kanan baris ke-3)
      row = document.createElement("div");
      row.className = "osk-row";
      row.appendChild(oskKeyBtn(sym ? "ABC" : "123!@", null, "olayer"));
      row.appendChild(oskKeyBtn("@", "@", null, "osk-fn"));
      if (!sym) {
        row.appendChild(oskKeyBtn("@GMAIL.COM", null, "ogmail"));
      } else {
        row.appendChild(oskKeyBtn("SPASI", " ", null, "osk-space"));
      }
      row.appendChild(oskKeyBtn("TEMPEL", null, "opaste", "osk-fn"));
      row.appendChild(oskKeyBtn("SALIN", null, "ocopy", "osk-fn"));
      rows.appendChild(row);
    }

    // Preview nilai
    var prev = $("osk-preview-text");
    if (oskState.mode === "pin" || oskState.mask) {
      prev.textContent = oskState.buffer ? "\u2022".repeat(oskState.buffer.length) : "";
    } else {
      prev.textContent = oskState.buffer;
    }
    $("osk-preview").classList.remove("state-error");
  }

  function oskShowError(msg) {
    var err = $("osk-error");
    err.textContent = msg;
    err.hidden = false;
    $("osk-preview").classList.add("state-error");
  }

  function oskClearError() {
    $("osk-error").hidden = true;
    $("osk-preview").classList.remove("state-error");
  }

  function openOsk(targetId) {
    var el = $(targetId);
    if (!el) return;
    oskState.open = true;
    oskState.targetId = targetId;
    oskState.mode = (el.getAttribute("data-osk") === "pin") ? "pin" : "text";
    oskState.layer = "abc";
    oskState.maxLength = parseInt(el.getAttribute("maxlength"), 10) || 64;
    oskState.shift = false;
    oskState.mask = (el.getAttribute("data-osk-mask") === "1");
    oskState.buffer = el.value || "";
    $("osk-title").textContent = (el.getAttribute("data-osk-title") || "INPUT");
    $("osk-preview-label").textContent = (el.getAttribute("data-osk-label") || "NILAI");
    $("osk-error").hidden = true;
    $("osk-modal").classList.toggle("osk-pin", oskState.mode === "pin");
    $("osk-overlay").hidden = false;
    renderOsk();
  }

  function oskClose() {
    oskState.open = false;
    $("osk-overlay").hidden = true;
  }

  function oskSubmit() {
    var el = $(oskState.targetId);
    if (!el) { oskClose(); return; }
    var v = oskState.buffer;
    if (el.getAttribute("data-osk") === "pin") {
      if (v.length < 4) { oskShowError("Password minimal 4 digit"); return; }
      if (!/^[0-9]+$/.test(v)) { oskShowError("Password hanya berisi angka"); return; }
    } else if (!v.trim()) {
      oskShowError("Nilai tidak boleh kosong");
      return;
    }
    el.value = v;
    oskClose();
  }

  function oskChar(ch) {
    if (oskState.buffer.length >= oskState.maxLength) return;
    var out = (oskState.mode === "text" && oskState.shift) ? ch.toUpperCase() : ch;
    oskState.buffer += out;
    if (oskState.shift) { oskState.shift = false; } // shift sekali tekan (gaya ponsel)
    oskClearError();
    renderOsk();
  }

  function oskAct(act) {
    if (act === "oback") {
      oskState.buffer = oskState.buffer.slice(0, -1);
      oskClearError();
      renderOsk();
    } else if (act === "oclear") {
      oskState.buffer = "";
      oskClearError();
      renderOsk();
    } else if (act === "oshift") {
      oskState.shift = !oskState.shift;
      renderOsk();
    } else if (act === "olayer") {
      oskState.layer = (oskState.layer === "abc") ? "sym" : "abc";
      oskState.shift = false;
      renderOsk();
    } else if (act === "ogmail") {
      if (oskState.buffer.length + "@gmail.com".length <= oskState.maxLength) {
        oskState.buffer += "@gmail.com";
        oskClearError();
        renderOsk();
      }
    } else if (act === "opaste") {
      // Tempel dari clipboard (Bot Token / Chat ID). Butuh secure context —
      // localhost & https selalu memenuhi; jika browser menolak (izin),
      // tampilkan pesan agar user tahu, tanpa membuat kiosk macet.
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        oskShowError("Clipboard tidak tersedia di browser ini");
        return;
      }
      navigator.clipboard.readText().then(function (txt) {
        var clean = (txt || "").replace(/\s+/g, "");
        if (!clean) { oskShowError("Clipboard kosong"); return; }
        oskState.buffer = (oskState.buffer + clean).slice(0, oskState.maxLength);
        oskClearError();
        renderOsk();
      }).catch(function () {
        oskShowError("Izin clipboard ditolak browser");
      });
    } else if (act === "ocopy") {
      // Salin nilai yang sedang diketik ke clipboard
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        oskShowError("Clipboard tidak tersedia di browser ini");
        return;
      }
      navigator.clipboard.writeText(oskState.buffer).then(function () {
        oskShowError("Nilai tersalin ke clipboard");
        // bukan error sungguhan: tampilkan netral, auto-hilang
        var err = $("osk-error");
        setTimeout(function () { err.hidden = true; }, 1500);
      }).catch(function () {
        oskShowError("Gagal menyalin ke clipboard");
      });
    }
  }

  function initOsk() {
    // Field teks halaman Pengaturan -> buka OSK saat disentuh
    var fields = document.querySelectorAll(".tg-input");
    for (var i = 0; i < fields.length; i++) {
      (function (el) {
        el.setAttribute("readonly", "readonly"); // cegah keyboard fisik/IME muncul di kiosk
        el.addEventListener("click", function () { openOsk(el.id); });
      })(fields[i]);
    }
    $("osk-rows").addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button.osk-key") : null;
      if (!t) return;
      var ch = t.getAttribute("data-char");
      var act = t.getAttribute("data-act");
      if (ch) { oskChar(ch); return; }
      if (ch === "") { oskChar(" "); return; } // tombol spasi
      if (act) oskAct(act);
    });
    $("osk-ok").addEventListener("click", oskSubmit);
    $("osk-cancel").addEventListener("click", oskClose);
    $("osk-close").addEventListener("click", oskClose);
  }

  // ============================================================
  // Unduh CSV: REST (lokal) / MQTT chunked (remote) + Blob download
  // ============================================================
  function downloadCsv(kind, fromIso, toIso, btn) {
    var baseName = kind === "log"
      ? "log_export_" + fromIso + "_to_" + toIso + ".csv"
      : "grafik_pompa_export_" + fromIso + "_to_" + toIso + ".csv";

    var setBusy = function (busy, progressText) {
      if (!btn) return;
      btn.disabled = busy;
      var span = btn.querySelector("span");
      if (span) {
        span.textContent = busy ? (progressText || "MENGUNDUH...") : "UNDUH CSV";
      }
    };

    var saveBlob = function (text) {
      // UTF-8 BOM agar Excel (regional Indonesia, delimiter ';') mengenali
      // encoding dan langsung memisah kolom saat file dibuka.
      if (text.charCodeAt(0) !== 0xFEFF) text = "\ufeff" + text;
      var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = baseName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 2000);
      setBusy(false);
    };

    if (isLocal) {
      // Dashboard lokal: langsung unduh via REST (satu origin dengan backend)
      var url = (kind === "log" ? "/api/logs/export" : "/api/pzem/export")
        + "?from=" + fromIso + "&to=" + toIso;
      setBusy(true);
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.onload = function () {
        if (xhr.status === 200) {
          saveBlob(xhr.responseText);
        } else if (xhr.status === 404) {
          // Backend: tidak ada data pada rentang tsb
          setBusy(false);
          alert(xhr.responseText || CSV_EMPTY_MESSAGE);
        } else {
          setBusy(false);
          alert("Gagal mengunduh CSV (HTTP " + xhr.status + ")");
        }
      };
      xhr.onerror = function () {
        setBusy(false);
        alert("Gagal mengunduh CSV: backend tidak terjangkau");
      };
      xhr.send();
      return;
    }

    // Dashboard remote: chunked via MQTT (satu-satunya jalur)
    if (!mqttClient || !mqttConnected) {
      alert("Koneksi MQTT tidak tersedia");
      return;
    }
    setBusy(true, "MENGIRIM PERMINTAAN...");
    var reqId = newReqId("csv");
    var chunks = {};
    var lastIndex = -1;
    var entry = registerMqttRequest(reqId, function (msg) {
      if (!msg || typeof msg.chunk_index !== "number") return;
      if (msg.empty) {
        // Backend menandai rentang tanpa data -> tampilkan pesan, bukan file
        unregisterMqttRequest(reqId);
        setBusy(false);
        alert(msg.message || CSV_EMPTY_MESSAGE);
        return;
      }
      chunks[msg.chunk_index] = msg.csv_chunk || "";
      if (msg.has_more) {
        setBusy(true, "MENGUNDUH... (" + Object.keys(chunks).length + " bagian)");
      } else {
        lastIndex = msg.chunk_index;
        // Pastikan semua chunk sudah diterima berurutan
        for (var i = 0; i <= lastIndex; i++) {
          if (!(i in chunks)) return;
        }
        unregisterMqttRequest(reqId);
        var text = "";
        for (var k = 0; k <= lastIndex; k++) text += chunks[k];
        saveBlob(text);
      }
    }, 60000);
    entry.onTimeout = function () {
      setBusy(false);
      alert("Timeout menunggu data CSV dari backend");
    };
    mqttClient.publish(
      kind === "log" ? CONFIG.topics.log_export_request : CONFIG.topics.pzem_export_request,
      JSON.stringify({ req_id: reqId, date_from: fromIso, date_to: toIso })
    );
  }

  function openCsvDialog(kind, btn) {
    openCalendar(kind, function (fromIso, toIso) {
      downloadCsv(kind, fromIso, toIso, btn);
    });
  }

  // ============================================================
  // WebSocket lokal
  // ============================================================
  function wsUrl() {
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host + "/ws";
  }

  function connectWs() {
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      onWsFailed();
      return;
    }
    ws.onopen = function () {
      wsConnected = true;
      wsEverOpen = true;
      useMqttForCommands = false;
      reconnectDelay = 1000;
      updateButtonsDisabled();
    };
    ws.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        // Jika ada log_entry, add ke logging tanpa timpa state
        if (data.log_entry) {
          addLogEntry(data.log_entry);
          return;
        }
        applyState(data);
      } catch (err) {}
    };
    ws.onclose = function () {
      wsConnected = false;
      updateButtonsDisabled();
      if (!wsEverOpen) {
        onWsFailed();
        return;
      }
      reconnectTimer = setTimeout(connectWs, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
    ws.onerror = function () {};
  }

  function onWsFailed() {
    if (isLocal) {
      reconnectTimer = setTimeout(connectWs, 3000);
    } else {
      useMqttForCommands = true;
      updateButtonsDisabled();
    }
  }

  // ============================================================
  // MQTT (HiveMQ Cloud via WebSocket)
  // ============================================================
  function connectMqtt() {
    if (!window.mqtt) {
      updateButtonsDisabled();
      return;
    }
    var url = "wss://" + CONFIG.mqtt.host + ":" + CONFIG.mqtt.port + CONFIG.mqtt.path;
    mqttClient = window.mqtt.connect(url, {
      clientId: "bms-dash-" + Math.random().toString(16).slice(2, 10),
      username: CONFIG.mqtt.username,
      password: CONFIG.mqtt.password,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true
    });

    mqttClient.on("connect", function () {
      mqttConnected = true;
      mqttClient.subscribe([
        CONFIG.topics.lampu_state,
        CONFIG.topics.pompa_state,
        CONFIG.topics.dorlock_state,
        CONFIG.topics.ac_state,
        CONFIG.topics.health,
        CONFIG.topics.sensor_state,
        CONFIG.topics.automation_state,
        CONFIG.topics.log,
        // State tambahan (fitur baru)
        CONFIG.topics.pzem_state,
        CONFIG.topics.runninghours_state,
        CONFIG.topics.telegram_state,
        // Response topics (request/response pola)
        CONFIG.topics.log_sync_response,
        CONFIG.topics.log_export_response,
        CONFIG.topics.pzem_export_response,
        CONFIG.topics.auth_verify_response,
        CONFIG.topics.auth_change_response
      ]);
      updateButtonsDisabled();
    });

    mqttClient.on("close", function () {
      mqttConnected = false;
      updateButtonsDisabled();
    });
    mqttClient.on("error", function () {});

    mqttClient.on("message", function (topic, payload) {
      // Request/response chunked: route ke handler pending berdasarkan req_id
      if (topic === CONFIG.topics.log_sync_response ||
          topic === CONFIG.topics.log_export_response ||
          topic === CONFIG.topics.pzem_export_response ||
          topic === CONFIG.topics.auth_verify_response ||
          topic === CONFIG.topics.auth_change_response) {
        try {
          var m = JSON.parse(payload.toString());
          var pend = m && m.req_id ? pendingMqtt[m.req_id] : null;
          if (pend) pend.handler(m);
        } catch (e) {}
        return;
      }

      var text = payload.toString();
      var p = {};
      if (topic === CONFIG.topics.lampu_state) { p.lampu = text === "ON" ? 1 : 0; }
      else if (topic === CONFIG.topics.pompa_state) { p.pompa = text === "ON" ? 1 : 0; }
      else if (topic === CONFIG.topics.dorlock_state) { p.dorlock = text === "LOCKED" ? 1 : 0; }
      else if (topic === CONFIG.topics.ac_state) {
        try {
          var a = JSON.parse(text);
          p.ac = { power: a.power === "ON" ? 1 : 0, suhu: a.suhu, fan: a.fan };
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.health) {
        try {
          var h = JSON.parse(text);
          p.esp32_online = h.esp32 === true;
          p.nodemcu_online = h.nodemcu === true;
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.sensor_state) {
        try {
          var s = JSON.parse(text);
          p.suhu_ruangan = s.suhu;
          p.kelembaban_ruangan = s.kelembaban;
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.automation_state) {
        try {
          p.automation = JSON.parse(text);
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.pzem_state) {
        try {
          var z = JSON.parse(text);
          p.pompa_listrik = {
            tegangan: z.v, frekuensi: z.hz, cosphi: z.cosphi, arus: z.i, daya: z.power
          };
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.runninghours_state) {
        try {
          p.running_hours = JSON.parse(text);
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.telegram_state) {
        try {
          p.telegram = JSON.parse(text);
        } catch (e) {}
      }
      else if (topic === CONFIG.topics.log) {
        // Di dashboard lokal, log sudah diterima via WebSocket.
        // Lewati MQTT agar tidak tercatat dobel.
        if (isLocal) return;
        try {
          var entry2 = JSON.parse(text);
          addLogEntry(entry2);
        } catch (e) {}
        return;
      }
      if (Object.keys(p).length) applyState(p);
    });
  }

  // ============================================================
  // Jam + tema
  // ============================================================
  function tickClock() {
    var now = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    $("clock").textContent = p(now.getHours()) + ":" + p(now.getMinutes()) + ":" + p(now.getSeconds());
    $("date").textContent = now.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { window.localStorage.setItem("bms-mixitech-theme", t); } catch (e) {}
    // Grafik pakai cache warna — refresh saat tema berganti (loop sendiri
    // yang menggambar; tidak perlu requestAnimationFrame manual di sini)
    if (currentView === "grafik") refreshChartColors();
  }

  function initTheme() {
    var t = "light";
    try { t = window.localStorage.getItem("bms-mixitech-theme") || "light"; } catch (e) {}
    var m = /[?&]theme=(light|dark)/.exec(location.search);
    if (m) t = m[1];
    if (t !== "dark") t = "light";
    applyTheme(t);
    $("theme-toggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(cur);
    });
  }

  // ============================================================
  // Init
  // ============================================================
  function applyDemo() {
    applyState({
      lampu: 1,
      pompa: 1,
      ac: { power: 1, suhu: 24, fan: "HIGH" },
      ac_ack: true,
      esp32_online: true,
      nodemcu_online: true,
      serial_online: true,
      suhu_ruangan: 26.5,
      kelembaban_ruangan: 60.2,
      running_hours: state.running_hours,
      ts: Date.now() / 1000
    });
  }

  function init() {
    // Tombol perangkat
    $("btn-lamp").addEventListener("click", function (e) { ripple(e, this); toggleLamp(); });
    $("btn-pump").addEventListener("click", function (e) { ripple(e, this); togglePump(); });
    $("btn-door").addEventListener("click", function (e) { ripple(e, this); unlockDoor(); });
    $("btn-ac").addEventListener("click", function (e) { ripple(e, this); toggleAc(); });

    $("ac-temp-down").addEventListener("click", function () { setAcTemp(-AC_TEMP_STEP); });
    $("ac-temp-up").addEventListener("click", function () { setAcTemp(AC_TEMP_STEP); });

    var fanBtns = document.querySelectorAll(".ac-fan-btn");
    for (var i = 0; i < fanBtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { setAcFan(btn.getAttribute("data-fan")); });
      })(fanBtns[i]);
    }

    // Logo -> menu
    $("logo-btn").addEventListener("click", function () { showView("menu"); });

    // Menu buttons
    $("menu-btn-grafik").addEventListener("click", function () { showView("grafik"); });
    $("menu-btn-logging").addEventListener("click", function () { showView("logging"); });
    $("menu-btn-runninghours").addEventListener("click", function () { openAuth("running_hours", "runninghours"); });
    $("menu-btn-automation").addEventListener("click", function () { openAuth("automation", "automation"); });
    $("menu-btn-gear").addEventListener("click", function () { showView("gear"); });
    $("menu-btn-back").addEventListener("click", function () { showView("dashboard"); });
    $("grafik-btn-back").addEventListener("click", function () { showView("menu"); });
    $("logging-btn-back").addEventListener("click", function () { showView("menu"); });
    $("automation-btn-back").addEventListener("click", function () { showView("menu"); });
    $("rh-btn-back").addEventListener("click", function () { showView("menu"); });
    $("gear-btn-back").addEventListener("click", function () { showView("menu"); });

    // Unduh CSV (Logging & Grafik)
    $("logging-btn-csv").addEventListener("click", function () { openCsvDialog("log", this); });
    $("grafik-btn-csv").addEventListener("click", function () { openCsvDialog("pzem", this); });

    // Automation buttons
    $("ac-auto-save").addEventListener("click", sendAutomationRules);
    $("lampu-auto-save").addEventListener("click", sendAutomationRules);
    $("pompa-auto-save").addEventListener("click", sendAutomationRules);

    // Validasi hysteresis di form: saat AC ON input berubah, update hint
    $("ac-on-temp").addEventListener("input", function () { validateHysteresis(); });
    $("ac-off-temp").addEventListener("input", function () { validateHysteresis(); });

    // Running Hours
    $("rh-save-all").addEventListener("click", sendRunningHoursSet);
    $("rh-reset-lampu").addEventListener("click", function () { sendRunningHoursReset("lampu"); });
    $("rh-reset-pompa").addEventListener("click", function () { sendRunningHoursReset("pompa"); });
    $("rh-reset-ac").addEventListener("click", function () { sendRunningHoursReset("ac"); });
    $("rh-reset-dorlock").addEventListener("click", function () { sendRunningHoursReset("dorlock"); });

    // Gear
    $("tg-save").addEventListener("click", sendTelegramConfig);
    $("pwd-save").addEventListener("click", sendChangePassword);

    // Fetch histori log dari backend saat halaman logging dibuka
    // (juga akan dipanggil oleh showView)
    fetchLogHistory();

    // Inisialisasi keypad touchscreen (input readonly + pop-up angka)
    initKeypad();
    initAuthOverlay();
    initCalendar();
    initOsk();

    initTheme();
    tickClock();
    setInterval(tickClock, 1000);

    renderAll();

    if (DEMO) setTimeout(applyDemo, 250);

    if (isLocal) connectWs();
    else useMqttForCommands = true;
    connectMqtt();
  }

  function validateHysteresis() {
    var onTemp = parseFloat($("ac-on-temp").value) || 0;
    var offTemp = parseFloat($("ac-off-temp").value) || 0;
    var hint = $("ac-hysteresis-hint");
    if (onTemp <= offTemp) {
      hint.style.color = "var(--red, #D92D3E)";
    } else {
      hint.style.color = "";
    }
  }

  function fetchLogHistory() {
    // Dashboard lokal: ambil histori log dari REST API backend.
    // Dashboard remote: tidak akan bisa (origin beda) — dipakai MQTT sync
    // (syncLogsRemote) saat halaman Logging dibuka.
    if (!isLocal) return;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/logs", true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          if (Array.isArray(data)) {
            // API mengirim TERBARU-DULU (descending); proses dari yang TERLAMA
            // agar unshift() menghasilkan logEntries terbaru-dulu (konsisten
            // dengan event realtime), sehingga render = terbaru di atas.
            for (var i = data.length - 1; i >= 0; i--) {
              addLogEntry(data[i]);
            }
          }
        } catch (e) {}
      }
    };
    xhr.send();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ---- Daftar Service Worker (syarat installability PWA) ----
  // Tanpa caching apapun — dashboard harus selalu realtime.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
// dashid: qEmDetqCH6q6Iq
