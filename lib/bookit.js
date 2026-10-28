// UQ Book It client (Scientia Resource Booker API, v4).
//
// Auth: Book It uses a 1-hour bearer token kept in the browser's localStorage
// ("scientia-session-authorization"). The companion Chrome extension in
// /extension forwards it here whenever it changes, so there's no password
// handling and nothing to paste.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://cyon-syd-v4-api-d1-02.azurewebsites.net/api";
export const LIBRARY_BOOKING_TYPE = "77b52dde-d704-4b6d-917e-e820f7df07cb";
export const BOOKIT_ROOM_URL = (id, date) =>
  `https://uqbookit.uq.edu.au/app/booking-types/${LIBRARY_BOOKING_TYPE}/resources/${id}${date ? `?date=${date}` : ""}`;

const CATALOG_FILE = new URL("../data/catalog.json", import.meta.url);

const SESSION_FILE = new URL("../data/.bookit-session", import.meta.url);
let token = null; // { value, exp (ms) }

// Survive server restarts: reuse the last session if it hasn't expired.
try {
  const saved = JSON.parse(readFileSync(SESSION_FILE));
  if (saved.exp > Date.now()) token = saved;
} catch { /* none saved */ }

export function setToken(raw) {
  const parts = String(raw).split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (!String(claims.iss || "").includes("scientia.com")) throw new Error("not a Book It token");
  token = { value: raw, exp: claims.exp * 1000 };
  writeFileSync(SESSION_FILE, JSON.stringify(token), { mode: 0o600 });
  return { expires: new Date(token.exp).toISOString() };
}

export function tokenStatus() {
  if (!token) return { connected: false };
  const left = token.exp - Date.now();
  return { connected: left > 0, expires: new Date(token.exp).toISOString(), minutesLeft: Math.max(0, Math.round(left / 60000)) };
}

export class NotConnectedError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  if (!token || token.exp < Date.now()) throw new NotConnectedError("UQ Book It session missing or expired");
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { token = null; throw new NotConnectedError("UQ Book It rejected the session"); }
  if (!res.ok) throw new Error(`Book It ${method} ${path} → ${res.status}`);
  return res.json();
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- catalog (room list + capacity/type), cached to disk ----------

const prop = (detail, name) => detail.Properties?.find((p) => p.Name === name)?.Value;

export async function refreshCatalog() {
  const listPath = `BookingTypes/${LIBRARY_BOOKING_TYPE}/BookableResourceGroupsAndResources`;
  const base = { ItemsPerPage: 500, Properties: [], LoadedIdentities: [] };
  const all = await api(listPath, { method: "POST", body: { ...base, ResourceGroupIdentities: [] } });

  const groupOf = {};
  for (const g of all.ResourceGroups) {
    const r = await api(listPath, { method: "POST", body: { ...base, ResourceGroupIdentities: [g.Identity] } });
    for (const res of r.Resources) groupOf[res.Identity] = g.Name;
  }

  const rooms = await pool(all.Resources, 8, async (r) => {
    const d = await api(`BookingTypes/${LIBRARY_BOOKING_TYPE}/Resources/${r.Identity}`);
    const code = r.Name.split(" ")[0]; // "12-N204A"
    return {
      id: r.Identity,
      code,
      name: r.Name,
      buildingCode: code.split("-")[0],
      library: prop(d, "Library")?.[0]?.Name || null,
      campus: prop(d, "Campus")?.[0]?.Name || null,
      type: groupOf[r.Identity] || prop(d, "Study option")?.[0]?.Name || null,
      capacity: prop(d, "Capacity") ?? null,
      description: (d.Description || "").trim(),
      rules: prop(d, "Booking rules") || null,
    };
  });
  const catalog = { fetchedAt: new Date().toISOString(), rooms };
  writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 1));
  return catalog;
}

export function loadCatalog() {
  return existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE)) : null;
}

// ---------- busy times ----------

const busyCache = new Map(); // `${id}|${date}` -> { at, data }
const BUSY_TTL = 180_000;

// Brisbane is UTC+10 all year (no DST).
const dayBoundsUTC = (date) => {
  const start = new Date(`${date}T00:00:00+10:00`);
  return [start, new Date(start.getTime() + 864e5)];
};

export async function busyTimes(resourceId, date) {
  const key = `${resourceId}|${date}`;
  const hit = busyCache.get(key);
  if (hit && Date.now() - hit.at < BUSY_TTL) return hit.data;
  const [s, e] = dayBoundsUTC(date);
  const raw = await api(
    `BookingTypes/${LIBRARY_BOOKING_TYPE}/Resources/${resourceId}/BusyTimes?StartDate=${s.toISOString()}&EndDate=${e.toISOString()}&ExcludeExamEvents=false`
  );
  // -> minutes since local midnight, clipped to the day
  const data = raw
    .map((b) => {
      const start = (new Date(b.StartDateTime) - s) / 60000;
      return { start: Math.max(0, start), end: Math.min(1440, start + b.Duration) };
    })
    .filter((b) => b.end > 0 && b.start < 1440)
    .sort((a, b) => a.start - b.start);
  busyCache.set(key, { at: Date.now(), data });
  return data;
}

export async function busyTimesMany(ids, date) {
  const out = {};
  await pool(ids, 12, async (id) => { out[id] = await busyTimes(id, date); });
  return out;
}
