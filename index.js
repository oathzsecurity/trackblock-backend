import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import twilio from "twilio";

const app = express();
app.use(bodyParser.json());

/* ============================================================
   🚨  POSTGRES
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
   📡  TWILIO
============================================================ */
const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM;     // Your Twilio number
const ALERT_PHONE  = process.env.ALERT_PHONE;     // Your personal number

let twilioClient = null;

if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("📡 Twilio client initialised");
} else {
  console.log("⚠️  Twilio NOT configured — alerts disabled");
}

/* ============================================================
   🩺 HEALTH CHECK
============================================================ */
app.get("/", (req, res) => {
  res.json({ status: "online", time: new Date().toISOString() });
});

/* ============================================================
   🔔  ALERT MEMORY
============================================================ */
let alertState = {};   
// { device_id: { smsSent:true/false , callAttempts:number } }

/* ============================================================
   🛰️  EVENT INGESTION
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

    if (!device_id || !event_type)
      return res.status(400).json({ error: "Missing required fields" });

    console.log("📥 Incoming event:", req.body);

    /* -------------------------------
       DB WRITE
    --------------------------------*/
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
       🔄 RESET ALERTS IF DEVICE RETURNS TO ARMED
    ====================================================== */
    if (state === "demo_armed") {
      console.log("🔁 Reset alert flags (device armed)");

      alertState[device_id] = {
        smsSent: false,
        callAttempts: 0
      };

      return res.json({ ok: true });
    }

    // Ensure device bucket exists
    if (!alertState[device_id])
      alertState[device_id] = { smsSent: false, callAttempts: 0 };

    /* =====================================================
       🚨 MOVEMENT CONFIRMED
    ====================================================== */
    if (movement_confirmed === true && twilioClient) {
      console.log("🚨 movement_confirmed = TRUE");

      /* ---------- 1️⃣  SEND SMS ON FIRST ALERT ONLY ---------- */
      if (!alertState[device_id].smsSent) {
        console.log("📨 Sending FIRST + ONLY SMS alert");

        await twilioClient.messages.create({
          body: `🚨 Trackblock ALERT 🚨
${device_id} moved!
Lat:${latitude}
Lon:${longitude}`,
          from: TWILIO_FROM,
          to: ALERT_PHONE
        });

        alertState[device_id].smsSent = true;
      } else {
        console.log("⚠️ SMS suppressed — already sent");
      }

      /* ---------- 2️⃣  AUTO-CALL ENGINE ---------- */
      const TWIML_URL = "https://handler.twilio.com/twiml/EH729270a9e42552edc9c3256bfacdf175";  // 🔥 YOUR VOICE SCRIPT

      const MAX_CALLS = 10;               // 🔁 10 attempts max
      const CALL_INTERVAL_MS = 30 * 1000; // ⏱️ 30 seconds between rings

      async function triggerCallCycle() {
        const st = alertState[device_id];

        if (st.callAttempts >= MAX_CALLS) {
          console.log(`⛔ CALL ENGINE STOPPED — reached ${MAX_CALLS} attempts`);
          return;
        }

        st.callAttempts++;
        console.log(`📞 CALL ATTEMPT ${st.callAttempts}/${MAX_CALLS}`);

        await twilioClient.calls.create({
          url: TWIML_URL,
          to: ALERT_PHONE,
          from: TWILIO_FROM
        });

        console.log("☎️ CALL PLACED");

        setTimeout(triggerCallCycle, CALL_INTERVAL_MS);
      }

      if (alertState[device_id].callAttempts === 0) {
        console.log("🚀 CALL ENGINE STARTED");
        triggerCallCycle();
      }
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ EVENT INSERT FAILED:", err);
    res.status(500).json({ error: "Server failure" });
  }
});

/* ============================================================
   🚀 START SERVER
============================================================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`🚀 Trackblock backend running on port ${PORT}`)
);
