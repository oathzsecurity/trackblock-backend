/**
 * Trackblock Backend (Railway) — DEMO SAFE + TWILIO FIRING FIX
 * -----------------------------------------------------------
 * Fixes:
 * 1) movement_confirmed can arrive as true / "true" / 1 / "1" → normalised
 * 2) demo can be repeated without redeploy → reset chaseFired + chaseSessionId on demo boot/arming
 *
 * Behaviour:
 * - Ingests /event payloads
 * - Detects LTE “online” window via timestamp freshness
 * - Starts a chase session when demo_chase + movementConfirmed hits first time
 * - Fires Twilio once per demo session (until reset)
 * - Logs all events into Postgres (with chase_session_id)
 */

import express from "express";
import cors from "cors";
import twilio from "twilio";
import pg from "pg";
import crypto from "crypto";

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

// Optional override in Railway variables
const TWIML_VOICE_URL =
  process.env.TWIML_VOICE_URL ||
  "https://trackblock-backend-production.up.railway.app/twilio/voice";

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

if (!TWILIO_SID || !TWILIO_TOKEN) console.warn("⚠ Missing Twilio SID/TOKEN");
if (!ALERT_PHONE || !FROM_NUMBER) console.warn("⚠ Missing phone numbers");

// ------------------------------------
// Device State (in-memory)
// NOTE: resets on redeploy/restart
// ------------------------------------
const deviceState = {};

// ------------------------------------
// Utils
// ------------------------------------
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

