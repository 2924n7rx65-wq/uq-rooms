// Converts the raw Overpass dump (data/osm.json) into public/campus.geojson.
// Re-fetch with: see README.
import { readFileSync, writeFileSync } from "node:fs";
import { BUILDINGS } from "../lib/catalog.js";

const osm = JSON.parse(readFileSync(new URL("../data/osm.json", import.meta.url)));
const bookable = new Set(BUILDINGS.map((b) => b.osmRef));
const features = [];
for (const el of osm.elements) {
  if (!el.geometry || el.geometry.length < 4) continue;
  const t = el.tags || {};
  const ring = el.geometry.map((p) => [+p.lon.toFixed(7), +p.lat.toFixed(7)]);
  // Only named UQ buildings count as bookable (bare refs like "1" are college wings)
  const isBookable = bookable.has(t.ref) && !!t.name;
  const levels = parseInt(t["building:levels"] || "2", 10) || 2;
  features.push({
    type: "Feature",
    properties: {
      ref: t.ref || "", name: t.name || "", bookable: isBookable,
      height: Math.min(levels, 14) * 3.6, osmId: el.id,
    },
    geometry: { type: "Polygon", coordinates: [ring] },
  });
}
writeFileSync(new URL("../public/campus.geojson", import.meta.url), JSON.stringify({ type: "FeatureCollection", features }));
console.log(features.length, "features,", features.filter((f) => f.properties.bookable).map((f) => f.properties.ref).join(","), "bookable");
