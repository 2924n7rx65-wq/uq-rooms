// Real library opening hours from the public UQ Library API.
const URL_WEEK = "https://api.library.uq.edu.au/v1/library_hours/week";

// UQ Library location name -> Book It building codes it covers
const LOCATION_BUILDINGS = {
  "Architecture and Music": ["51"],
  "Biological Sciences": ["94"],
  "Central": ["12"],
  "Duhig Tower": ["02"],
  "Dorothy Hill Engineering and Sciences": ["50"],
  "Walter Harrison Law": ["01"],
};

let cache = { at: 0, byBuilding: {} };

const toMin = (hms) => { const [h, m] = hms.split(":").map(Number); return h * 60 + m; };

async function load() {
  if (Date.now() - cache.at < 3600_000) return cache.byBuilding;
  const res = await fetch(URL_WEEK);
  const { locations } = await res.json();
  const byBuilding = {};
  for (const loc of locations) {
    const codes = Object.entries(LOCATION_BUILDINGS).find(([name]) => loc.name.startsWith(name))?.[1];
    if (!codes) continue;
    // first department = the main study space
    const dept = loc.departments?.[0];
    for (const week of dept?.weeks || []) {
      for (const day of Object.values(week)) {
        if (!day?.date) continue;
        let hours;
        if (day.rendered === "24 Hours" || day.times?.status === "24hours") hours = { open: 0, close: 1440, label: "24 hours" };
        else if (day.times?.status === "closed" || !day.open) hours = { open: 0, close: 0, label: "Closed" };
        else hours = { open: toMin(day.open), close: day.close === "00:00:00" ? 1440 : toMin(day.close), label: day.rendered };
        for (const c of codes) (byBuilding[c] ||= {})[day.date] = hours;
      }
    }
  }
  cache = { at: Date.now(), byBuilding };
  return byBuilding;
}

// Returns {open, close, label} in minutes, or null if the library hasn't published hours for that date.
export async function hoursFor(buildingCode, date) {
  try {
    return (await load())[buildingCode]?.[date] || null;
  } catch {
    return null;
  }
}