function toBoolish(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function hasValidGPS(latitude, longitude) {
  return (
    latitude !== null &&
    longitude !== null &&
    latitude !== undefined &&
    longitude !== undefined &&
    !isNaN(latitude) &&
    !isNaN(longitude)
  );
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
  const {
    device_id,
    latitude,
    longitude,
    timestamp,
    state,
    movement_confirmed,
    event_type,
    battery_voltage,
  } = req.body || {};

  console.log("📥 EVENT:", req.body);

  if (!device_id) return res.status(400).json({ error: "Missing device_id" });

  // ------------------------------------
  // Load or create device state
  // ------------------------------------
  const st =
    deviceState[device_id] || {
      lastMode: "OFFLINE",
      lastLat: null,
      lastLon: null,
      lastTimestamp: null,
      chaseFired: false,
      chaseSessionId: null,
      lowBatterySent: false,
    };

  // ------------------------------------
  // Normalise booleans (proxy-safe)
  // ------------------------------------
  const movementConfirmed = toBoolish(movement_confirmed);

  // ------------------------------------
  // DEMO RESET: allow repeated demos without redeploy
  // Some of your demo sketches send demo_boot + demo_arming_heartbeat + demo_heartbeat
  // (and state strings vary), so we reset on multiple safe signals.
  // ------------------------------------
  const isDemoResetSignal =
    event_type === "demo_boot" ||
    event_type === "demo_arming_heartbeat" ||
    event_type === "demo_heartbeat" ||
    state === "demo_arming" ||
    state === "demo_armed";

  if (isDemoResetSignal) {
    if (st.chaseFired || st.chaseSessionId) {
      console.log(`🔁 DEMO RESET for ${device_id} (ready for next demo run)`);
    }
    st.chaseFired = false;
    st.chaseSessionId = null;
  }

  // ------------------------------------
  // Time / online window
  // ------------------------------------
  const nowTs = new Date(timestamp || Date.now()).getTime();
  st.lastTimestamp = nowTs;

  const hasGPS = hasValidGPS(latitude, longitude);

  if (!hasGPS) {
    deviceState[device_id] = st;
    return res.json({ status: "ok" });
  }

  const isOnline = Date.now() - nowTs < 20000;

  if (!isOnline) {
    st.lastMode = "OFFLINE";
    deviceState[device_id] = st;
    return res.json({ status: "ok" });
  }

  // ------------------------------------
  // Movement detection (server-side)
  // ------------------------------------
  let hasMoved = false;

  if (st.lastLat !== null && st.lastLon !== null) {
    const moved = distanceMeters(st.lastLat, st.lastLon, latitude, longitude);
    if (moved >= 10) hasMoved = true;
  }

  st.lastLat = latitude;
  st.lastLon = longitude;

  st.lastMode = hasMoved ? "CHASE" : "HEARTBEAT";

  // ------------------------------------
  // Chase session handling
  // ------------------------------------
  const chaseStarted =
    (state === "demo_chase" || event_type === "demo_chase_update") &&
    movementConfirmed === true &&
    st.chaseSessionId === null;

  if (chaseStarted) {
    st.chaseSessionId = crypto.randomUUID();
    console.log(`🎯 New chase session for ${device_id}: ${st.chaseSessionId}`);
  }

  // ------------------------------------
  // Low battery alerts (optional)
  // ------------------------------------
  try {
    const lowThreshold = 12.0;
    const recoverThreshold = 12.5;
    const batt = Number(battery_voltage);

    if (!isNaN(batt)) {
      if (batt < lowThreshold && !st.lowBatterySent) {
        console.log(`🔋 LOW BATTERY for ${device_id}: ${batt.toFixed(2)}V`);

        if (TWILIO_SID && TWILIO_TOKEN && ALERT_PHONE && FROM_NUMBER) {
          twilioClient.messages
            .create({
              body: `⚠️ Trackblock ${device_id} battery is LOW (${batt.toFixed(
                2
              )}V). Please replace or recharge as soon as possible.`,
              to: ALERT_PHONE,
              from: FROM_NUMBER,
            })
            .then((msg) => console.log("📩 Low batt SMS SID:", msg.sid))
            .catch((err) => console.error("❌ Low batt SMS ERROR:", err));
        } else {
          console.warn("⚠ Skipping low battery SMS (missing Twilio vars)");
        }

        st.lowBatterySent = true;
      }

      if (batt >= recoverThreshold && st.lowBatterySent) {
        st.lowBatterySent = false;
      }
    }
  } catch (err) {
    console.error("❌ Low battery handler error:", err);
  }

  // ------------------------------------
  // REAL CHASE LOGIC (Twilio)
  // ------------------------------------
  const isRealChase =
    (state === "demo_chase" || event_type === "demo_chase_update") &&
    movementConfirmed === true &&
    st.chaseFired === false;

  if (isRealChase) {
    console.log(
      `🧠 Chase gate passed for ${device_id} | movementConfirmed=${movementConfirmed} chaseFired=${st.chaseFired}`
    );
  }

  if (
    isRealChase &&
    TWILIO_SID &&
    TWILIO_TOKEN &&
    ALERT_PHONE &&
    FROM_NUMBER
  ) {
    console.log(`🚨 REAL CHASE ACTIVATED for ${device_id}`);
    st.chaseFired = true;

    // CALL #1
    twilioClient.calls
      .create({
        url: TWIML_VOICE_URL,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((call) => console.log("📞 CALL #1 SID:", call.sid))
      .catch((err) => console.error("❌ CALL #1 ERROR:", err));

    // CALL #2 after 12s
    setTimeout(() => {
      twilioClient.calls
        .create({
          url: TWIML_VOICE_URL,
          to: ALERT_PHONE,
          from: FROM_NUMBER,
        })
        .then((call) => console.log("📞 CALL #2 SID:", call.sid))
        .catch((err) => console.error("❌ CALL #2 ERROR:", err));
    }, 12000);

    // SMS
    twilioClient.messages
      .create({
        body: `Your Trackblock ${device_id} is on the move! Dashboard: https://dashboard.oathzsecurity.com/devices/${device_id}`,
        to: ALERT_PHONE,
        from: FROM_NUMBER,
      })
      .then((msg) => console.log("📩 SMS SID:", msg.sid))
      .catch((err) => console.error("❌ SMS ERROR:", err));
  } else if (isRealChase) {
    console.warn(
      "⚠ Chase detected but Twilio not fired (missing env vars?)",
      {
        hasSid: !!TWILIO_SID,
        hasToken: !!TWILIO_TOKEN,
        hasAlert: !!ALERT_PHONE,
        hasFrom: !!FROM_NUMBER,
      }
    );
  }

  // ------------------------------------
  // Insert event (with chase_session_id)
  // ------------------------------------
  try {
    await db.query(
      `INSERT INTO events (device_id, latitude, longitude, timestamp, chase_session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        device_id,
        latitude || null,
        longitude || null,
        timestamp || new Date().toISOString(),
        st.chaseSessionId || null,
      ]
    );
  } catch (err) {
    console.error("❌ DB INSERT FAILED:", err);
  }

  deviceState[device_id] = st;
  res.json({ status: "ok" });
});

// ------------------------------------
// TWILIO VOICE WEBHOOK
// ------------------------------------
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="man">
    Trackblock is on the move. Check your dashboard now.
    Alert authorities immediately.
  </Say>
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
// START SERVER
// ------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
