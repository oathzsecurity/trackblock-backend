"http://localhost:3000",
"http://127.0.0.1:3000",
"https://oathz-dashboard.vercel.app",
      "https://oathz-ui.vercel.app",
"https://oathz.com.au",
"https://www.oathz.com.au",
"https://oathzsecurity.com",
@@ -51,7 +52,7 @@ app.use(
);

// =============================
// EVENT + STATUS + ALERT ENGINE
// EVENT SYSTEM (in-memory storage)
// =============================
let deviceEvents = [];

@@ -76,7 +77,7 @@ app.get("/", (req, res) => {
});

// =============================
// LATEST STATUS OF ALL DEVICES
// GET LATEST STATUS OF ALL DEVICES
// =============================
app.get("/status", (req, res) => {
const latest = {};
@@ -197,7 +198,7 @@ app.post("/event", async (req, res) => {
});

// =============================
// FULL HISTORY FOR ONE DEVICE
// FULL EVENT HISTORY FOR ONE DEVICE
// =============================
app.get("/device/:id/events", (req, res) => {
const id = req.params.id;
@@ -206,7 +207,7 @@ app.get("/device/:id/events", (req, res) => {
});

// =============================
// RESET ALERT ENGINE
// RESET ALERT ENGINE FOR A DEVICE
// =============================
app.post("/device/:id/reset", (req, res) => {
const id = req.params.id;
@@ -225,7 +226,7 @@ app.post("/device/:id/reset", (req, res) => {
});

// =============================
// TWILIO CALLBACK — lock only real answers
// TWILIO CALLBACK
// =============================
app.post("/twilio/voice-status", (req, res) => {
try {
@@ -237,7 +238,6 @@ app.post("/twilio/voice-status", (req, res) => {

if (status === "completed" && duration >= 2) {
console.log("🛑 REAL HUMAN ANSWER DETECTED — CALL ENGINE LOCKED");

Object.keys(alertState).forEach((id) => {
alertState[id].callLock = true;
});
@@ -253,10 +253,9 @@ app.post("/twilio/voice-status", (req, res) => {
});

// =============================
// EMAIL STORAGE
// EMAIL STORAGE (subscribers)
// =============================
const emailsFile = path.join(process.cwd(), "emails.json");

if (!fs.existsSync(emailsFile)) fs.writeFileSync(emailsFile, "[]");

app.post("/notify", (req, res) => {
@@ -272,10 +271,7 @@ app.post("/notify", (req, res) => {
return res.json({ message: "Already subscribed" });
}

    list.push({
      email,
      date: new Date().toISOString(),
    });
    list.push({ email, date: new Date().toISOString() });

fs.writeFileSync(emailsFile, JSON.stringify(list, null, 2));

@@ -294,7 +290,8 @@ const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req, res, next) {
const key = req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  if (!key || key !== ADMIN_KEY)
    return res.status(403).json({ error: "Forbidden" });
next();
}

@@ -307,15 +304,47 @@ app.get("/export-subscribers", requireAdmin, (req, res) => {
const raw = fs.readFileSync(emailsFile, "utf8");
const list = JSON.parse(raw);

  const csv = ["email,date", ...list.map((i) => `${i.email},${i.date}`)].join("\n");
  const csv = ["email,date", ...list.map((i) => `${i.email},${i.date}`)].join(
    "\n"
  );

res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=subscribers.csv");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=subscribers.csv"
  );
res.send(csv);
});

// =============================
// NEW: DEVICES LIST FOR UI DASHBOARD
// =============================
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

// =============================
// START SERVER
// =============================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Trackblock backend running on ${port}`));
app.listen(port, () =>
  console.log(`🚀 Trackblock backend running on ${port}`)
);