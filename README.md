# UQ Rooms

Interactive 3D map of UQ St Lucia library study rooms with live availability from UQ Book It.

> Unofficial personal project, not affiliated with or endorsed by The University of Queensland.
> It only reads availability using your own Book It login; booking still happens on UQ Book It.

```
npm install
npm start          # http://localhost:5173
```

The first `npm start` downloads UQ's indoor floor plans from MazeMap into `public/floorplans.json` (not committed).

## One-time setup: the Book It bridge

Book It's data needs your UQ login. Its session token lasts 1 hour and lives in the browser, so a tiny
extension forwards it to this app (localhost only):

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`
2. Open https://uqbookit.uq.edu.au/ while logged in. The top bar turns green: "Live from UQ Book It".

Keep a Book It tab open to stay connected; it refreshes the session itself.

## Data sources (all real)

| What | Source |
| --- | --- |
| Rooms, capacity, type, description, booking rules | UQ Book It API (Scientia Resource Booker), library booking type, cached to `data/catalog.json` |
| Bookings / unavailable times | Book It `BusyTimes` per room, live (3-min cache) |
| Floor plans + room positions | MazeMap (the engine behind maps.uq.edu.au, campus 406), `public/floorplans.json`. Refresh with `node scripts/fetch-floorplans.mjs` |
| Opening hours | UQ Library API (`api.library.uq.edu.au/v1/library_hours/week`), current week only |
| Building footprints | © OpenStreetMap contributors (ODbL), `public/campus.geojson`. Rebuild by saving an Overpass export to `data/osm.json` and running `node scripts/build-campus.mjs` |

Book It room codes (`12-N204A`) match MazeMap identifiers (`12-n204a`; MazeMap drops the leading zero, e.g. `1-W437`).
Pods and booths like `12-N115-07` have no polygon of their own, so they're shown inside their parent room (`N115 · 12/42 free`).

## Search

Pick libraries, date (Book It allows up to 7 days ahead), time range, group size and room type. Rooms free for the
whole window are ranked by closest capacity fit, then how long they stay free afterwards. Rooms free for 1hr+ of
the window are listed below. "Book on UQ Book It" deep-links to that room's booking page for the date.
