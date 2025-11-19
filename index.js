import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import twilio from "twilio";

const app = express();

// Twilio sends x-www-form-urlencoded on callbacks
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===================================================
// ⭐ ENV + TWILIO SETUP
// ===================================================
const TWILIO_SID =
  process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "";
const TWILIO_TOKEN =
  process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "";
const ALERT_PHONE = process.env.ALERT_PHONE;          // destination
const TWILIO_FROM = process.env.TWILIO_FROM;          // your Twilio number
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;  // TwiML URL for calls

const MAX_CALL_ATTEMPTS = 10;

let twilioClient: any = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log("✅ Twilio client initialised");
} else {
  console.log("⚠️ Twilio credentials missing — call engine disabled");
}

// ===================================================
// ⭐ CORS — allow your dashboard + UI
// ===================================================
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://oathz-dashboard.vercel.app",
      "https://www.oathz.com.au",
      "https://oathz.com.au",
      "https://www.oathzsecurity.com",
      "https://oathzsecurity.com",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ===================================================
// ⭐ In-memory event + status + alert engine
// ===================================================

// Every event from every device (history)
let deviceEvents: any[] = [];

// Per-device alert state (engine)
interface AlertState {
  smsSent: boolean;
  callAttempts: number;
  callLock: boolean;
}

const alertState: Record<string, AlertState> = {};

// Helper to get / init state
function getAlertState(deviceId: string): AlertState {
  if (!alertState[deviceId]) {
    alertState[deviceId] = {
      smsSent: false,
      callAttempts: 0,
      callLock: false,
    };
  }
  return alertState[deviceId];
}

// ===================================================
// 📌 HEALTH CHECK
// ===================================================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// ===================================================
// 📌 GET *LATEST STATUS* OF ALL DEVICES
// URL: https://api.oathzsecurity.com/status
// ===================================================
app.get("/status", (req, res) => {
  const latest: Record<string, any> = {};

  for (const evt of deviceEvents) {
    latest[evt.device_id] = { ...latest[evt.device_id], ...evt };
  }

  const merged = Object.values(latest).map((dev: any) => {
    const state = getAlertState(dev.device_id);
    return {
      ...dev,
      smsSent: state.smsSent,
      callAttempts: state.callAttempts,
      callLock: state.callLock,
    };
  });

  res.json(merged);
});

// ===================================================
// ⭐ CORE ALERT / CALL ENGINE
//   - DEMO mode compatible
//   - Always up to 2 calls, then lock
//   - Max attempts safety cap
// ===================================================
async function runAlertEngine(payload: any) {
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

  // Nice structured log like your old one
  console.log("📡 Incoming event:", {
    device_id,
    event_type,
    state,
    gps_fix,
    movement_confirmed,
    latitude,
    longitude,
  });

  // Only trigger engine when movement is confirmed OR we're in demo chase mode
  const isMovementEvent =
    movement_confirmed === true ||
    event_type === "movement" ||
    state === "demo_chase";

  if (!isMovementEvent) {
    return;
  }

  console.log(`🚨 MOVEMENT EVENT for ${device_id}`);

  // 2️⃣ CALL ENGINE — ALWAYS 2 CALLS
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
      statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL, // optional
      statusCallbackEvent: ["completed"],
      machineDetection: "Enable",
    });

    console.log("☎ CALL CREATED OK");
  } catch (err) {
    console.error("❌ CALL ERROR:", err);
  }
}

// ===================================================
// 📌 DEVICE POSTS EVENT DATA → BACKEND
// URL: https://api.oathzsecurity.com/event
// ===================================================
app.post("/event", async (req, res) => {
  try {
    const payload = req.body;

    payload.last_seen = new Date().toISOString();

    // Store full history
    deviceEvents.push(payload);

    console.log("📥 EVENT:", payload.device_id, payload.event_type);

    // Run alert engine (movement / demo mode / calls, etc.)
    await runAlertEngine(payload);

    res.json({ ok: true });
  } catch (err) {
    console.error("EVENT ERROR:", err);
    res.status(500).json({ error: "Failed to process event" });
  }
});

// ===================================================
// 📌 GET FULL EVENT HISTORY FOR ONE DEVICE
// URL: https://api.oathzsecurity.com/device/:id/events
// ===================================================
app.get("/device/:id/events", (req, res) => {
  const id = req.params.id;
  const history = deviceEvents.filter((e) => e.device_id === id);
  res.json(history);
});

// ===================================================
// 📌 RESET ALERT ENGINE
// URL: POST /device/:id/reset
// ===================================================
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

// ============================================================
// ☎️ TWILIO CALLBACK — LOCK ONLY REAL HUMAN ANSWERS
// URL: POST /twilio/voice-status
// ============================================================
app.post("/twilio/voice-status", (req, res) => {
  try {
    const status = req.body.CallStatus;
    const sid = req.body.CallSid;
    const duration = parseInt(req.body.CallDuration || "0", 10);

    console.log("📞 CALL CALLBACK:", { status, duration, sid });

    // Lock ONLY when:
    //   STATUS === completed
    //   DURATION ≥ 2 seconds
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

// ======================================================
// ⭐ EMAIL NOTIFY LIST — FILE STORAGE (emails.json)
// ======================================================
const emailsFile = path.join(process.cwd(), "emails.json");

// Create file if missing
if (!fs.existsSync(emailsFile)) {
  fs.writeFileSync(emailsFile, "[]");
}

// ======================================================
// 📌 NOTIFY ROUTE — Add subscriber
// URL: POST https://api.oathzsecurity.com/notify
// ======================================================
app.post("/notify", (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    if (list.some((x: any) => x.email === email)) {
      return res.status(200).json({ message: "Already subscribed" });
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

// ======================================================
// ⭐ ADMIN ROUTES — protected with ADMIN_KEY
// ======================================================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req: any, res: any, next: any) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ======================================================
// 📌 VIEW SUBSCRIBERS (JSON)
// ======================================================
app.get("/subscribers", requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);
    res.json(list);
  } catch (err) {
    console.error("SUBSCRIBERS ERROR:", err);
    res.status(500).json({ error: "Failed to read subscribers" });
  }
});

// ======================================================
// 📌 EXPORT SUBSCRIBERS CSV
// ======================================================
app.get("/export-subscribers", requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    const csv = ["email,date", ...list.map((i: any) => `${i.email},${i.date}`)].join(
      "\n"
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=subscribers.csv"
    );

    res.send(csv);
  } catch (err) {
    console.error("CSV EXPORT ERROR:", err);
    res.status(500).json({ error: "Failed to export subscribers" });
  }
});

// ======================================================
// 🚀 SERVER START
// ======================================================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Trackblock backend running on ${port}`));
