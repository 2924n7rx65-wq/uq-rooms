// Library buildings at UQ St Lucia that have Book It rooms, and the room list
// joined against real MazeMap floor plans.
import { readFileSync } from "node:fs";
import { loadCatalog } from "./bookit.js";

export const BUILDINGS = [
  { code: "12", osmRef: "12", name: "Central Library", short: "Central", building: "Duhig North" },
  { code: "02", osmRef: "2", name: "Duhig Tower", short: "Duhig Tower", building: "Duhig Tower" },
  { code: "01", osmRef: "1", name: "Walter Harrison Law Library", short: "Law", building: "Forgan Smith Building" },
  { code: "51", osmRef: "51", name: "Architecture & Music Library", short: "Arch & Music", building: "Zelman Cowen Building" },
  { code: "50", osmRef: "50", name: "Dorothy Hill Engineering & Sciences Library", short: "Dorothy Hill", building: "Hawken Engineering Building" },
  { code: "94", osmRef: "94", name: "Biological Sciences Library", short: "Bio Sci", building: "Biological Sciences Library" },
];
export const buildingByCode = new Map(BUILDINGS.map((b) => [b.code, b]));

const floorplans = JSON.parse(readFileSync(new URL("../public/floorplans.json", import.meta.url)));

// MazeMap identifiers drop the leading zero ("1-W437" for Book It "01-W437").
const norm = (code) => code.toUpperCase().replace(/^0+/, "");

function locate(code) {
  const b = floorplans[code.split("-")[0]];
  if (!b) return null;
  const want = [norm(code)];
  // Pods/booths like 12-N115-07 sit inside parent room 12-N115
  const parent = code.match(/^(.+)-\d{2}$/);
  if (parent) want.push(norm(parent[1]));
  for (const target of want) {
    for (const [z, fl] of Object.entries(b.floors)) {
      if (fl.rooms.some((r) => norm(r.identifier) === target)) {
        return { floor: z, mapId: target, inParent: target !== want[0] };
      }
    }
  }
  return null;
}

// Book It leaves capacity blank on some single-person spaces; the type name says it.
const TYPE_CAPACITY = { "One-person meeting booth": 1, "Two-person meeting booth": 2, "Individual study pods": 1, "Individual study rooms": 1 };

let rooms = [];
export function loadRooms() {
  const cat = loadCatalog();
  rooms = (cat?.rooms || [])
    .filter((r) => buildingByCode.has(r.buildingCode) && (!r.campus || r.campus === "St Lucia"))
    .map((r) => ({ ...r, capacity: r.capacity ?? TYPE_CAPACITY[r.type] ?? null, location: locate(r.code) }));
  return rooms;
}
loadRooms();

export const getRooms = () => rooms;
export const roomById = (id) => rooms.find((r) => r.id === id);
