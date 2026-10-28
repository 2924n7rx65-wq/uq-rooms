/* global maplibregl */
const $ = (s) => document.querySelector(s);
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toHHMM = (m) => m >= 1440 ? "24:00" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const localISO = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => localISO(new Date(new Date(`${iso}T12:00:00`).getTime() + n * 864e5));
// MazeMap identifiers drop the leading zero of the building ("1-W437" = Book It "01-W437")
const norm = (code) => String(code).toUpperCase().replace(/^0+/, "");

const state = {
  buildings: [], rooms: [], campus: null, floorplans: null,
  connected: false,
  date: localISO(), start: 600, duration: 120, people: 1,
  schedules: {},            // `${date}|${building}` -> { roomId: {hours, bookings} }
  activeBuilding: null, activeFloor: null, selectedRoom: null, selectedMapId: null,
  highlight: new Set(),
  markers: {},
};
const bName = (code) => state.buildings.find((b) => b.code === code);

// ---------- availability ----------
const sched = (roomId) => {
  const r = state.rooms.find((x) => x.id === roomId);
  return state.schedules[`${state.date}|${r.buildingCode}`]?.[roomId];
};
function isPast(min) {
  if (state.date !== localISO()) return state.date < localISO();
  const now = new Date();
  return min <= now.getHours() * 60 + now.getMinutes();
}
function roomStatus(roomId) {
  const s = sched(roomId);
  if (!s) return "unknown";
  const ws = state.start, we = state.start + state.duration;
  const [o, c] = s.hours ? [s.hours.open, s.hours.close] : [0, 1440];
  if (ws < o || we > c || isPast(we)) return "busy";
  let booked = 0;
  for (const b of s.bookings) {
    const os = Math.max(ws, b.start), oe = Math.min(we, b.end);
    if (oe > os) booked += oe - os;
  }
  return booked === 0 ? "free" : booked < state.duration ? "partial" : "busy";
}
const fitsPeople = (r) => r.capacity == null || r.capacity >= state.people;
const STATUS_ORDER = { free: 0, partial: 1, busy: 2, unknown: 3 };
const groupStatus = (rooms) => rooms.reduce((best, r) => {
  const s = fitsPeople(r) ? roomStatus(r.id) : "busy";
  return STATUS_ORDER[s] < STATUS_ORDER[best] ? s : best;
}, "unknown");

async function loadSchedules(date, codes = state.buildings.map((b) => b.code)) {
  if (!state.connected) return;
  await Promise.all(codes.map(async (code) => {
    const key = `${date}|${code}`;
    if (state.schedules[key]) return;
    const res = await fetch(`/api/buildings/${code}/schedule?date=${date}`);
    if (res.status === 503) { setConnected(false); return; }
    if (res.ok) state.schedules[key] = await res.json();
  }));
}

