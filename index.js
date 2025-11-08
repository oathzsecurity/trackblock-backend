// trackblock-backend / index.js

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8888;

// Middleware
app.use(cors());
app.use(express.json()); // Parse JSON body

// Root route (for browser check)
app.get("/", (req, res) => {
  res.json({ ok: true, service: "trackblock-backend" });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Device event ingest (POST)
app.post("/device/event", (req, res) => {
  console.log("📡 Incoming device event:", req.body);

  // Always respond 200 so device knows it succeeded
  res.json({ ok: true, received: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Trackblock backend live on port ${PORT}`);
});
