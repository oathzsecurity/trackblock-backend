import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import twilio from "twilio";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* ============================================================
   🗄 POSTGRES
============================================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ DB connection failed:", err);
  }
})();

/* ============================================================
   ☎️ TWILIO CONFIG
============================================================ */
const TWILIO_SID      = process.env.TWILIO_SID;
const TWILIO_TOKEN    = process.env.TWILIO_TOKEN;
const TWILIO_FROM     = process.env.TWILIO_FROM;
const ALERT_PHONE     = process.env.ALERT_PHONE;
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;

let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("📡 Twilio client initialised");
} else {
  console.log("⚠️ Twilio NOT configured — alerts disabled");
}

/* ============================================================
   🔔 STATE TRACKING
============================================================ */
let alertState = {};
function bucket(id) {
  if (!alertState[id])
    alertState[id] = { smsSent: false, callLock: false, callAttempts: 0 };
  return alertState[id];
}

/* ============================================================
   🟢 HEALTH CHECK
============================================================ */
app.get("/", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ============================================================
   🆕 NEW ENDPOINT → UI LIVE DASHBOARD
============================================================ */
app.get("/status", async (req, res) => {
  try {
    const q = `
      SELECT DISTINCT ON (device_id)
        device_id, event_type, state, movement_confirmed, gps_fix,
        latitude, longitude,
        created_at as last_seen
      FROM device_logs
      ORDER BY device_id, created_at DESC;
    `;

    const result = await pool.query(q);
    return res.json(result.rows);
  } catch (err) {
    console.error("❌ STATUS DB ERR", err);
    res.status(500).json({ error: "db error" });
  }
});

/* ============================================================
   🛰 EVENT INGESTION
============================================================ */
app.post("/event", async (req, res) => {
  try {
    const {
      device_id,
      event_type,
      latitude,
      longitude,
      movement_confirmed,
      state,
      gps_fix,
    } = req.body;

    if (!device_id) return res.status(400).json({ error: "Missing device_id" });

    const b = bucket(device_id);

    console.log("📥 Incoming event:", req.body);

    await pool.query(
      `INSERT INTO device_logs
      (device_id, event_type, latitude, longitude, state, movement_confirmed, gps_fix)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        device_id,
        event_type,
        latitude || null,
        longitude || null,
        state || null,
        movement_confirmed ?? null,
        gps_fix ?? null,
      ]
    );

    console.log("💾 DB WRITE OK");

    if (state === "demo_armed") {
      console.log(`🔁 RESET alert flags for ${device_id}`);
      alertState[device_id] = { smsSent: false, callLock: false, callAttempts: 0 };
      return res.json({ ok: true });
    }

    /* =====================================================
       🚨 MOVEMENT CONFIRMED
    ====================================================== */
    if (movement_confirmed === true && twilioClient) {
      console.log(`🚨 MOVEMENT TRUE for ${device_id}`);

      if (!b.smsSent) {
        console.log("📨 Sending FIRST SMS alert...");
        try {
          await twilioClient.messages.create({
            body: `🚨 Trackblock ALERT 🚨
${device_id} moved!
Lat:${latitude}
Lon:${longitude}`,
            from: TWILIO_FROM,
            to: ALERT_PHONE,
          });
          b.smsSent = true;
        } catch (err) {
          console.error("❌ SMS ERROR:", err);
        }
      }

      if (!TWIML_VOICE_URL) {
        console.log("⚠️ TWIML URL missing — skip calls");
      } else if (b.callLock) {
        console.log("🔒 CALL ENGINE LOCKED");
      } else if (b.callAttempts >= 2) {
        console.log("🛑 TWO CALLS MADE — LOCKING");
        b.callLock = true;
      } else {
        b.callAttempts++;
        console.log(`☎ FORCED CALL #${b.callAttempts}`);

        try {
          await twilioClient.calls.create({
            url: TWIML_VOICE_URL,
            to: ALERT_PHONE,
            from: TWILIO_FROM,
            statusCallback: "https://api.oathzsecurity.com/twilio/voice-status",
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["completed"],
          });
        } catch (err) {
          console.error("❌ CALL ERROR:", err);
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ EVENT ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

/* ============================================================
   ☎️ TWILIO CALLBACK
============================================================ */
app.post("/twilio/voice-status", (req, res) => {
  console.log("📞 CALLBACK RECEIVED:", req.body.CallStatus);
  res.type("text/plain").send("ok");
});

/* ============================================================
   🚀 SERVER
============================================================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`🚀 Trackblock backend running on ${PORT}`)
);
