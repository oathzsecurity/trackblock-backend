import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// ------------------------------------------------------
// 📦 POSTGRES CONNECTION
// ------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB connection at boot
(async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ DB connection failed:", err);
  }
})();

// ------------------------------------------------------
// 🟢 HEALTH CHECK
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "online", time: new Date().toISOString() });
});

// ------------------------------------------------------
// 🚨 DEVICE EVENT INGEST
// ------------------------------------------------------
app.post("/event", async (req, res) => {
  try {
    const {
      device_id,
      event_type,
      latitude,
      longitude,
      state,
      gps_fix,
      movement_confirmed
    } = req.body;

    // --------------------------------------
    // ❗ VALIDATION
    // --------------------------------------
    if (!device_id || !event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // --------------------------------------
    // 🗄 INSERT INTO DATABASE
    // --------------------------------------
    await pool.query(
      `INSERT INTO device_logs
       (device_id, event_type, latitude, longitude, state, gps_fix, movement_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        device_id,
        event_type,
        latitude ?? null,
        longitude ?? null,
        state ?? null,
        gps_fix ?? null,
        movement_confirmed ?? null
      ]
    );

    console.log("📡 EVENT LOGGED:", req.body);

    // ------------------------------------------------------
    // 🚨 **MOVEMENT CONFIRMED → FORWARD TO TB-PROXY**
    // ------------------------------------------------------
    if (movement_confirmed === true) {
      console.log("⚠️  MOVEMENT DETECTED → FORWARDING TO tb-proxy...");

      try {
        await axios.post(
          "https://track.oathzsecurity.com/twilio/alert",
          {
            device_id,
            latitude,
            longitude,
            state,
            event_type
          },
          { timeout: 6000 }
        );

        console.log("📨 Alert forwarded successfully to tb-proxy");

      } catch (err) {
        console.error("❌ Failed to forward alert:", err.message);
      }
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ INSERT FAILED:", err);
    return res.status(500).json({ error: "DB insert failed" });
  }
});

// ------------------------------------------------------
// 🚀 START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Trackblock backend running on port ${PORT}`);
});
