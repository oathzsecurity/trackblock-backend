import express from "express";

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "trackblock-backend" });
});

// Device event endpoint (proxy will forward here)
app.post("/device/event", (req, res) => {
  const event = req.body;
  console.log("[EVENT]", JSON.stringify(event, null, 2));
  res.json({ ok: true });
});

// Railway injects PORT automatically
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
