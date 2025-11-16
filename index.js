import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import twilio from "twilio";

const app = express();
app.use(bodyParser.json());

/* ============================================================
   🗄 POSTGRES
============================================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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
const TWILIO_SID       = process.env.TWILIO_SID;
const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
const TWILIO_FROM      = process.env.TWILIO_FROM;      // Your Twilio number
const ALERT_PHONE      = process.env.ALERT_PHONE;      // Your mobile
const TWIML_VOICE_URL  = process.env.TWIML_VOICE_URL;  // Your TwiML Bin URL

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
/*
  alertState = {
     "TB-DEMO-001": {
         smsSent: false,
         callLock: false,   // becomes TRUE after call answered
         callAttempts: 0
     }
  }
*/

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
      gps_fix
    } = req.body;

    if (!device_id) return res.status(400).json({ error: "Missing device_id" });

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
        gps_fix ?? null
      ]
    );

    console.log("💾 DB WRITE OK");

    /* =====================================================
       🔁 RESET ALERT FLAGS WHEN DEVICE RETURNS TO ARMED
    ====================================================== */
    if (state === "demo_armed") {
      console.log("🔁 Device re-armed → reset alert flags");
      alertState[device_id] = { smsSent: false, callLock: false, callAttempts: 0 };
      return res.json({ ok: true });
    }

    /* Ensure bucket exists */
    if (!alertState[device_id]) {
      alertState[device_id] = { smsSent: false, callLock: false, callAttempts: 0 };
    }

    /* =====================================================
       🚨 MOVEMENT CONFIRMED → ALERT ENGINE
    ====================================================== */
    if (movement_confirmed === true && twilioClient) {
      console.log("🚨 Movement confirmed TRUE");

      /* ---------- 1️⃣ SEND SMS ONCE ONLY ---------- */
      if (!alertState[device_id].smsSent) {
        console.log("📨 Sending FIRST movement SMS");

        await twilioClient.messages.create({
          body: `🚨 Trackblock ALERT 🚨
${device_id} moved!
Lat:${latitude}
Lon:${longitude}`,
          from: TWILIO_FROM,
          to: ALERT_PHONE
        });

        alertState[device_id].smsSent = true;
      }

      /* ---------- 2️⃣ INITIATE CALL LOOP ---------- */
      if (!alertState[device_id].callLock) {
        alertState[device_id].callAttempts++;
        console.log(`📞 CALL ATTEMPT #${alertState[device_id].callAttempts}`);

        await twilioClient.calls.create({
          url: TWIML_VOICE_URL,
          to: ALERT_PHONE,
          from: TWILIO_FROM,
          statusCallback: "https://api.oathzsecurity.com/twilio/voice-status",
          statusCallbackEvent: ["completed"],
          statusCallbackMethod: "POST"
        });
      }

      return res.json({ ok: true });
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ EVENT ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

/* ============================================================
   ☎️  TWILIO CALL STATUS WEBHOOK
============================================================ */
app.post("/twilio/voice-status", async (req, res) => {
  try {
    const callStatus = req.body.CallStatus;
    console.log("📞 Twilio callback:", callStatus);

    if (callStatus === "completed") {
      console.log("🛑 CALL ANSWERED → LOCKING ALERT ENGINE");
      for (const d in alertState) {
        alertState[d].callLock = true;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("❌ Voice callback error:", err);
    res.json({ received: true });
  }
});

/* ============================================================
   🚀 SERVER
============================================================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Trackblock backend running on ${PORT}`));