// ---------- Book It connection ----------
async function checkStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    const was = state.connected;
    setConnected(s.connected, s);
    if (s.connected && (!was || s.rooms !== state.rooms.length)) {
      if (s.rooms !== state.rooms.length) { await loadCatalog(); renderTypeChips(); }
      await refresh();
    }
  } catch { setConnected(false); }
}
function setConnected(on, s = {}) {
  state.connected = on;
  if (!on) state.schedules = {};
  $("#conn").className = "conn " + (on ? "on" : "off");
  $("#conn").innerHTML = on
    ? `<i></i>Live from UQ Book It <span class="muted">· ${s.minutesLeft ?? "?"} min left</span>`
    : `<i></i>Not connected to UQ Book It, <a href="https://uqbookit.uq.edu.au/" target="_blank" rel="noopener">open Book It</a> (bridge extension required)`;
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [153.0132, -27.4975], zoom: 16.1, pitch: 50, bearing: -18,
  maxBounds: [[152.995, -27.512], [153.032, -27.485]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

const ringCentroid = (ring) => {
  let x = 0, y = 0;
  ring.forEach(([lng, lat]) => { x += lng; y += lat; });
  return [x / ring.length, y / ring.length];
};
const bboxOf = (rings) => {
  const pts = rings.flat();
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
};
const footprint = (code) => {
  const ref = bName(code)?.osmRef;
  return state.campus.features.find((f) => f.properties.bookable && f.properties.ref === ref);
};

async function loadCatalog() {
  const cat = await fetch("/api/catalog").then((r) => r.json());
  state.buildings = cat.buildings;
  state.rooms = cat.rooms;
}

const dataReady = Promise.all([
  loadCatalog(),
  fetch("/campus.geojson").then((r) => r.json()).then((c) => (state.campus = c)),
  fetch("/floorplans.json").then((r) => r.json()).then((f) => (state.floorplans = f)),
]);

map.once("style.load", async () => {
  await dataReady;
  for (const layer of map.getStyle().layers) {
    if (layer.type === "fill-extrusion" || /building/.test(layer.id)) map.setLayoutProperty(layer.id, "visibility", "none");
  }

  map.addSource("campus", { type: "geojson", data: state.campus, promoteId: "osmId" });
  map.addLayer({
    id: "campus-3d", type: "fill-extrusion", source: "campus",
    filter: ["!", ["get", "bookable"]],
    paint: { "fill-extrusion-color": "#2a2540", "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": 0.85 },
  });
  map.addLayer({
    id: "bookable-3d", type: "fill-extrusion", source: "campus",
    filter: ["get", "bookable"],
    paint: {
      "fill-extrusion-color": ["case", ["boolean", ["feature-state", "hover"], false], "#8d5cc9", "#5f2d91"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 0.95,
    },
  });
  map.addLayer({ id: "bookable-glow", type: "line", source: "campus", filter: ["get", "bookable"], paint: { "line-color": "#c9a6ff", "line-width": 2, "line-blur": 3 } });

  // Indoor floor plan of the open building (real MazeMap polygons)
  map.addSource("indoor", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "indoor-fill", type: "fill", source: "indoor",
    paint: {
      "fill-color": ["match", ["get", "status"], "free", "#3ddc97", "partial", "#f5b942", "busy", "#ff5d73", "unknown", "#8b84a8", "#3a3452"],
      "fill-opacity": ["match", ["get", "status"], "none", 0.55, 0.75],
    },
  });
  map.addLayer({ id: "indoor-line", type: "line", source: "indoor", paint: { "line-color": "#d9d2ee", "line-width": 0.6, "line-opacity": 0.6 } });
  map.addLayer({
    id: "indoor-label", type: "symbol", source: "indoor", filter: ["!=", ["get", "status"], "none"], minzoom: 17.5,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-allow-overlap": false },
    paint: { "text-color": "#fff", "text-halo-color": "#000", "text-halo-width": 1.2 },
  });
  map.on("click", "indoor-fill", (e) => {
    const id = e.features[0].properties.mapId;
    if (id) selectMapRoom(id);
  });
  map.on("mouseenter", "indoor-fill", (e) => { if (e.features[0].properties.mapId) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "indoor-fill", () => (map.getCanvas().style.cursor = ""));

  let hoverId = null;
  map.on("mousemove", "bookable-3d", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const id = e.features[0].id;
    if (hoverId !== id) {
      if (hoverId != null) map.setFeatureState({ source: "campus", id: hoverId }, { hover: false });
      hoverId = id;
      map.setFeatureState({ source: "campus", id }, { hover: true });
    }
  });
  map.on("mouseleave", "bookable-3d", () => {
    map.getCanvas().style.cursor = "";
    if (hoverId != null) map.setFeatureState({ source: "campus", id: hoverId }, { hover: false });
    hoverId = null;
  });
  map.on("click", "bookable-3d", (e) => {
    const b = state.buildings.find((x) => x.osmRef === e.features[0].properties.ref);
    if (b) openBuilding(b.code);
  });

  for (const b of state.buildings) {
    const f = footprint(b.code);
    if (!f) continue;
    const el = document.createElement("div");
    el.className = "bmarker";
    el.innerHTML = `<div class="pill"><span class="count">–</span>${esc(b.short)}</div><div class="stem"></div>`;
    el.addEventListener("click", (ev) => { ev.stopPropagation(); openBuilding(b.code); });
    state.markers[b.code] = { el, marker: new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(ringCentroid(f.geometry.coordinates[0])).addTo(map) };
  }

  initControls();
  initFinder();
  await checkStatus();
  setInterval(checkStatus, 30000);
  render();
});

// ---------- controls ----------
function initControls() {
  const now = new Date();
  state.start = Math.min(Math.max(Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30, 420), 1290);
  for (const el of [$("#date"), $("#fDate")]) { el.min = localISO(); el.max = addDays(localISO(), 7); el.value = state.date; }
  $("#time").value = state.start;
  $("#timeLabel").textContent = toHHMM(state.start);

  $("#date").addEventListener("change", (e) => { state.date = e.target.value; refresh(); });
  $("#time").addEventListener("input", (e) => { state.start = +e.target.value; $("#timeLabel").textContent = toHHMM(state.start); render(); });
  $("#duration").addEventListener("change", (e) => { state.duration = +e.target.value; render(); });
  $("#people").addEventListener("change", (e) => { state.people = +e.target.value; render(); });
  $("#back").addEventListener("click", closeBuilding);
}

function setWindow({ date, start, end }) {
  if (date) { state.date = date; $("#date").value = date; }
  if (start) {
    state.start = Math.max(0, Math.min(1410, toMin(start)));
    $("#time").value = state.start; $("#timeLabel").textContent = toHHMM(state.start);
  }
  if (start && end) {
    const d = toMin(end) - toMin(start);
    state.duration = d;
    const sel = $("#duration");
    if (![...sel.options].some((o) => +o.value === d)) sel.add(new Option(`${d / 60} hr`, d));
    sel.value = d;
  }
}

async function refresh() {
  document.body.classList.add("loading");
  await loadSchedules(state.date);
  document.body.classList.remove("loading");
  render();
}

function render() {
  for (const b of state.buildings) {
    const m = state.markers[b.code];
    if (!m) continue;
    const rooms = state.rooms.filter((r) => r.buildingCode === b.code && fitsPeople(r));
    const c = m.el.querySelector(".count");
    if (!state.connected || !state.schedules[`${state.date}|${b.code}`]) {
      c.textContent = rooms.length ? "?" : "0"; c.className = "count unknown";
    } else {
      const free = rooms.filter((r) => roomStatus(r.id) === "free").length;
      c.textContent = free;
      c.className = "count" + (free === 0 ? " none" : free <= 2 ? " few" : "");
    }
    m.el.classList.toggle("dim", !!state.activeBuilding && state.activeBuilding !== b.code);
    m.el.classList.toggle("hidden", state.activeBuilding === b.code);
    const hit = state.rooms.some((r) => r.buildingCode === b.code && state.highlight.has(r.id));
    m.el.classList.toggle("hit", hit && state.activeBuilding !== b.code);
  }
  if (state.activeBuilding) renderPanel();
  renderIndoor();
}

// ---------- building panel + indoor map ----------
function buildingFloors(code) {
  const zs = new Set(state.rooms.filter((r) => r.buildingCode === code && r.location).map((r) => r.location.floor));
  return [...zs].sort((a, b) => +a - +b);
}
const floorName = (code, z) => state.floorplans[code]?.floors[z]?.name ?? z;
// Book It rooms drawn by each MazeMap polygon on the active floor
function floorGroups() {
  const groups = new Map();
  for (const r of state.rooms) {
    if (r.buildingCode !== state.activeBuilding || r.location?.floor !== state.activeFloor) continue;
    if (!groups.has(r.location.mapId)) groups.set(r.location.mapId, []);
    groups.get(r.location.mapId).push(r);
  }
  return groups;
}

function openBuilding(code, { floor, room } = {}) {
  const b = bName(code);
  const f = footprint(code);
  if (!b || !f) return;
  state.activeBuilding = code;
  const floors = buildingFloors(code);
  const r = room && state.rooms.find((x) => x.id === room);
  const hl = state.rooms.find((x) => x.buildingCode === code && state.highlight.has(x.id) && x.location);
  state.activeFloor = floor ?? r?.location?.floor ?? hl?.location?.floor ?? floors[0] ?? null;
  state.selectedRoom = room || null;
  state.selectedMapId = r?.location?.mapId || null;

  map.setFilter("bookable-3d", ["all", ["get", "bookable"], ["!=", ["get", "osmId"], f.properties.osmId]]);
  map.setFilter("bookable-glow", ["all", ["get", "bookable"], ["!=", ["get", "osmId"], f.properties.osmId]]);
  map.setPaintProperty("campus-3d", "fill-extrusion-opacity", 0.25);
  map.setPaintProperty("bookable-3d", "fill-extrusion-opacity", 0.3);

  const plan = state.floorplans[code]?.floors[state.activeFloor];
  const rings = plan ? plan.rooms.map((x) => x.coords[0]) : f.geometry.coordinates;
  const finderOpen = window.innerWidth > 760 && !$("#finder").classList.contains("collapsed");
  map.fitBounds(bboxOf(rings), {
    padding: { top: 120, bottom: window.innerWidth > 760 ? 60 : window.innerHeight * 0.62, left: finderOpen ? 440 : 60, right: window.innerWidth > 760 ? 540 : 60 },
    pitch: 35, bearing: map.getBearing() - 15, maxZoom: 19.2, duration: 2000, essential: true,
  });

  $("#pCode").textContent = `Building ${b.osmRef} · ${b.building}`;
  $("#pName").textContent = b.name;
  $("#panel").classList.add("open");
  $("#panel").setAttribute("aria-hidden", "false");
  loadSchedules(state.date, [code]).then(render);
  render();
}

function closeBuilding() {
  state.activeBuilding = null; state.selectedRoom = null; state.selectedMapId = null;
  map.setFilter("bookable-3d", ["get", "bookable"]);
  map.setFilter("bookable-glow", ["get", "bookable"]);
  map.setPaintProperty("campus-3d", "fill-extrusion-opacity", 0.85);
  map.setPaintProperty("bookable-3d", "fill-extrusion-opacity", 0.95);
  $("#panel").classList.remove("open");
  $("#panel").setAttribute("aria-hidden", "true");
  map.flyTo({ center: [153.0132, -27.4975], zoom: 16.1, pitch: 50, bearing: -18, duration: 1800 });
  render();
}

function selectMapRoom(mapId) {
  state.selectedMapId = mapId;
  const members = floorGroups().get(mapId) || [];
  state.selectedRoom = members.length === 1 ? members[0].id : null;
  renderPanel();
}

function renderIndoor() {
  const src = map.getSource && map.getSource("indoor");
  if (!src) return;
  const plan = state.activeBuilding && state.floorplans[state.activeBuilding]?.floors[state.activeFloor];
  if (!plan) { src.setData({ type: "FeatureCollection", features: [] }); return; }
  const groups = floorGroups();
  src.setData({
    type: "FeatureCollection",
    features: plan.rooms.map((p) => {
      const members = groups.get(norm(p.identifier));
      const label = members ? (members.length > 1 ? `${p.identifier.split("-").pop()} (${members.length})` : p.identifier.split("-").pop()) : "";
      return {
        type: "Feature",
        properties: { status: members ? groupStatus(members) : "none", label, mapId: members ? norm(p.identifier) : "" },
        geometry: { type: "Polygon", coordinates: p.coords },
      };
    }),
  });
}

function renderPanel() {
  const code = state.activeBuilding;
  const rooms = state.rooms.filter((r) => r.buildingCode === code);
  const s0 = rooms.length ? sched(rooms[0].id) : null;
  const hours = s0?.hours ? `Open ${s0.hours.label} on ${state.date}.` : state.connected ? "Opening hours not published for this date yet." : "";
  $("#pSub").textContent = `${rooms.length} bookable rooms. ${hours}`;

  const floors = buildingFloors(code);
  $("#floors").innerHTML = floors.map((z) => {
    const fr = rooms.filter((r) => r.location?.floor === z);
    const free = state.connected ? fr.filter((r) => fitsPeople(r) && roomStatus(r.id) === "free").length : "?";
    return `<button data-floor="${z}" class="${z === state.activeFloor ? "active" : ""}">L${esc(floorName(code, z))}<span class="n">${free}/${fr.length} free</span></button>`;
  }).join("");
  $("#floors").querySelectorAll("button").forEach((btn) => btn.onclick = () => {
    state.activeFloor = btn.dataset.floor; state.selectedMapId = null; state.selectedRoom = null; render();
  });

  renderSchematic();
  renderRoomCard();

  // room list: rooms on this floor (or in the selected polygon), then unmapped ones
  let list = rooms.filter((r) => r.location?.floor === state.activeFloor);
  if (state.selectedMapId) list = list.filter((r) => r.location.mapId === state.selectedMapId);
  list.sort((a, c) => STATUS_ORDER[roomStatus(a.id)] - STATUS_ORDER[roomStatus(c.id)] || a.code.localeCompare(c.code));
  const unmapped = rooms.filter((r) => !r.location);
  const row = (r) => `<div class="row ${state.selectedRoom === r.id ? "selected" : ""}" data-id="${r.id}">
      <i class="dot ${roomStatus(r.id)}"></i>${esc(r.code)}<span class="type">${esc(r.type || "")}</span><span class="meta">${r.capacity ?? "?"}p</span></div>`;
  $("#roomList").innerHTML =
    `<div class="hdr">${state.selectedMapId ? `Inside ${esc(state.selectedMapId)} · <a href="#" id="clearSel">show whole floor</a>` : `Level ${esc(floorName(code, state.activeFloor))}`} · ${toHHMM(state.start)}–${toHHMM(state.start + state.duration)}</div>` +
    list.map(row).join("") +
    (unmapped.length && !state.selectedMapId ? `<div class="hdr">Not on the UQ floor plan</div>` + unmapped.map(row).join("") : "");
  $("#roomList").querySelectorAll(".row").forEach((el) => el.onclick = () => {
    const r = state.rooms.find((x) => x.id === el.dataset.id);
    state.selectedRoom = r.id;
    if (r.location && r.location.floor !== state.activeFloor) state.activeFloor = r.location.floor;
    render();
  });
  $("#clearSel")?.addEventListener("click", (e) => { e.preventDefault(); state.selectedMapId = null; state.selectedRoom = null; render(); });
}

function renderSchematic() {
  const plan = state.floorplans[state.activeBuilding]?.floors[state.activeFloor];
  const svg = $("#schematic");
  if (!plan) { svg.innerHTML = ""; return; }
  const pts = plan.rooms.flatMap((p) => p.coords[0]);
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * k), ys = pts.map((p) => -p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  const S = 100 / Math.max(w, h);
  const P = ([lng, lat]) => [((lng * k - minX) * S).toFixed(2), ((-lat - minY) * S).toFixed(2)];
  const groups = floorGroups();
  // Frame the bookable rooms (with surrounding context) rather than the whole floor
  const focus = plan.rooms.filter((p) => groups.has(norm(p.identifier))).flatMap((p) => p.coords[0].map(P));
  if (focus.length) {
    const fx = focus.map((q) => +q[0]), fy = focus.map((q) => +q[1]);
    let x0 = Math.min(...fx), x1 = Math.max(...fx), y0 = Math.min(...fy), y1 = Math.max(...fy);
    const pad = Math.max(8, (x1 - x0) * 0.25, (y1 - y0) * 0.25);
    x0 = Math.max(-2, x0 - pad); y0 = Math.max(-2, y0 - pad);
    x1 = Math.min(w * S + 2, x1 + pad); y1 = Math.min(h * S + 2, y1 + pad);
    svg.setAttribute("viewBox", `${x0.toFixed(1)} ${y0.toFixed(1)} ${(x1 - x0).toFixed(1)} ${(y1 - y0).toFixed(1)}`);
    svg.style.setProperty("--fs", ((x1 - x0) / 60).toFixed(2));
  } else {
    svg.setAttribute("viewBox", `-2 -2 ${(w * S + 4).toFixed(1)} ${(h * S + 4).toFixed(1)}`);
    svg.style.setProperty("--fs", "1.7");
  }

  const parts = [];
  const labels = [];
  for (const p of plan.rooms) {
    const id = norm(p.identifier);
    const members = groups.get(id);
    const d = "M" + p.coords[0].map(P).map((q) => q.join(",")).join("L") + "Z";
    if (!members) {
      parts.push(`<path class="bg ${p.kind}" d="${d}"><title>${esc(p.title)}</title></path>`);
      continue;
    }
    const st = groupStatus(members);
    const sel = state.selectedMapId === id ? " selected" : "";
    const pulse = members.some((m) => state.highlight.has(m.id)) ? " pulse" : "";
    parts.push(`<path class="room ${st}${sel}${pulse}" data-map="${esc(id)}" d="${d}"></path>`);
    const [cx, cy] = P(ringCentroid(p.coords[0]));
    const short = id.split("-").pop();
    labels.push(`<text class="lbl" x="${cx}" y="${cy}">${esc(short)}${members.length > 1 ? `<tspan class="sub" x="${cx}" dy="1.3em">${members.filter((m) => roomStatus(m.id) === "free").length}/${members.length} free</tspan>` : ""}</text>`);
  }
  svg.innerHTML = parts.join("") + labels.join("");
  svg.querySelectorAll(".room").forEach((el) => {
    const members = groups.get(el.dataset.map);
    el.addEventListener("click", () => selectMapRoom(el.dataset.map));
    el.addEventListener("mousemove", (e) => showTip(e, members.length === 1
      ? `<b>${esc(members[0].code)}</b> · ${esc(members[0].type || "")}<br>${members[0].capacity ?? "?"} people<br><span class="st-${roomStatus(members[0].id)}">${statusText(roomStatus(members[0].id))}</span>`
      : `<b>${esc(el.dataset.map)}</b><br>${members.length} bookable ${esc(members[0].type || "spaces").toLowerCase()} inside`));
    el.addEventListener("mouseleave", hideTip);
  });
}

function statusText(st) {
  return { free: "Free for the whole window", partial: "Free for part of the window", busy: "Booked / closed", unknown: "Availability unknown (not connected)" }[st];
}

function renderRoomCard() {
  const card = $("#roomCard");
  const r = state.rooms.find((x) => x.id === state.selectedRoom);
  if (!r || r.buildingCode !== state.activeBuilding) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const s = sched(r.id);
  const link = `${r.bookitUrl}?date=${state.date}`;
  const head = `<div class="rc-head"><h3>${esc(r.code)}</h3><span class="chip st-${roomStatus(r.id)}">${roomStatus(r.id)}</span></div>
    <div class="rc-meta">${esc(r.type || "")} · ${r.capacity ?? "?"} people${r.location ? ` · Level ${esc(floorName(r.buildingCode, r.location.floor))}` : ""}</div>
    ${r.description ? `<div class="rc-desc">${esc(r.description)}</div>` : ""}`;
  if (!s) {
    card.innerHTML = head + `<div class="rc-free">Connect UQ Book It to see this room's bookings.</div><a class="book-btn" href="${link}" target="_blank" rel="noopener">Open in UQ Book It ↗</a>`;
    return;
  }
  const [o, c] = s.hours && s.hours.close > s.hours.open ? [s.hours.open, s.hours.close] : [0, 1440];
  const span = c - o;
  const pct = (m) => ((Math.max(o, Math.min(c, m)) - o) / span) * 100;
  const now = new Date();
  const pastEnd = state.date === localISO() ? now.getHours() * 60 + now.getMinutes() : state.date < localISO() ? c : o;
  const bars = s.bookings.map((b) => `<div class="bk" style="left:${pct(b.start)}%;width:${pct(b.end) - pct(b.start)}%" title="Unavailable ${toHHMM(b.start)}–${toHHMM(b.end)}"></div>`).join("");
  const free = [];
  let cur = o;
  for (const b of s.bookings) { if (b.start > cur) free.push([cur, Math.min(b.start, c)]); cur = Math.max(cur, b.end); }
  if (cur < c) free.push([cur, c]);
  const ticks = [];
  for (let m = Math.ceil(o / 180) * 180; m <= c; m += 180) ticks.push(`<span>${toHHMM(m)}</span>`);
  const closed = s.hours && s.hours.close <= s.hours.open;

  card.innerHTML = head + `
    <div class="timeline" id="tl">
      ${closed ? `<div class="bk" style="left:0;width:100%"></div>` : bars}
      ${pastEnd > o ? `<div class="past" style="width:${pct(pastEnd)}%"></div>` : ""}
      <div class="win" style="left:${pct(state.start)}%;width:${pct(state.start + state.duration) - pct(state.start)}%"></div>
    </div>
    <div class="ticks">${ticks.join("")}</div>
    <div class="rc-free">${closed ? "Library closed this day." : `Free: ${free.filter(([a, b]) => b - a >= 15).map(([a, b]) => `<b>${toHHMM(a)}–${toHHMM(b)}</b>`).join(", ") || "fully booked"}`}</div>
    ${r.rules ? `<div class="rc-rules">${esc(r.rules)}</div>` : ""}
    <a class="book-btn" href="${link}" target="_blank" rel="noopener">Book on UQ Book It ↗</a>`;
  $("#tl").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const m = Math.round((o + ((e.clientX - rect.left) / rect.width) * span) / 30) * 30;
    setWindow({ start: toHHMM(m) });
    render();
  });
}

