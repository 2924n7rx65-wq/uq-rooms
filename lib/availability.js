// Availability = real Book It busy times, inside real library opening hours.
import { getRooms, roomById } from "./catalog.js";
import { busyTimesMany } from "./bookit.js";
import { hoursFor } from "./hours.js";

export const toMin = (hhmm) => { const [h, m = "0"] = String(hhmm).split(":"); return +h * 60 + +m; };
export const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Schedules for a set of rooms on one date: { roomId: {hours, bookings:[{start,end}]} } in minutes.
export async function schedules(roomIds, date) {
  const busy = await busyTimesMany(roomIds, date);
  const out = {};
  for (const id of roomIds) {
    const room = roomById(id);
    out[id] = { hours: await hoursFor(room.buildingCode, date), bookings: busy[id] };
  }
  return out;
}

const openWindow = (s) => (s.hours ? [s.hours.open, s.hours.close] : [0, 1440]);

export function freeIntervals(s) {
  const [o, c] = openWindow(s);
  const out = [];
  let cur = o;
  for (const b of s.bookings) {
    if (b.start > cur) out.push([cur, Math.min(b.start, c)]);
    cur = Math.max(cur, b.end);
  }
  if (cur < c) out.push([cur, c]);
  return out.filter(([a, b]) => b > a);
}

// Ranked search. Full matches: best-fitting capacity first, then how long the
// room stays free after the window. Partial: longest free overlap (>= 60 min).
export async function search({ buildingCodes = [], date, start, end, people = 1, types = [] }) {
  const s = toMin(start), e = toMin(end);
  const pool = getRooms().filter((r) =>
    (!buildingCodes.length || buildingCodes.includes(r.buildingCode)) &&
    (r.capacity == null || r.capacity >= people) &&
    (!types.length || types.includes(r.type))
  );
  const sched = await schedules(pool.map((r) => r.id), date);
  const full = [], partial = [];
  for (const r of pool) {
    const ivs = freeIntervals(sched[r.id]);
    const whole = ivs.find(([a, b]) => a <= s && b >= e);
    if (whole) {
      const waste = (r.capacity ?? people) - people;
      full.push({ id: r.id, freeUntil: whole[1] >= 1440 ? "midnight" : toHHMM(whole[1]), score: -waste * 10 + Math.min(whole[1] - e, 180) / 30 });
    } else {
      let best = null;
      for (const [a, b] of ivs) {
        const os = Math.max(s, a), oe = Math.min(e, b);
        if (oe - os >= 60 && (!best || oe - os > best.mins)) best = { id: r.id, start: toHHMM(os), end: toHHMM(oe), mins: oe - os };
      }
      if (best) partial.push(best);
    }
  }
  full.sort((a, b) => b.score - a.score);
  partial.sort((a, b) => b.mins - a.mins);
  return { full, partial: partial.slice(0, 20) };
}
