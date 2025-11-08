import express from "express";
import cors from "cors";
import pg from "pg";

const app = express();
app.use(cors());
app.use(express.json());

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function testDB() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("✅ Connected to Postgres at:", result.rows[0].now);
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
  }
}

testDB();

// DEVICE EVENT ENDPOINT
app.post("/device/event", async (req, res) => {
  console.log("📩 Incoming event:", req.body);

  const { device, event, lat, lon } = req.body;

  try {
    await pool.query(
      `INSERT INTO device_events (device, event, lat, lon)
       VALUES ($1, $2, $3, $4)`,
      [device, event, lat, lon]
    );

    res.json({ ok: true, stored: true });
  } catch (err) {
    console.error("❌ DB insert failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ROOT TEST
app.get("/", (req, res) => {
  res.send("Trackblock backend is alive");
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ API live on port ${port}`));
