import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import twilio from "twilio";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// =============================
// ENV + TWILIO SETUP
// =============================
const TWILIO_SID =
  process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "";
const TWILIO_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "";
const ALERT_PHONE = process.env.ALERT_PHONE;
const TWILIO_FROM = process.env.TWILIO_FROM;
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;

const MAX_CALL_ATTEMPTS = 10;

let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("✅ Twilio client initialised");
} else {
  console.log("⚠️ Twilio credentials missing — call engine disabled");
}

// =============================
// CORS
// =============================
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://oathz-dashboard.vercel.app",
      "https://oathz.com.au",
      "https://www.oathz.com.au",
      "https://oathzsecurity.com",
      "https://www.oathzsecurity.com",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// =============================
// EVENT + STATUS + ALERT ENGINE
// =============================
let deviceEvents = [];

const alertState = {};

function getAlertState(deviceId) {
  if (!alertState[deviceId]) {
    alertState[deviceId] = {
      smsSent: false,
      callAttempts: 0,
      callLock: false,
    };
  }
  return alertState[deviceId];
}

// =============================
// HEALTH CHECK
// =============================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// =============================
// LATEST STATUS OF ALL DEVICES
// =============================
app.get("/status", (req, res) => {
  const latest = {};

  for (const evt of deviceEvents) {
    latest[evt.device_id] = { ...latest[evt.device_id], ...evt };
  }

  const merged = Object.values(latest).map((dev) => {
    const st = getAlertState(dev.device_id);
    return {
      ...dev,
      smsSent: st.smsSent,
      callAttempts: st.callAttempts,
      callLock: st.callLock,
    };
  });

  res.json(merged);
});

// =============================
// ALERT ENGINE
// =============================
async function runAlertEngine(payload) {
  const {
    device_id,
    event_type,
    state,
    gps_fix,
    movement_confirmed,
    latitude,
    longitude,
  } = payload;

  const st = getAlertState(device_id);

  console.log("📡 Incoming event:", {
    device_id,
    event_type,
    state,
    gps_fix,
    movement_confirmed,
    latitude,
    longitude,
  });

  const isMovementEvent =
    movement_confirmed === true ||
    event_type === "movement" ||
    state === "demo_chase";

  if (!isMovementEvent) return;

  console.log(`🚨 MOVEMENT EVENT for ${device_id}`);

  if (!twilioClient || !TWIML_VOICE_URL || !ALERT_PHONE || !TWILIO_FROM) {
    console.log("⚠️ Call engine prerequisites missing — skip calls");
    return;
  }

  if (st.callLock) {
    console.log("🔒 CALL ENGINE LOCKED — NO MORE CALLS");
    return;
  }

  if (st.callAttempts >= MAX_CALL_ATTEMPTS) {
    console.log("⛔ MAX CALL ATTEMPTS REACHED");
    st.callLock = true;
    return;
  }

  if (st.callAttempts >= 2) {
    console.log("🛑 TWO CALLS MADE — LOCKING ENGINE");
    st.callLock = true;
    return;
  }

  st.callAttempts++;
  console.log(`☎ CALL ATTEMPT #${st.callAttempts}`);

  try {
    await twilioClient.calls.create({
      to: ALERT_PHONE,
      from: TWILIO_FROM,
      url: TWIML_VOICE_URL,
      statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
      statusCallbackEvent: ["completed"],
      machineDetection: "Enable",
    });

    console.log("☎ CALL CREATED OK");
  } catch (err) {
    console.error("❌ CALL ERROR:", err);
  }
}

// =============================
// DEVICE POSTS EVENT
// =============================
app.post("/event", async (req, res) => {
  try {
    const payload = req.body;

    payload.last_seen = new Date().toISOString();

    deviceEvents.push(payload);

    console.log("📥 EVENT:", payload.device_id, payload.event_type);

    await runAlertEngine(payload);

    res.json({ ok: true });
  } catch (err) {
    console.error("EVENT ERROR:", err);
    res.status(500).json({ error: "Failed to process event" });
  }
});

// =============================
// FULL HISTORY FOR ONE DEVICE
// =============================
app.get("/device/:id/events", (req, res) => {
  const id = req.params.id;
  const history = deviceEvents.filter((e) => e.device_id === id);
  res.json(history);
});

// =============================
// RESET ALERT ENGINE
// =============================
app.post("/device/:id/reset", (req, res) => {
  const id = req.params.id;

  const latest = [...deviceEvents].reverse().find((e) => e.device_id === id);
  if (!latest) return res.status(404).json({ error: "Device not found" });

  const st = getAlertState(id);
  st.smsSent = false;
  st.callAttempts = 0;
  st.callLock = false;

  console.log(`🔄 ALERTS RESET for ${id}`);

  res.json({ ok: true, device_id: id });
});

// =============================
// TWILIO CALLBACK — lock only real answers
// =============================
app.post("/twilio/voice-status", (req, res) => {
  try {
    const status = req.body.CallStatus;
    const duration = parseInt(req.body.CallDuration || "0", 10);
    const sid = req.body.CallSid;

    console.log("📞 CALL CALLBACK:", { status, duration, sid });

    if (status === "completed" && duration >= 2) {
      console.log("🛑 REAL HUMAN ANSWER DETECTED — CALL ENGINE LOCKED");

      Object.keys(alertState).forEach((id) => {
        alertState[id].callLock = true;
      });
    } else {
      console.log("⚠️ Ignoring callback — not a real answer");
    }

    res.type("text/plain").send("ok");
  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
    res.type("text/plain").send("error");
  }
});

// =============================
// EMAIL STORAGE
// =============================
const emailsFile = path.join(process.cwd(), "emails.json");

if (!fs.existsSync(emailsFile)) fs.writeFileSync(emailsFile, "[]");

app.post("/notify", (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Invalid email" });

    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    if (list.some((x) => x.email === email)) {
      return res.json({ message: "Already subscribed" });
    }

    list.push({
      email,
      date: new Date().toISOString(),
    });

    fs.writeFileSync(emailsFile, JSON.stringify(list, null, 2));

    console.log("📨 NEW SUBSCRIBER:", email);
    res.json({ message: "Subscribed successfully" });
  } catch (err) {
    console.error("Notify Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================
// ADMIN ROUTES
// =============================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req, res, next) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

app.get("/subscribers", requireAdmin, (req, res) => {
  const raw = fs.readFileSync(emailsFile, "utf8");
  res.json(JSON.parse(raw));
});

app.get("/export-subscribers", requireAdmin, (req, res) => {
  const raw = fs.readFileSync(emailsFile, "utf8");
  const list = JSON.parse(raw);

  const csv = ["email,date", ...list.map((i) => `${i.email},${i.date}`)].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=subscribers.csv");
  res.send(csv);
});

// =============================
// START SERVER
// =============================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Trackblock backend running on ${port}`));
