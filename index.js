
const app = express();

// Twilio sends x-www-form-urlencoded on callbacks
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===================================================
// ⭐ ENV + TWILIO SETUP
// ===================================================
// =============================
// ENV + TWILIO SETUP
// =============================
const TWILIO_SID =
process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_SID || "";
const TWILIO_TOKEN =
process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN || "";
const ALERT_PHONE = process.env.ALERT_PHONE;          // destination
const TWILIO_FROM = process.env.TWILIO_FROM;          // your Twilio number
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;  // TwiML URL for calls
const ALERT_PHONE = process.env.ALERT_PHONE;
const TWILIO_FROM = process.env.TWILIO_FROM;
const TWIML_VOICE_URL = process.env.TWIML_VOICE_URL;

const MAX_CALL_ATTEMPTS = 10;

let twilioClient: any = null;
let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
console.log("✅ Twilio client initialised");
} else {
console.log("⚠️ Twilio credentials missing — call engine disabled");
}

// ===================================================
// ⭐ CORS — allow your dashboard + UI
// ===================================================
// =============================
// CORS
// =============================
app.use(
cors({
origin: [
"http://localhost:3000",
"http://127.0.0.1:3000",
"https://oathz-dashboard.vercel.app",
      "https://www.oathz.com.au",
"https://oathz.com.au",
      "https://www.oathzsecurity.com",
      "https://www.oathz.com.au",
"https://oathzsecurity.com",
      "https://www.oathzsecurity.com",
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
// =============================
// EVENT + STATUS + ALERT ENGINE
// =============================
let deviceEvents = [];

const alertState: Record<string, AlertState> = {};
const alertState = {};

// Helper to get / init state
function getAlertState(deviceId: string): AlertState {
function getAlertState(deviceId) {
if (!alertState[deviceId]) {
alertState[deviceId] = {
smsSent: false,
@@ -79,44 +68,40 @@ function getAlertState(deviceId: string): AlertState {
return alertState[deviceId];
}

// ===================================================
// 📌 HEALTH CHECK
// ===================================================
// =============================
// HEALTH CHECK
// =============================
app.get("/", (req, res) => {
res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// ===================================================
// 📌 GET *LATEST STATUS* OF ALL DEVICES
// URL: https://api.oathzsecurity.com/status
// ===================================================
// =============================
// LATEST STATUS OF ALL DEVICES
// =============================
app.get("/status", (req, res) => {
  const latest: Record<string, any> = {};
  const latest = {};

for (const evt of deviceEvents) {
latest[evt.device_id] = { ...latest[evt.device_id], ...evt };
}

  const merged = Object.values(latest).map((dev: any) => {
    const state = getAlertState(dev.device_id);
  const merged = Object.values(latest).map((dev) => {
    const st = getAlertState(dev.device_id);
return {
...dev,
      smsSent: state.smsSent,
      callAttempts: state.callAttempts,
      callLock: state.callLock,
      smsSent: st.smsSent,
      callAttempts: st.callAttempts,
      callLock: st.callLock,
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
// =============================
// ALERT ENGINE
// =============================
async function runAlertEngine(payload) {
const {
device_id,
event_type,
@@ -129,7 +114,6 @@ async function runAlertEngine(payload: any) {

const st = getAlertState(device_id);

  // Nice structured log like your old one
console.log("📡 Incoming event:", {
device_id,
event_type,
@@ -140,19 +124,15 @@ async function runAlertEngine(payload: any) {
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
  if (!isMovementEvent) return;

console.log(`🚨 MOVEMENT EVENT for ${device_id}`);

  // 2️⃣ CALL ENGINE — ALWAYS 2 CALLS
if (!twilioClient || !TWIML_VOICE_URL || !ALERT_PHONE || !TWILIO_FROM) {
console.log("⚠️ Call engine prerequisites missing — skip calls");
return;
@@ -183,7 +163,7 @@ async function runAlertEngine(payload: any) {
to: ALERT_PHONE,
from: TWILIO_FROM,
url: TWIML_VOICE_URL,
      statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL, // optional
      statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
statusCallbackEvent: ["completed"],
machineDetection: "Enable",
});
@@ -194,22 +174,19 @@ async function runAlertEngine(payload: any) {
}
}

// ===================================================
// 📌 DEVICE POSTS EVENT DATA → BACKEND
// URL: https://api.oathzsecurity.com/event
// ===================================================
// =============================
// DEVICE POSTS EVENT
// =============================
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
@@ -219,20 +196,18 @@ app.post("/event", async (req, res) => {
}
});

// ===================================================
// 📌 GET FULL EVENT HISTORY FOR ONE DEVICE
// URL: https://api.oathzsecurity.com/device/:id/events
// ===================================================
// =============================
// FULL HISTORY FOR ONE DEVICE
// =============================
app.get("/device/:id/events", (req, res) => {
const id = req.params.id;
const history = deviceEvents.filter((e) => e.device_id === id);
res.json(history);
});

// ===================================================
// 📌 RESET ALERT ENGINE
// URL: POST /device/:id/reset
// ===================================================
// =============================
// RESET ALERT ENGINE
// =============================
app.post("/device/:id/reset", (req, res) => {
const id = req.params.id;

@@ -249,23 +224,20 @@ app.post("/device/:id/reset", (req, res) => {
res.json({ ok: true, device_id: id });
});

// ============================================================
// ☎️ TWILIO CALLBACK — LOCK ONLY REAL HUMAN ANSWERS
// URL: POST /twilio/voice-status
// ============================================================
// =============================
// TWILIO CALLBACK — lock only real answers
// =============================
app.post("/twilio/voice-status", (req, res) => {
try {
const status = req.body.CallStatus;
    const sid = req.body.CallSid;
const duration = parseInt(req.body.CallDuration || "0", 10);
    const sid = req.body.CallSid;

console.log("📞 CALL CALLBACK:", { status, duration, sid });

    // Lock ONLY when:
    //   STATUS === completed
    //   DURATION ≥ 2 seconds
if (status === "completed" && duration >= 2) {
console.log("🛑 REAL HUMAN ANSWER DETECTED — CALL ENGINE LOCKED");

Object.keys(alertState).forEach((id) => {
alertState[id].callLock = true;
});
@@ -280,33 +252,24 @@ app.post("/twilio/voice-status", (req, res) => {
}
});

// ======================================================
// ⭐ EMAIL NOTIFY LIST — FILE STORAGE (emails.json)
// ======================================================
// =============================
// EMAIL STORAGE
// =============================
const emailsFile = path.join(process.cwd(), "emails.json");

// Create file if missing
if (!fs.existsSync(emailsFile)) {
  fs.writeFileSync(emailsFile, "[]");
}
if (!fs.existsSync(emailsFile)) fs.writeFileSync(emailsFile, "[]");

// ======================================================
// 📌 NOTIFY ROUTE — Add subscriber
// URL: POST https://api.oathzsecurity.com/notify
// ======================================================
app.post("/notify", (req, res) => {
try {
const { email } = req.body;

    if (!email || !email.includes("@")) {
    if (!email || !email.includes("@"))
return res.status(400).json({ error: "Invalid email" });
    }

const raw = fs.readFileSync(emailsFile, "utf8");
const list = JSON.parse(raw);

    if (list.some((x: any) => x.email === email)) {
      return res.status(200).json({ message: "Already subscribed" });
    if (list.some((x) => x.email === email)) {
      return res.json({ message: "Already subscribed" });
}

list.push({
@@ -317,68 +280,42 @@ app.post("/notify", (req, res) => {
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
// =============================
// ADMIN ROUTES
// =============================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req: any, res: any, next: any) {
function requireAdmin(req, res, next) {
const key = req.query.key;
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
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
  const raw = fs.readFileSync(emailsFile, "utf8");
  res.json(JSON.parse(raw));
});

// ======================================================
// 📌 EXPORT SUBSCRIBERS CSV
// ======================================================
app.get("/export-subscribers", requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);
  const raw = fs.readFileSync(emailsFile, "utf8");
  const list = JSON.parse(raw);

    const csv = ["email,date", ...list.map((i: any) => `${i.email},${i.date}`)].join(
      "\n"
    );
  const csv = ["email,date", ...list.map((i) => `${i.email},${i.date}`)].join("\n");

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
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=subscribers.csv");
  res.send(csv);
});

// ======================================================
// 🚀 SERVER START
// ======================================================
// =============================
// START SERVER
// =============================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Trackblock backend running on ${port}`));