const tip = $("#tooltip");
function showTip(e, html) { tip.innerHTML = html; tip.classList.remove("hidden"); tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px"; }
function hideTip() { tip.classList.add("hidden"); }

// ---------- room finder ----------
const finder = { buildings: new Set(), types: new Set() };

function initFinder() {
  const chip = (label, key, set, container) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.onclick = () => { set.has(key) ? set.delete(key) : set.add(key); b.classList.toggle("on"); };
    container.appendChild(b);
  };
  state.buildings.forEach((b) => chip(b.short, b.code, finder.buildings, $("#fBuildings")));
  renderTypeChips = () => {
    $("#fTypes").innerHTML = "";
    [...new Set(state.rooms.map((r) => r.type).filter(Boolean))].sort().forEach((t) => chip(t, t, finder.types, $("#fTypes")));
  };
  renderTypeChips();

  for (let m = 0; m <= 1440; m += 30) {
    if (m < 1440) $("#fStart").add(new Option(toHHMM(m), toHHMM(m)));
    if (m > 0) $("#fEnd").add(new Option(toHHMM(m), toHHMM(m)));
  }
  $("#fStart").value = toHHMM(state.start);
  $("#fEnd").value = toHHMM(Math.min(state.start + 120, 1440));
  $("#results").innerHTML = `<div class="empty">Pick filters and hit search. Leave buildings blank to search every library.</div>`;
  $("#finderBar").onclick = () => $("#finder").classList.toggle("collapsed");
  $("#finderForm").onsubmit = (e) => { e.preventDefault(); runSearch(); };
}
let renderTypeChips = () => {};

