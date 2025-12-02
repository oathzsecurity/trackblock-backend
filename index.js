import express from "express";
import cors from "cors";
import twilio from "twilio";
import pg from "pg";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =============================
// POSTGRES SETUP
// =============================
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// DB wrapper
const db = {
  query: (text, params) => pool.query(text, params),
};

// Confirm DB connection
(async () => {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ Postgres connection error:", err);
  }
})();

// =============================
// TWILIO (optional for now)
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
// POST /event
// DEVICE → SERVER → DATABASE
// =============================
app.post("/event", async (req, res) => {
  console.log("📥 Incoming /event");
  console.log(req.body);

  try {
    const { device_id, latitude, longitude, timestamp } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: "Missing device_id" });
    }

    const result = await db.query(
      `
      INSERT INTO events (device_id, latitude, longitude, timestamp)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        device_id,
        latitude || null,
        longitude || null,
        timestamp || new Date().toISOString(),
      ]
    );

    console.log("✅ DB INSERT:", result.rows[0]);

    res.json({ status: "ok", inserted: result.rows[0] });
  } catch (err) {
    console.error("❌ DB INSERT ERROR:", err);
    res.status(500).json({ error: "DB insert failed", details: err.message });
  }
});

// =============================
// GET /devices
// List all devices + last seen
// =============================
app.get("/devices", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT device_id, MAX(timestamp) AS last_seen
      FROM events
      GROUP BY device_id
      ORDER BY last_seen DESC;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching devices:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// =============================
// GET /device/:id/events
// Raw event history
// =============================
app.get("/device/:id/events", async (req, res) => {
  try {
    const deviceId = req.params.id;

    const result = await db.query(
      `
      SELECT *
      FROM events
      WHERE device_id = $1
      ORDER BY timestamp DESC;
      `,
      [deviceId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching device events:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// =============================
// GET /device/:id/status
// The MOST IMPORTANT ENDPOINT
// UI uses it to show the map
// =============================
app.get("/device/:id/status", async (req, res) => {
  const { id } = req.params;

  try {
    // Only fetch REAL gps entries
    const result = await db.query(
      `
      SELECT latitude, longitude, timestamp
      FROM events
      WHERE device_id = $1
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 1;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({
        device_id: id,
        latitude: null,
        longitude: null,
        last_seen: null,
      });
    }

    const row = result.rows[0];

    res.json({
      device_id: id,
      latitude: row.latitude,
      longitude: row.longitude,
      last_seen: row.timestamp,
    });
  } catch (err) {
    console.error("❌ STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to load device status" });
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
