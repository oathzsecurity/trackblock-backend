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
      "https://oathzsecurity.com"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ==============================================
// ⭐ In-memory device status (temporary until DB)
// ==============================================
let deviceEvents = [];

// ==============================================
// 📌 HEALTH CHECK
// ==============================================
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// ==============================================
// 📌 GET ALL DEVICE STATUS
// URL: https://api.oathzsecurity.com/status
// ==============================================
app.get("/status", async (req, res) => {
  try {
    res.json(deviceEvents);
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ==============================================
// 📌 DEVICE POSTS DATA → BACKEND
// URL: https://api.oathzsecurity.com/event
// ==============================================
app.post("/event", async (req, res) => {
  try {
    const payload = req.body;
    payload.last_seen = new Date().toISOString();

    const idx = deviceEvents.findIndex((d) => d.device_id === payload.device_id);

    if (idx === -1) {
      deviceEvents.push(payload);
    } else {
      deviceEvents[idx] = { ...deviceEvents[idx], ...payload };
    }

    console.log("📥 EVENT:", payload.device_id, payload.event_type);

    res.json({ ok: true });
  } catch (err) {
    console.error("EVENT ERROR:", err);
    res.status(500).json({ error: "Failed to save event" });
  }
});

// ==============================================
// 📌 RESET ALERT ENGINE
// URL: POST /device/:id/reset
// ==============================================
app.post("/device/:id/reset", async (req, res) => {
  const id = req.params.id;

  try {
    const d = deviceEvents.find((x) => x.device_id === id);
    if (!d) return res.status(404).json({ error: "Device not found" });

    d.smsSent = false;
    d.callAttempts = 0;
    d.callLock = false;

    console.log(`🔄 ALERTS RESET for ${id}`);

    res.json({ ok: true, device_id: id });
  } catch (err) {
    console.error("RESET ERROR:", err);
    res.status(500).json({ error: "Failed to reset alerts" });
  }
});

// ======================================================
// ⭐ EMAIL NOTIFY LIST — FILE STORAGE (emails.json)
// ======================================================
const emailsFile = path.join(process.cwd(), "emails.json");

// Ensure file exists
if (!fs.existsSync(emailsFile)) {
  fs.writeFileSync(emailsFile, "[]");
}

// ==============================================
// 📌 NOTIFY ROUTE
// URL: POST https://api.oathzsecurity.com/notify
// ==============================================
app.post("/notify", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const raw = fs.readFileSync(emailsFile, "utf8");
    const list = JSON.parse(raw);

    if (list.some((x) => x.email === email)) {
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
// ⭐ ADMIN-ONLY ROUTES (protected with ADMIN_KEY)
// ======================================================
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

function requireAdmin(req, res, next) {
  const key = req.query.key;
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ======================================================
// 📌 VIEW SUBSCRIBERS (JSON)
// https://api.oathzsecurity.com/subscribers?key=YOURKEY
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
// https://api.oathzsecurity.com/export-subscribers?key=YOURKEY
// ======================================================
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
    res.status(500).json({ error: "Failed to export subscribers" });
  }
});

// ==============================================
// 🚀 SERVER START
// ==============================================
const port = process.env.PORT || 8080;
app.listen(port, () =>
  console.log(`🚀 Trackblock backend running on ${port}`)
);
