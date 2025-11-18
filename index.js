import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(express.json());

// ⭐ CORS — allow your dashboard + future UI
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://oathz-dashboard.vercel.app",
      "https://www.oathzsecurity.com",
      "https://oathzsecurity.com",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ⭐ Your PostgreSQL / event storage (replace with real DB soon)
let deviceEvents = [];

// ---------------------------------------------
//  HEALTH CHECK
// ---------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "Trackblock backend is LIVE ⚡" });
});

// ---------------------------------------------
//  GET ALL DEVICE STATUS (used by dashboard)
//  URL: https://api.oathzsecurity.com/status
// ---------------------------------------------
app.get("/status", async (req, res) => {
  try {
    res.json(deviceEvents);
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch status" });
  }
});

// ---------------------------------------------
//  DEVICE POSTS DATA → BACKEND
//  URL: https://api.oathzsecurity.com/event
// ---------------------------------------------
app.post("/event", async (req, res) => {
  try {
    const payload = req.body;
    payload.last_seen = new Date().toISOString();

    // Upsert logic:
    const existingIndex = deviceEvents.findIndex(
      (d) => d.device_id === payload.device_id
    );

    if (existingIndex === -1) {
      deviceEvents.push(payload);
    } else {
      deviceEvents[existingIndex] = { ...deviceEvents[existingIndex], ...payload };
    }

    console.log("📥 EVENT RECEIVED:", payload.device_id, payload.event_type);

    res.json({ ok: true });
  } catch (err) {
    console.error("EVENT ERROR:", err);
    res.status(500).json({ error: "Failed to save event" });
  }
});

// ---------------------------------------------
//  RESET ALERT ENGINE
//  URL: POST https://api.oathzsecurity.com/device/:id/reset
// ---------------------------------------------
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

// ---------------------------------------------
//  SERVER START
// ---------------------------------------------
const port = process.env.PORT || 8080;
app.listen(port, () =>
  console.log(`🚀 Trackblock backend running on ${port}`)
);
