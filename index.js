import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import twilio from "twilio";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===================================================
// CORS — HYBRID BACKEND SUPPORT
// ===================================================
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://oathz-dashboard.vercel.app",
      "https://oathz-ui.vercel.app",
      "https://oathz.com.au",
      "https://www.oathz.com.au",
      "https://oathzsecurity.com",
      "https://api.oathzsecurity.com", // 🔥 NEW
    ],
    methods: ["GET", "POST"],
  })
);

// ===================================================
// ENV + TWILIO SETUP
// ===================================================
const TWILIO_SID =
  process.env.TWILIO_ACCOUNT_SID ||
  process.env.TWILIO_SID ||
  "";
const TWILIO_TOKEN =
  process.env.TWILIO_AUTH_TOKEN ||
  process.env.TWILIO_TOKEN ||
  "";
const ALERT_PHONE = process.env.ALERT_PHONE; // destination
const TWILIO_FROM = process.env.TWILIO_FROM; // your Twilio number
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;

// ===================================================
// EVENT SYSTEM (IN-MEMORY)
// ===================================================
let deviceEvents = [];

let alertState = {}; // { [device_id]: { callLock: boolean, lastAlert: timestamp } }

// ===================================================
app.get("/", (req, res) => {
  res.json({ message: "Trackblock backend running", uptime: process.uptime() });
});

// ===================================================
// GET LATEST STATUS OF ALL DEVICES
// ===================================================
app.get("/status", (req, res) => {
  const latest = {};

  for (const evt of deviceEvents) {
    latest[evt.device_id] = evt;
  }

  res.json(Object.values(latest));
});

// ===================================================
// RECEIVE DEVICE EVENT
// ===================================================
app.post("/event", async (req, res) => {
  try {
    const {
      device_id,
      event_type,
      latitude,
      longitude,
      gps_fix,
      macs,
    } = req.body;

    if (!device_id) return res.status(400).json({ error: "Missing device_id" });

    const now = Date.now();

    if (!alertState[device_id]) {
      alertState[device_id] = { callLock: false, lastAlert: 0 };
    }

    const state = alertState[device_id];

    // Store event
    const evt = {
      device_id,
      event_type,
      latitude,
      longitude,
      gps_fix,
      macs: macs || [],
      last_seen: now,
    };

    deviceEvents.push(evt);

    // =============================
    // ALERT ENGINE (CALL + SMS)
    // =============================
    const timeSinceLast = now - state.lastAlert;

    let shouldCall = false;
    let shouldSMS = false;

    // RULE: Only trigger if not locked by callback
    if (!state.callLock) {
      // 1. Device moved
      if (event_type === "movement") {
        shouldCall = true;
        shouldSMS = true;
      }

      // 2. Device started (ignition)
      if (event_type === "accel") {
        shouldCall = true;
        shouldSMS = true;
      }

      // 3. Device stolen alert type
      if (event_type === "alert") {
        shouldCall = true;
        shouldSMS = true;
      }
    }

    // throttle SMS: 20 sec
    if (timeSinceLast < 20000) {
      shouldSMS = false;
    }

    if (shouldCall) {
      console.log("📞 SENDING TWILIO CALL…");

      try {
        await twilio(TWILIO_SID, TWILIO_TOKEN).calls.create({
          to: ALERT_PHONE,
          from: TWILIO_FROM,
          url: TWIML_VOICE_URL,
          machineDetection: "Enable",
        });
      } catch (err) {
        console.error("❌ Twilio call error:", err);
      }
    }

    if (shouldSMS) {
      console.log("📩 SENDING TWILIO SMS…");

      try {
        await twilio(TWILIO_SID, TWILIO_TOKEN).messages.create({
          to: ALERT_PHONE,
          from: TWILIO_FROM,
          body: `Trackblock Alert: ${event_type} at ${latitude},${longitude}`,
        });
      } catch (err) {
        console.error("❌ Twilio SMS error:", err);
      }
    }

    if (shouldCall || shouldSMS) {
      state.lastAlert = now;
    }

    return res.json({ status: "ok", shouldCall, shouldSMS });
  } catch (err) {
    console.error("❌ /event error:", err);
    res.status(500).json({ error: "Backend error" });
  }
});

// ===================================================
// FULL EVENT HISTORY FOR ONE DEVICE
// ===================================================
app.get("/device/:id/events", (req, res) => {
  const id = req.params.id;
  res.json(deviceEvents.filter((e) => e.device_id === id));
});

// ===================================================
// RESET ALERT ENGINE
// ===================================================
app.post("/device/:id/reset", (req, res) => {
  const id = req.params.id;

  alertState[id] = { callLock: false, lastAlert: 0 };

  res.json({ message: `Alert engine reset for device ${id}` });
});

// ===================================================
// TWILIO CALLBACK — LOCK IF HUMAN ANSWERS
// ===================================================
app.post("/twilio/voice-status", (req, res) => {
  try {
    const status = req.body.CallStatus;
    const duration = parseInt(req.body.CallDuration || "0", 10);

    console.log("📞 Twilio callback:", status, "duration:", duration);

    // Real human answer → lock call engine
    if (status === "completed" && duration >= 2) {
      console.log("🛑 HUMAN ANSWER DETECTED — LOCKING CALL ENGINE");

      for (const id of Object.keys(alertState)) {
        alertState[id].callLock = true;
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Twilio callback error:", err);
    res.sendStatus(500);
  }
});

// ===================================================
// EMAIL SUBSCRIBERS (Notify)
// ===================================================
const emailsFile = path.join(process.cwd(), "emails.json");
if (!fs.existsSync(emailsFile)) fs.writeFileSync(emailsFile, "[]");

app.post("/notify", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });

  const raw = fs.readFileSync(emailsFile, "utf8");
  const list = JSON.parse(raw);

  if (list.some((i) => i.email === email)) {
    return res.json({ message: "Already subscribed" });
  }

  list.push({ email, date: new Date().toISOString() });

  fs.writeFileSync(emailsFile, JSON.stringify(list, null, 2));

  res.json({ message: "OK" });
});

// ===================================================
// ADMIN EXPORT
// ===================================================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req, res, next) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

app.get("/export-subscribers", requireAdmin, (req, res) => {
  const raw = fs.readFileSync(emailsFile, "utf8");
  const list = JSON.parse(raw);

  const csv =
    ["email,date", ...list.map((i) => `${i.email},${i.date}`)].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=subscribers.csv");

  res.send(csv);
});

// ===================================================
// DEVICES LIST FOR DASHBOARD
// ===================================================
app.get("/devices", (req, res) => {
  try {
    const latest = {};

    for (const evt of deviceEvents) {
      latest[evt.device_id] = {
        device_id: evt.device_id,
        last_seen: evt.last_seen,
        state: evt.state || evt.event_type || "unknown",
        gps_fix: evt.gps_fix,
        latitude: evt.latitude,
        longitude: evt.longitude,
      };
    }

    res.json(Object.values(latest));
  } catch (err) {
    console.error("❌ /devices error:", err);
    res.status(500).json({ error: "Failed to load devices" });
  }
});

// ===================================================
// START SERVER (ONE LISTEN ONLY)
// ===================================================
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Trackblock backend running on port ${port}`);
});
