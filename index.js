import express from "express";
import cors from "cors";
import twilio from "twilio";
import pg from "pg";

const app = express();

// ------------------------------------
// Middleware
// ------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ------------------------------------
// Postgres
// ------------------------------------
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const db = {
  query: (text, params) => pool.query(text, params),
};

(async () => {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ Postgres error:", err);
  }
})();

// ------------------------------------
// Twilio ENV
// ------------------------------------
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || "";
const ALERT_PHONE = process.env.ALERT_PHONE || "";
const FROM_NUMBER = process.env.FROM_NUMBER || "";

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

if (!TWILIO_SID || !TWILIO_TOKEN) console.warn("⚠ Missing Twilio SID/TOKEN");
if (!ALERT_PHONE || !FROM_NUMBER) console.warn("⚠ Missing phone numbers");

// ------------------------------------
// Device State Memory
// ------------------------------------
const deviceState = {};

function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ------------------------------------
// Root
// ------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend running" });
});

// ------------------------------------
// EVENT INGEST
// ------------------------------------
app.post("/event", async (req, res) => {
  const { device_id, latitude, longitude, timestamp } = req.body;

  console.log("📥 EVENT:", req.body);

  if (!device_id) return res.status(400).json({ error: "Missing device_id" });

  try {
    await db.query(
      `INSERT INTO events (device_id, latitude, longitude, timestamp)
       VALUES ($1, $2, $3, $4)`,
      [
        device_id,
        latitude || null,
        longitude || null,
        timestamp || new Date().toISOString(),
      ]
    );
  } catch (err) {
    console.error("❌ DB INSERT FAILED:", err);
  }

  const state =
    deviceState[device_id] || {
      lastMode: "OFFLINE",
      lastLat: null,
      lastLon: null,
      lastTimestamp: null,
    };

  const nowTs = new Date(timestamp || Date.now()).getTime();
  state.lastTimestamp = nowTs;

  const hasGPS =
    latitude !== null &&
    longitude !== null &&
    !isNaN(latitude) &&
    !isNaN(longitude);

  if (!hasGPS) {
    deviceState[device_id] = state;
    return res.json({ status: "ok" });
  }

  const isOnline = Date.now() - nowTs < 20000;

  if (!isOnline) {
    state.lastMode = "OFFLINE";
    deviceState[device_id] = state;
    return res.json({ status: "ok" });
  }

  let isChase = false;

  if (state.lastLat !== null && state.lastLon !== null) {
    const moved = distanceMeters(
      state.lastLat,
      state.lastLon,
      latitude,
      longitude
    );
    if (moved >= 10) isChase = true;
  }

  state.lastLat = latitude;
  state.lastLon = longitude;

  const previousMode = state.lastMode;
  const nextMode = isChase ? "CHASE" : "HEARTBEAT";

  state.lastMode = nextMode;
  deviceState[device_id] = state;

  // ------------------------------------
  // Twilio Alerts
  // ------------------------------------
  if (
    previousMode !== "CHASE" &&
    nextMode === "CHASE" &&
    TWILIO_SID &&
    TWILIO_TOKEN &&
    ALERT_PHONE &&
    FROM_NUMBER
  ) {
    console.log(`🚨 CHASE MODE ACTIVATED for ${device_id}`);

    twilioClient.calls
      .create({
        url: "https://trackblock-backend-production.up.railway.app/twilio/voice",
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((call) => console.log("📞 Call SID:", call.sid))
      .catch((err) => console.error("❌ CALL ERROR:", err));

    twilioClient.messages
      .create({
        body: `Your Trackblock ${device_id} is on the move! Dashboard: https://dashboard.oathzsecurity.com/devices/${device_id}`,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((msg) => console.log("📩 SMS SID:", msg.sid))
      .catch((err) => console.error("❌ SMS ERROR:", err));
  }

  res.json({ status: "ok" });
});
// ------------------------------------
// TWILIO VOICE WEBHOOK
// ------------------------------------
app.post("/twilio/voice", (req, res) => {
  const deviceId = req.query.device_id || "your Trackblock";

  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man">
    Trackblock is on the move. Check your dashboard now for current live position.
    Alert the authorities — call the police.
    Repeat. Trackblock is on the move.
    Trackblock is on the move. Check your dashboard now.
    Alert authorities immediately. Repeat. Trackblock is on the move.
  </Say>
</Response>`);
});

// ------------------------------------
// TWILIO SMS WEBHOOK (optional)
// ------------------------------------
app.post("/twilio/sms", (req, res) => {
  const deviceId = req.query.device_id || "unknown";
  const link = `https://dashboard.oathzsecurity.com/devices/${deviceId}`;

  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>
    Your Trackblock is on the move! Check your dashboard NOW for current live position.
    ${link}
  </Message>
</Response>`);
});

// ------------------------------------
// DEVICES LIST
// ------------------------------------
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
    console.error("❌ devices error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// ------------------------------------
// DEVICE EVENT HISTORY
// ------------------------------------
app.get("/device/:id/events", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM events
       WHERE device_id = $1
       ORDER BY timestamp ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ events error:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ------------------------------------
// TEST ENDPOINT
// ------------------------------------
app.get("/test-log", (req, res) => {
  res.json({ ok: true });
});

// ------------------------------------
// START SERVER
// ------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