async function runSearch() {
  const q = {
    buildingCodes: [...finder.buildings], date: $("#fDate").value,
    start: $("#fStart").value, end: $("#fEnd").value,
    people: Math.max(1, +$("#fPeople").value || 1), types: [...finder.types],
  };
  if (toMin(q.end) <= toMin(q.start)) { $("#results").innerHTML = `<div class="empty">"To" has to be after "From".</div>`; return; }
  $("#results").innerHTML = `<div class="empty">Checking UQ Book It…</div>`;
  const resp = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) });
  if (resp.status === 503) {
    setConnected(false);
    $("#results").innerHTML = `<div class="empty">Not connected to UQ Book It. Open <a href="https://uqbookit.uq.edu.au/" target="_blank" rel="noopener">uqbookit.uq.edu.au</a> while logged in (with the UQ Rooms bridge extension installed), then search again.</div>`;
    return;
  }
  if (!resp.ok) { $("#results").innerHTML = `<div class="empty">Book It request failed: ${esc((await resp.json()).message)}</div>`; return; }
  const res = await resp.json();

  state.people = 1; $("#people").value = "1";
  setWindow(q);
  state.highlight = new Set(res.full.map((r) => r.id));
  await refresh();
  if (q.buildingCodes.length === 1) openBuilding(q.buildingCodes[0]);
  else if (state.activeBuilding) closeBuilding();

  const room = (id) => state.rooms.find((r) => r.id === id);
  const row = (r, i, when, cls = "") => `<div class="res ${cls}" data-id="${r.id}">
      <span class="rank">${i}</span>
      <div class="main"><div class="name">${esc(r.code)} <span class="lib">${esc(bName(r.buildingCode).short)}</span></div>
      <div class="info">${esc(r.type || "")} · ${r.capacity ?? "?"} people${r.location ? ` · L${esc(floorName(r.buildingCode, r.location.floor))}` : ""}</div></div>
      <div class="when">${when}</div></div>`;
  let html = `<div class="hdr">${res.full.length} free ${q.start}–${q.end}</div>`;
  html += res.full.length ? res.full.map((x, i) => row(room(x.id), i + 1, `free till ${x.freeUntil}`)).join("")
    : `<div class="empty">Nothing is free for the whole window.</div>`;
  if (res.partial.length) html += `<div class="hdr">Partly free (1hr+)</div>` + res.partial.map((x) => row(room(x.id), "", `${x.start}–${x.end}`, "part")).join("");
  $("#results").innerHTML = html;
  $("#results").querySelectorAll(".res").forEach((el) => el.onclick = () => {
    const r = room(el.dataset.id);
    openBuilding(r.buildingCode, { room: r.id });
  });
}
