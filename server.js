import express from "express";
import { BUILDINGS, getRooms, loadRooms } from "./lib/catalog.js";
import { schedules, search } from "./lib/availability.js";
import { setToken, tokenStatus, refreshCatalog, loadCatalog, NotConnectedError, BOOKIT_ROOM_URL } from "./lib/bookit.js";

const app = express();
app.use(express.json());
app.use(express.static(new URL("./public", import.meta.url).pathname));

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof NotConnectedError) return res.status(503).json({ error: "not_connected", message: err.message });
    console.error(err);
    res.status(502).json({ error: "upstream", message: err.message });
  }
};

// The Chrome extension posts the Book It session token here.
app.post("/api/bookit-token", wrap(async (req, res) => {
  const info = setToken(req.body?.token);
  if (!loadCatalog() || Date.now() - Date.parse(loadCatalog().fetchedAt) > 7 * 864e5) {
    refreshCatalog().then(loadRooms).then(() => console.log("Catalog refreshed:", getRooms().length, "St Lucia rooms"))
      .catch((e) => console.error("Catalog refresh failed:", e.message));
  }
  res.json({ ok: true, ...info });
}));

app.get("/api/status", (_req, res) => res.json({ ...tokenStatus(), catalog: loadCatalog()?.fetchedAt || null, rooms: getRooms().length }));

app.get("/api/catalog", (_req, res) => res.json({
  buildings: BUILDINGS,
  rooms: getRooms().map((r) => ({ ...r, bookitUrl: BOOKIT_ROOM_URL(r.id) })),
}));

app.get("/api/buildings/:code/schedule", wrap(async (req, res) => {
  if (!isDate(req.query.date)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  const ids = getRooms().filter((r) => r.buildingCode === req.params.code).map((r) => r.id);
  res.json(await schedules(ids, req.query.date));
}));

app.post("/api/search", wrap(async (req, res) => {
  const { date, start, end } = req.body || {};
  if (!isDate(date) || !start || !end) return res.status(400).json({ error: "date, start, end required" });
  res.json(await search(req.body));
}));

const PORT = process.env.PORT || 5173;
app.listen(PORT, "127.0.0.1", () => console.log(`UQ Rooms → http://localhost:${PORT}`));
