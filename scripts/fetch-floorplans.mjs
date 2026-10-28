// Downloads real indoor floor plans (room polygons) for the library buildings
// from MazeMap — the engine behind maps.uq.edu.au (campus 406).
// Output: public/floorplans.json
import { writeFileSync } from "node:fs";

// Book It building prefix -> MazeMap building id
export const MAZEMAP_BUILDINGS = { "01": 3285, "02": 3441, "12": 3442, "50": 3409, "51": 3731, "94": 3664 };

const round = (c) => c.map((ring) => ring.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]));
const out = {};
for (const [code, id] of Object.entries(MAZEMAP_BUILDINGS)) {
  const res = await fetch(`https://api.mazemap.com/api/pois/?buildingid=${id}&srid=4326`);
  const { pois } = await res.json();
  const floors = {};
  for (const p of pois) {
    if (!p.geometry || p.geometry.type !== "Polygon") continue;
    const z = String(p.z);
    (floors[z] ||= { name: p.floorName || z, rooms: [] }).rooms.push({
      identifier: (p.identifier || "").toUpperCase(),
      title: p.title || "",
      kind: p.kind,
      coords: round(p.geometry.coordinates),
    });
  }
  out[code] = { mazemapId: id, floors };
  console.log(code, pois.length, "pois,", Object.keys(floors).length, "floors");
}
writeFileSync(new URL("../public/floorplans.json", import.meta.url), JSON.stringify(out));
