import express from "express";
import cors from "cors";
import axios from "axios";
import twilio from "twilio";
import pg from "pg";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =============================
// POSTGRES SETUP (HARDENED)
// =============================
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway friendly
});

// Lightweight DB helper to avoid repeated connect/release
const db = {
  query: (text, params) => pool.query(text, params),
};

(async () => {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ Postgres connection error:", err);
  }
})();

// =============================
// ENV + TWILIO SETUP
// =============================
const TWILIO_SID =
  process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "";
const TWILIO_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "";
const ALERT_PHONE = process.env.ALERT_PHONE || "";
const client = twilio(TWILIO_SID, TWILIO_TOKEN);

// =============================
// ROOT
// =============================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock server running" });
});

// =============================
// EVENT ENDPOINT
// Device → Server → Database
// =============================
app.post("/event", async (req, res) => {
  console.log("📥 Incoming /event POST");
  console.log("Body:", req.body);

  try {
    const {
      device_id,
      latitude,
      longitude,
      mac_addresses,
      timestamp,
    } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: "Missing device_id" });
    }

    const macs = Array.isArray(mac_addresses)
      ? mac_addresses
      : [];

    const queryText = `
      INSERT INTO events
      (device_id, latitude, longitude, mac_addresses, timestamp)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const result = await db.query(queryText, [
      device_id,
      latitude || null,
      longitude || null,
      macs,
      timestamp || new Date().toISOString(),
    ]);

    console.log("✅ DB INSERT SUCCESS:", result.rows[0]);

    return res.json({
      status: "ok",
      inserted: result.rows[0],
    });
  } catch (err) {
    console.error("❌ ERROR inserting event:", err);
    return res.status(500).json({
      error: "DB insert failed",
      details: err.message,
    });
  }
});

// =============================
// HEALTH CHECK
// =============================
app.get("/test-log", (req, res) => {
  res.json({ message: "Test log endpoint works!" });
});

// =============================
// SERVER START
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
