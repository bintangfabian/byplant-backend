/*
  PlantWatch Backend
  ==================
  Alur data:
  HiveMQ Cloud (MQTT) --> server.js --> SQLite (simpan) --> Socket.io (realtime ke browser)
                                                         --> REST API (historis)

  Cara run:
    npm install
    cp .env.example .env   (lalu isi .env dengan kredensial kamu)
    npm run dev            (development dengan auto-reload)
    npm start              (production)
*/

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const Database = require("better-sqlite3");
const path = require("path");

// ============================================================
// SETUP EXPRESS & HTTP SERVER
// ============================================================
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

// ============================================================
// SETUP SOCKET.IO (WebSocket ke browser)
// ============================================================
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

// ============================================================
// SETUP DATABASE SQLite
// ============================================================
const db = new Database(process.env.DB_PATH || "./plantwatch.db");

// Buat tabel jika belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    soil_pct    INTEGER NOT NULL,
    soil_status TEXT NOT NULL,
    soil_raw    INTEGER,
    recorded_at INTEGER NOT NULL  -- Unix timestamp (ms)
  );

  CREATE INDEX IF NOT EXISTS idx_recorded_at ON sensor_readings(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_device_id   ON sensor_readings(device_id);
`);

// Prepared statements (lebih cepat dari query string biasa)
const insertReading = db.prepare(`
  INSERT INTO sensor_readings (device_id, soil_pct, soil_status, soil_raw, recorded_at)
  VALUES (@device_id, @soil_pct, @soil_status, @soil_raw, @recorded_at)
`);

const getHistory = db.prepare(`
  SELECT * FROM sensor_readings
  WHERE device_id = @device_id
    AND recorded_at >= @since
  ORDER BY recorded_at ASC
`);

const getLatest = db.prepare(`
  SELECT * FROM sensor_readings
  WHERE device_id = @device_id
  ORDER BY recorded_at DESC
  LIMIT 1
`);

// Cleanup data lama (jalankan tiap jam)
const cleanOld = db.prepare(`
  DELETE FROM sensor_readings
  WHERE recorded_at < @cutoff
`);

setInterval(() => {
  const hours = parseInt(process.env.HISTORY_HOURS || "24");
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const result = cleanOld.run({ cutoff });
  if (result.changes > 0) {
    console.log(`[DB] Hapus ${result.changes} data lama (> ${hours} jam)`);
  }
}, 60 * 60 * 1000); // tiap 1 jam

// ============================================================
// SETUP MQTT CLIENT (connect ke HiveMQ Cloud)
// ============================================================
const mqttClient = mqtt.connect({
  host: process.env.MQTT_BROKER,
  port: parseInt(process.env.MQTT_PORT || "8883"),
  protocol: "mqtts",  // MQTT over TLS
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: process.env.MQTT_CLIENT_ID || "plantwatch-backend-001",
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

mqttClient.on("connect", () => {
  console.log("[MQTT] Terhubung ke HiveMQ Cloud!");

  // Subscribe ke semua topic plantwatch
  mqttClient.subscribe("plantwatch/#", (err) => {
    if (err) {
      console.error("[MQTT] Gagal subscribe:", err.message);
    } else {
      console.log("[MQTT] Subscribe ke plantwatch/# berhasil");
    }
  });
});

mqttClient.on("error", (err) => {
  console.error("[MQTT] Error:", err.message);
});

mqttClient.on("reconnect", () => {
  console.log("[MQTT] Reconnecting...");
});

mqttClient.on("offline", () => {
  console.log("[MQTT] Offline dari broker");
});

// ============================================================
// HANDLE PESAN MQTT MASUK
// ============================================================
mqttClient.on("message", (topic, rawMessage) => {
  let payload;
  try {
    payload = JSON.parse(rawMessage.toString());
  } catch (e) {
    console.warn("[MQTT] Pesan bukan JSON:", rawMessage.toString());
    return;
  }

  console.log(`[MQTT] Terima dari ${topic}:`, payload);

  // Handle topic sensor data
  if (topic === "plantwatch/sensor") {
    const reading = {
      device_id:   payload.device_id || "unknown",
      soil_pct:    payload.soil_pct ?? 0,
      soil_status: payload.soil_status || "unknown",
      soil_raw:    payload.soil_raw ?? null,
      recorded_at: Date.now(),
    };

    // 1. Simpan ke database
    try {
      insertReading.run(reading);
    } catch (dbErr) {
      console.error("[DB] Gagal insert:", dbErr.message);
    }

    // 2. Broadcast realtime ke semua browser yang terhubung via Socket.io
    io.emit("sensor:update", {
      ...reading,
      topic,
    });

    console.log(`[Live] Broadcast ke ${io.engine.clientsCount} client(s)`);
  }

  // Handle topic status device
  if (topic === "plantwatch/status") {
    io.emit("device:status", payload);
  }
});

// ============================================================
// SOCKET.IO — Handle koneksi browser
// ============================================================
io.on("connection", (socket) => {
  console.log(`[Socket.io] Browser terhubung: ${socket.id}`);

  // Kirim data terbaru langsung saat browser connect
  const latest = getLatest.get({ device_id: "plantwatch-nano-001" });
  if (latest) {
    socket.emit("sensor:latest", latest);
  }

  socket.on("disconnect", () => {
    console.log(`[Socket.io] Browser disconnect: ${socket.id}`);
  });
});

// ============================================================
// REST API ENDPOINTS
// ============================================================

// GET /api/history?device_id=xxx&hours=24
// Ambil data historis untuk grafik
app.get("/api/history", (req, res) => {
  const deviceId = req.query.device_id || "plantwatch-nano-001";
  const hours = parseInt(req.query.hours || "24");
  const since = Date.now() - hours * 60 * 60 * 1000;

  const rows = getHistory.all({ device_id: deviceId, since });
  res.json({ ok: true, count: rows.length, data: rows });
});

// GET /api/latest?device_id=xxx
// Ambil data terbaru satu record
app.get("/api/latest", (req, res) => {
  const deviceId = req.query.device_id || "plantwatch-nano-001";
  const row = getLatest.get({ device_id: deviceId });
  res.json({ ok: true, data: row || null });
});

// GET /api/health
// Cek status server (untuk monitoring)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mqtt: mqttClient.connected ? "connected" : "disconnected",
    sockets: io.engine.clientsCount,
    uptime: Math.floor(process.uptime()),
  });
});

// ============================================================
// JALANKAN SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n====================================`);
  console.log(`  PlantWatch Backend berjalan`);
  console.log(`  Port     : ${PORT}`);
  console.log(`  MQTT     : ${process.env.MQTT_BROKER}`);
  console.log(`  Database : ${process.env.DB_PATH || "./plantwatch.db"}`);
  console.log(`====================================\n`);
});
