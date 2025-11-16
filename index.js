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
   🔔 ALERT STATE TRACKING
============================================================ */
let alertState = {};

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

    /* 🟢 RESET FLAGS AFTER RE-ARM */
    if (state === "demo_armed") {
      console.log(`🔁 Device ${device_id} re-armed → reset alert flags`);
      alertState[device_id] = { smsSent: false, callLock: false, callAttempts: 0 };
      return res.json({ ok: true });
    }

    /* 🚨 MOVEMENT CONFIRMED */
    if (movement_confirmed === true && twilioClient) {
      console.log(`🚨 Movement confirmed TRUE for ${device_id}`);

      if (!bucket.smsSent) {
        console.log("📨 Sending FIRST movement SMS");
        try {
          await twilioClient.messages.create({
            body: `🚨 Trackblock ALERT 🚨
${device_id} moved!
Lat:${latitude}
Lon:${longitude}`,
            from: TWILIO_FROM,
            to: ALERT_PHONE,
          });
          bucket.smsSent = true;
        } catch (err) {
          console.error("❌ Twilio SMS error:", err);
        }
      }

      if (!TWIML_VOICE_URL) {
        console.log("⚠️ TWIML_VOICE_URL not set — skipping calls");
      } else if (bucket.callLock) {
        console.log("🔒 Call engine locked — no further calls");
      } else if (bucket.callAttempts >= MAX_CALL_ATTEMPTS) {
        console.log("⚠️ Max call attempts reached");
      } else {
        bucket.callAttempts++;
        console.log(`📞 CALL ATTEMPT #${bucket.callAttempts}`);

        try {
          await twilioClient.calls.create({
            url: TWIML_VOICE_URL,
            to: ALERT_PHONE,
            from: TWILIO_FROM,
            statusCallback: "https://api.oathzsecurity.com/twilio/voice-status",
            statusCallbackMethod: "POST",
            statusCallbackEvent: ["completed", "answered", "no-answer"]
          });
        } catch (err) {
          console.error("❌ Twilio CALL error:", err);
        }
      }
    }

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ EVENT ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

/* ============================================================
   ☎️  TWILIO CALL STATUS HANDLER
============================================================ */
app.post("/twilio/voice-status", (req, res) => {
  try {
    const status     = req.body.CallStatus;
    const duration   = parseInt(req.body.CallDuration || "0", 10);
    const answeredBy = req.body.AnsweredBy;

    console.log("📞 Twilio CALLBACK:", { status, duration, answeredBy });

    if (
      status === "completed" &&
      duration >= 5 &&
      answeredBy === "human"
    ) {
      console.log("🛑 REAL HUMAN ANSWER DETECTED — locking call engine");

      Object.keys(alertState).forEach(id => {
        alertState[id].callLock = true;
      });
    } else {
      console.log("⚠️ Not a real answer — continuing call loop");
    }

    res.send("ok");
  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
    res.send("error");
  }
});

/* ============================================================
   🚀 SERVER
============================================================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`🚀 Trackblock backend running on ${PORT}`)
);
