import express from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";

const app = express();
app.use(bodyParser.json());

// --- Postgres connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB connection on startup
(async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ Connected to Postgres");
  } catch (err) {
    console.error("❌ DB connection failed:", err);
  }
})();

// --- Routes ---

// Health check
app.get("/", (req, res) => {
  res.json({ status: "online", time: new Date().toISOString() });
});

// Device telemetry endpoint
app.post("/event", async (req, res) => {
  try {
    const { device_id, event_type, latitude, longitude } = req.body;

    // Basic validation
    if (!device_id || !event_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Insert into DB
    await pool.query(
      `INSERT INTO device_events (device_id, event_type, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [device_id, event_type, latitude, longitude]
    );

    console.log(`✅ EVENT LOGGED:`, req.body);
    res.json({ ok: true });

  } catch (err) {
    console.error("❌ INSERT FAILED:", err);
    res.status(500).json({ error: "DB insert failed" });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Trackblock backend running on port ${PORT}`);
});
