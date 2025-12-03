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
const db = { query: (text, params) => pool.query(text, params) };

(async () => {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ Postgres error:", err);
  }
})();

// =============================
// TWILIO SETUP
// =============================
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;

const ALERT_PHONE = process.env.ALERT_PHONE || "";
const FROM_NUMBER = process.env.FROM_NUMBER;

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// =============================
// DEVICE STATE MEMORY
// =============================
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

// =============================
// ROOT
// =============================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock server running" });
});

// =============================
// TWILIO WEBHOOKS (THE MISSING PIECE)
// =============================

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
const db = { query: (text, params) => pool.query(text, params) };

(async () => {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ Postgres error:", err);
  }
})();

// =============================
// TWILIO SETUP
// =============================
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;

const ALERT_PHONE = process.env.ALERT_PHONE;   // Destination (user)
const FROM_NUMBER = process.env.FROM_NUMBER;   // Twilio number

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// =============================
// IN-MEMORY DEVICE STATE
// =============================
const deviceState = {};

// distance helper
function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = v => (v * Math.PI) / 180;
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

// =============================
// ROOT
// =============================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend running" });
});

// =============================
// EVENT INGESTION
// =============================
app.post("/event", async (req, res) => {
  const { device_id, latitude, longitude, timestamp } = req.body;

  console.log("📥 EVENT:", req.body);

  if (!device_id) {
    return res.status(400).json({ error: "Missing device_id" });
  }

  // store event
  try {
    await db.query(
      `INSERT INTO events (device_id, latitude, longitude, timestamp)
       VALUES ($1, $2, $3, $4)`,
      [device_id, latitude || null, longitude || null, timestamp || new Date().toISOString()]
    );
  } catch (err) {
    console.error("❌ DB INSERT FAILED:", err);
  }

  // load state
  const state =
    deviceState[device_id] || {
      lastMode: "OFFLINE",
      lastLat: null,
      lastLon: null,
      lastTimestamp: null,
    };

  const nowTs = new Date(timestamp).getTime();
  state.lastTimestamp = nowTs;

  const hasGPS =
    latitude !== null &&
    longitude !== null &&
    !isNaN(latitude) &&
    !isNaN(longitude);

  // heartbeat-only (no GPS)
  if (!hasGPS) {
    deviceState[device_id] = state;
    return res.json({ status: "ok" });
  }

  // online?
  const isOnline = Date.now() - nowTs < 20_000;

  if (!isOnline) {
    state.lastMode = "OFFLINE";
    deviceState[device_id] = state;
    return res.json({ status: "ok" });
  }

  // movement detection
  let isChase = false;

  if (state.lastLat !== null && state.lastLon !== null) {
    const moved = distanceMeters(
      state.lastLat,
      state.lastLon,
      latitude,
      longitude
    );

    if (moved >= 10) {
      isChase = true;
    }
  }

  // update stored GPS location
  state.lastLat = latitude;
  state.lastLon = longitude;

  // compute next mode
  const previousMode = state.lastMode;
  const nextMode = isChase ? "CHASE" : "HEARTBEAT";

  state.lastMode = nextMode;
  deviceState[device_id] = state;

  // =============================
  // TWILIO ALERT — ONLY WHEN ENTERING CHASE
  // =============================
  if (previousMode !== "CHASE" && nextMode === "CHASE") {
    console.log(`🚨 CHASE MODE ACTIVATED for ${device_id}`);

    // ---- VOICE CALL ----
    console.log("📞 Sending Twilio CALL...");
    twilioClient.calls
      .create({
        url: `https://api.oathzsecurity.com/twilio/voice?device_id=${device_id}`,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then(call => console.log("📞 Call SID:", call.sid))
      .catch(err => console.error("❌ CALL ERROR:", err));

    // ---- SMS ----
    console.log("📩 Sending Twilio SMS…");
    twilioClient.messages
      .create({
        body: `Your Trackblock ${device_id} is on the move! Live tracking: https://dashboard.oathzsecurity.com/devices/${device_id}`,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then(msg => console.log("📩 SMS SID:", msg.sid))
      .catch(err => console.error("❌ SMS ERROR:", err));
  }

  res.json({ status: "ok" });
});

// =============================
// GET /devices
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
    console.error("❌ devices error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// =============================
// GET /device/:id/events
// =============================
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

// =============================
// TWILIO VOICE WEBHOOK
// =============================
app.post("/twilio/voice", (req, res) => {
  const deviceId = req.query.device_id || "your Trackblock";

  res.type("text/xml");
  res.send(`
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">
        Trackblock is on the move. Check your dashboard now for current live position.
        Alert the authorities — call the police.
        Repeat. Trackblock is on the move.
      </Say>
    </Response>
  `);
});

// =============================
// TWILIO SMS WEBHOOK
// =============================
app.post("/twilio/sms", (req, res) => {
  const deviceId = req.query.device_id || "unknown";
  const link = `https://dashboard.oathzsecurity.com/devices/${deviceId}`;

  res.type("text/xml");
  res.send(`
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Message>
        Your Trackblock is on the move! Check your dashboard NOW for current live position. ${link}
      </Message>
    </Response>
  `);
});

// =============================
// TEST ENDPOINT
// =============================
app.get("/test-log", (req, res) => {
  res.json({ ok: true });
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Backend running on port ${PORT}`)
);

// =============================
// EVENT INGEST + CHASE DETECTION
// =============================
app.post("/event", async (req, res) => {
  const { device_id, latitude, longitude, timestamp } = req.body;

  console.log("📥 EVENT:", req.body);

  if (!device_id) {
    return res.status(400).json({ error: "Missing device_id" });
  }

  // DB insert
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

  // DEVICE ONLINE/OFFLINE STATE
  const state = deviceState[device_id] || {
    lastMode: "OFFLINE",
    lastLat: null,
    lastLon: null,
    lastTimestamp: null,
  };

  const nowTs = new Date(timestamp).getTime();
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

  // MOVE DETECTION
  let isChase = false;

  if (state.lastLat !== null && state.lastLon !== null) {
    const moved = distanceMeters(
      state.lastLat,
      state.lastLon,
      latitude,
      longitude
    );

    if (moved >= 10) {
      isChase = true;
    }
  }

  state.lastLat = latitude;
  state.lastLon = longitude;

  const previousMode = state.lastMode;
  const nextMode = isChase ? "CHASE" : "HEARTBEAT";

  state.lastMode = nextMode;
  deviceState[device_id] = state;

  // TWILIO ALERT: transition into chase
  if (previousMode !== "CHASE" && nextMode === "CHASE") {
    console.log(`🚨 CHASE MODE ACTIVATED for ${device_id}`);

    console.log("📞 Sending Twilio CALL...");
    twilioClient.calls
      .create({
        url: "https://api.oathzsecurity.com/twilio/voice",
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((call) => console.log("📞 Call SID:", call.sid))
      .catch((err) => console.error("❌ CALL ERROR:", err));

    console.log("📩 Sending Twilio SMS…");
    twilioClient.messages
      .create({
        body: `TRACKBLOCK ALERT: ${device_id} has entered CHASE MODE.`,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((msg) => console.log("📩 SMS SID:", msg.sid))
      .catch((err) => console.error("❌ SMS ERROR:", err));
  }

  res.json({ status: "ok" });
});

// =============================
// GET /devices
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
    console.error("❌ devices error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// =============================
// GET /device/:id/events
// =============================
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

// =============================
app.get("/test-log", (req, res) => {
  res.json({ ok: true });
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Backend running on port ${PORT}`)
);
