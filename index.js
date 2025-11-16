import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import twilio from "twilio";

const app = express();

// Parse JSON (device → backend) AND urlencoded (Twilio → backend)
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
   ☎️  TWILIO CONFIG
============================================================ */
const TWILIO_SID      = process.env.TWILIO_SID;
const TWILIO_TOKEN    = process.env.TWILIO_TOKEN;
const TWILIO_FROM     = process.env.TWILIO_FROM;      // Your Twilio number
const ALERT_PHONE     = process.env.ALERT_PHONE;      // Your mobile
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;  // Your TwiML Bin URL

const MAX_CALL_ATTEMPTS = 10;

let twilioClient = null;

if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("📡 Twilio client initialised");
} else {
  console.log("⚠️ Twilio NOT configured — alerts disabled");
}

/* ============================================================
   🩺 HEALTH CHECK
============================================================ */
app.get("/", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ============================================================
   🔔 ALERT STATE TRACKING (in-memory)
============================================================ */
let alertState = {};
/*
  alertState = {
    "TB-DEMO-001": {
      smsSent: false,
      callLock: false,     // true once a call has been completed
      callAttempts: 0
    }
  }
*/

function getAlertBucket(deviceId) {
  if (!alertState[deviceId]) {
    alertState[deviceId] = { smsSent: false, callLock: false, callAttempts: 0 };
  }
  return alertState[deviceId];
}

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

    if (!device_id) {
      return res.status(400).json({ error: "Missing device_id" });
    }

    console.log("📥 Incoming event:", req.body);

    const bucket = getAlertBucket(device_id);

    // ---- DB WRITE ----
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

    /* =====================================================
       🔁 RESET ON RE-ARM
       When state goes back to "demo_armed", wipe flags
    ====================================================== */
    if (state === "demo_armed") {
      console.log(`🔁 Device ${device_id} re-armed → reset alert flags`);
      alertState[device_id] = { smsSent: false, callLock: false, callAttempts: 0 };
      return res.json({ ok: true, reset: true });
    }

    /* =====================================================
       🚨 MOVEMENT CONFIRMED → ALERT ENGINE
       - Guaranteed ONE SMS when movement_confirmed = true
       - Repeated calls until one is completed
    ====================================================== */

    const moved = movement_confirmed === true;

    if (moved && twilioClient) {
      console.log(`🚨 Movement confirmed TRUE for ${device_id}`);

      // ---------- 1️⃣ GUARANTEED SINGLE SMS ----------
      if (!bucket.smsSent) {
        console.log("📨 Sending FIRST movement SMS");
        try {
          await twilioClient.messages.create({
            body: `🚨 Trackblock ALERT 🚨
${device_id} moved!
Lat:${latitude}
Lon:${longitude}`,
            from: TWILIO_FROM,
            to:   ALERT_PHONE,
          });
          bucket.smsSent = true;
        } catch (err) {
          console.error("❌ Twilio SMS error:", err);
        }
      } else {
        console.log("⚠️ SMS already sent for this arming session — skipping");
      }

      // ---------- 2️⃣ CALL ENGINE ----------
      if (!TWIML_VOICE_URL) {
        console.log("⚠️ TWIML_VOICE_URL not set — skipping calls");
      } else if (bucket.callLock) {
        console.log("🔒 Call engine locked (call already completed) — no further calls");
      } else if (bucket.callAttempts >= MAX_CALL_ATTEMPTS) {
        console.log("⚠️ Max call attempts reached — no further calls");
      } else {
        bucket.callAttempts += 1;
        console.log(`📞 CALL ATTEMPT #${bucket.callAttempts} for ${device_id}`);

        try {
          await twilioClient.calls.create({
            url: TWIML_VOICE_URL,
            to: ALERT_PHONE,
            from: TWILIO_FROM,
            statusCallback: "https://api.oathzsecurity.com/twilio/voice-status",
            statusCallbackEvent: ["completed"],
            statusCallbackMethod: "POST",
          });
        } catch (err) {
          console.error("❌ Twilio CALL error:", err);
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
   ☎️  TWILIO CALL STATUS WEBHOOK
   Twilio POSTs here when a call is completed.
============================================================ */
app.post("/twilio/voice-status", (req, res) => {
  try {
    const callStatus = req.body.CallStatus;
    const callSid    = req.body.CallSid;

    console.log("📞 Twilio voice-status callback:", {
      CallStatus: callStatus,
      CallSid: callSid,
    });

    // When a call reaches "completed", treat it as answered/handled.
    if (callStatus === "completed") {
      console.log("🛑 Call completed → locking call engine for all devices");
      Object.keys(alertState).forEach((id) => {
        alertState[id].callLock = true;
      });
    }

    res.type("text/plain").send("ok");
  } catch (err) {
    console.error("❌ Voice callback error:", err);
    res.type("text/plain").send("error");
  }
});

/* ============================================================
   🚀 SERVER
============================================================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Trackblock backend running on ${PORT}`);
});
