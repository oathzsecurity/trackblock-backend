import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import twilio from "twilio";

const app = express();
app.use(bodyParser.json());

// ---------------------------------------------
//  POSTGRES
// ---------------------------------------------
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

// ---------------------------------------------
//  TWILIO
// ---------------------------------------------
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;        // Your Twilio number
const ALERT_PHONE = process.env.ALERT_PHONE;        // Your personal number

let twilioClient = null;

if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("📡 Twilio client initialised");
} else {
  console.log("⚠️  Twilio not configured — alerts disabled");
}

// ---------------------------------------------
//  HEALTH CHECK
// ---------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "online", time: new Date().toISOString() });
});

// ---------------------------------------------
//  EVENT INGESTION
// ---------------------------------------------
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

    if (!device_id || !event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("📥 Incoming event:", req.body);

    // Store in DB
    await pool.query(
      `INSERT INTO device_logs (device_id, event_type, latitude, longitude, state, movement_confirmed, gps_fix)
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

    // ------------------------------------------------
    //  MOVEMENT ALERT TRIGGER
    // ------------------------------------------------
    if (movement_confirmed === true && twilioClient) {
      console.log("🚨 MOVEMENT CONFIRMED — sending SMS");

      await twilioClient.messages.create({
        body: `🚨 Trackblock ALERT 🚨\n${device_id} moved!\nLat:${latitude}\nLon:${longitude}`,
        from: TWILIO_FROM,
        to: ALERT_PHONE
      });

      console.log("📨 Twilio alert sent");
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ EVENT INSERT FAILED:", err);
    res.status(500).json({ error: "Server failure" });
  }
});

// ---------------------------------------------
//  START SERVER
// ---------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`🚀 Trackblock backend running on port ${PORT}`)
);
