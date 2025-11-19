import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// ==============================================
// ⭐ CORS — allow your dashboard + future UI
// ==============================================
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

// ==============================================
// ⭐ In-memory device status + history
// ==============================================

// This stores **all events** ever received
let deviceEvents = [];

// ==============================================
// 📌 ROOT HEALTH CHECK
// ==============================================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// ==============================================
// 📌 DEVICE POSTS DATA → BACKEND
// URL: POST https://api.oathzsecurity.com/event
// ==============================================
app.post("/event", async (req, res) => {
  try {
    const payload = req.body;

    // Add timestamp automatically
    payload.last_seen = new Date().toISOString();

    // ⭐ Store EVERY event (history!)
    deviceEvents.push(payload);

    console.log("📥 EVENT:", payload.device_id, payload.event_type);

    res.json({ ok: true });
  } catch (err) {
    console.error("EVENT ERROR:", err);
    res.status(500).json({ error: "Failed to save event" });
  }
});

// ==============================================
// 📌 GET ALL CURRENT STATUS (most recent per device)
// URL: GET https://api.oathzsecurity.com/status
// ==============================================
app.get("/status", (req, res) => {
  try {
    // Build latest-device-status list
    const latest = {};

    deviceEvents.forEach((e) => {
      latest[e.device_id] = e;
    });

    res.json(Object.values(latest));
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ==============================================
// 📌 GET FULL EVENT HISTORY (ALL DEVICES)
// URL: GET https://api.oathzsecurity.com/events
// ==============================================
app.get("/events", (req, res) => {
  try {
    res.json(deviceEvents);
  } catch (err) {
    console.error("EVENTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ==============================================
// 📌 GET EVENT HISTORY FOR A SINGLE DEVICE
// URL: GET https://api.oathzsecurity.com/device/TB-DEMO-001/events
// ==============================================
app.get("/device/:id/events", (req, res) => {
  try {
    const id = req.params.id;
    const filtered = deviceEvents.filter((e) => e.device_id === id);
    res.json(filtered);
  } catch (err) {
    console.error("DEVICE EVENTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch device events" });
  }
});

// ==============================================
// 📌 RESET ALERT ENGINE
// URL: POST /device/:id/reset
// ==============================================
app.post("/device/:id/reset", (req, res) => {
  const id = req.params.id;

  try {
    // Find latest event of this device
    const latest = [...deviceEvents].reverse().find((x) => x.device_id === id);

    if (!latest) return res.status(404).json({ error: "Device not found" });

    latest.smsSent = false;
    latest.callAttempts = 0;
    latest.callLock = false;

    console.log(`🔄 ALERTS RESET for ${id}`);

    res.json({ ok: true, device_id: id });
  } catch (err) {
    console.error("RESET ERROR:", err);
    res.status(500).json({ error: "Failed to reset alerts" });
  }
});

// ======================================================
// ⭐ EMAIL NOTIFY LIST — FILE STORAGE
// ======================================================
const emailsFile = path.join(process.cwd(), "emails.json");

// Ensure file exists
if (!fs.existsSync(emailsFile)) {
  fs.writeFileSync(emailsFile, "[]");
}

// ==============================================
// 📌 NOTIFY SIGNUP
// URL: POST https://api.oathzsecurity.com/notify
// ==============================================
app.post("/notify", (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    if (list.some((x) => x.email === email)) {
      return res.json({ message: "Already subscribed" });
    }

    list.push({ email, date: new Date().toISOString() });

    fs.writeFileSync(emailsFile, JSON.stringify(list, null, 2));

    console.log("📨 NEW SUBSCRIBER:", email);

    res.json({ message: "Subscribed successfully" });
  } catch (err) {
    console.error("Notify Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ======================================================
// ⭐ ADMIN ROUTES
// ======================================================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req, res, next) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

app.get("/subscribers", requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(emailsFile, "utf8");
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("SUBSCRIBERS ERROR:", err);
    res.status(500).json({ error: "Failed to read subscribers" });
  }
});

app.get("/export-subscribers", requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    const csv = [
      "email,date",
      ...list.map((i) => `${i.email},${i.date}`),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=subscribers.csv"
    );

    res.send(csv);
  } catch (err) {
    console.error("CSV EXPORT ERROR:", err);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

// ==============================================
// 🚀 START SERVER
// ==============================================
const port = process.env.PORT || 8080;
app.listen(port, () =>
  console.log(`🚀 Trackblock backend running on ${port}`)
);
