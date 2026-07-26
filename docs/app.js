/* SG Parking Finder */

const ONEMAP_SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search";
// OpenStreetMap (Nominatim) — picks up POIs/businesses (e.g. small studios, cafes)
// that OneMap's SLA address/building index doesn't carry.
const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
const SG_VIEWBOX = "103.59,1.48,104.09,1.13"; // minlon,maxlat,maxlon,minlat
const AVAIL_API = "https://api.data.gov.sg/v1/transport/carpark-availability";
// LTA DataMall mall/URA lots, refreshed every 5 min by a GitHub Action
const LTA_AVAIL_URL = "https://raw.githubusercontent.com/zhikang-wong/sg-parking-finder/availability/availability.json";
const MATCH_RADIUS = 150; // m: max distance to pair an LTA record with a carpark
const WALK_SPEED = 80;      // metres per minute
const ROUTE_FACTOR = 1.25;  // straight-line -> street distance fudge (fallback only)
const MAX_RESULTS = 40;
// real pedestrian routing over the OpenStreetMap network (OSRM foot profile)
const OSRM_TABLE = "https://routing.openstreetmap.de/routed-foot/table/v1/foot/";

const state = {
  carparks: [],
  avail: {},          // hdb carpark_no -> {lots, total}
  availById: {},      // carpark id -> {lots} (LTA/URA malls, proximity-matched)
  dest: null,         // {lat, lng, name}
  sort: "walk",
  activeId: null,
  walkCache: new Map(),   // "destKey|cpId" -> {dist m, secs} from OSRM
  routingFor: null,       // destKey of the in-flight OSRM request
};
const getAvail = (cp) => cp.hdbNo ? state.avail[cp.hdbNo] : state.availById[cp.id];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true }).setView([1.3521, 103.8198], 12);
L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.onemap.gov.sg/">OneMap</a> &copy; Singapore Land Authority | ' +
    'Geocoding &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let destMarker = null;
new ResizeObserver(() => map.invalidateSize()).observe($("map"));

// ---------------------------------------------------------------- utils
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const walkMins = (m) => Math.max(1, Math.round(m * ROUTE_FACTOR / WALK_SPEED));
const fmtDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
const esc = (s) => (s || "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDur(min) {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} hr${h > 1 ? "s" : ""}` : `${h.toFixed(1)} hrs`;
}

// ---------------------------------------------------------------- cost engine
// Mirrors scripts/rates.py. Segments: ["f",s,e,fp,fd,pp,pi] first-block rate,
// ["p",s,e,pp,pi] per-interval, ["e",s,e,p] per-entry, ["z",s,e] free.
function findSeg(segs, m) {
  let best = null;
  for (const seg of segs) {
    const s = seg[1], e = seg[2];
    if ((e > s && m >= s && m < e) || (e <= s && (m >= s || m < e))) return seg;
    if (s <= m && (!best || s > best[1])) best = seg;
  }
  return best || segs[0];
}

function estimateCost(rates, when, durMin) {
  if (!rates) return null;
  let total = 0, rem = durMin, first = true, guard = 0;
  let day = when.getDay();                       // 0 sun ... 6 sat
  let m = when.getHours() * 60 + when.getMinutes();
  while (rem > 0 && guard++ < 40) {
    const segs = day === 0 ? rates.u : day === 6 ? rates.a : rates.w;
    if (!segs || !segs.length) return null;
    const mm = m % 1440;
    const seg = findSeg(segs, mm);
    const s = seg[1], e = seg[2];
    let until;
    if (e > s) until = (mm >= s && mm < e) ? e - mm : mm < s ? s - mm : 1440 - mm;
    else until = mm >= s ? (1440 - mm) + e : mm < e ? e - mm : s - mm;
    const visit = Math.min(rem, Math.max(1, until));
    const kind = seg[0];
    if (kind === "e") total += seg[3];
    else if (kind === "p") total += Math.ceil(visit / seg[4]) * seg[3];
    else if (kind === "f") {
      const [, , , fp, fd, pp, pi] = seg;
      if (first) {
        total += fp;
        if (visit > fd) total += Math.ceil((visit - fd) / pi) * pp;
      } else {
        total += Math.ceil(visit / pi) * pp;
      }
    }
    first = false;
    rem -= visit;
    m += visit;
    if (m >= 1440) { m -= 1440; day = (day + 1) % 7; }
  }
  return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------- data
async function loadCarparks() {
  const res = await fetch("carparks.json");
  state.carparks = await res.json();
}

async function loadAvailability() {
  const el = $("availStatus");
  try {
    const res = await fetch(AVAIL_API);
    const data = await res.json();
    const items = data.items?.[0]?.carpark_data || [];
    state.avail = {};
    for (const cp of items) {
      const info = (cp.carpark_info || []).find(i => i.lot_type === "C") || cp.carpark_info?.[0];
      if (info) state.avail[cp.carpark_number] = {
        lots: parseInt(info.lots_available, 10),
        total: parseInt(info.total_lots, 10),
      };
    }
    const t = new Date(data.items?.[0]?.timestamp || Date.now());
    el.textContent = `live lots @ ${t.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    el.textContent = "live availability unavailable";
  }
}

async function loadLtaAvailability() {
  // Pair each LTA/URA record with the nearest commercial carpark within MATCH_RADIUS.
  try {
    const res = await fetch(LTA_AVAIL_URL, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const commercial = state.carparks.filter(cp => !cp.hdbNo);
    const byId = {};
    for (const r of data.carparks || []) {
      let best = null, bestDist = MATCH_RADIUS;
      for (const cp of commercial) {
        const d = haversine(r.lat, r.lng, cp.lat, cp.lng);
        if (d < bestDist) { best = cp; bestDist = d; }
      }
      if (best) {
        const cur = byId[best.id];
        byId[best.id] = { lots: (cur?.lots || 0) + r.lots }; // sum multi-zone developments
      }
    }
    state.availById = byId;
  } catch { /* mall availability is best-effort */ }
}

// ---------------------------------------------------------------- search
let debounceTimer = null;
$("search").addEventListener("input", (e) => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  debounceTimer = setTimeout(() => suggest(q), 350);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) hideSuggestions();
  if (!e.target.closest(".nav-menu")) closeNavMenus();
});

async function fetchOneMapSuggestions(q) {
  const url = `${ONEMAP_SEARCH}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.results || [])
    .map(r => ({
      name: r.SEARCHVAL || r.BUILDING || r.ADDRESS,
      addr: r.ADDRESS || "",
      lat: +r.LATITUDE, lng: +r.LONGITUDE,
      src: "onemap",
    }))
    .filter(r => r.name && !isNaN(r.lat) && !isNaN(r.lng));
}

async function fetchOsmSuggestions(q) {
  // OSM/Nominatim carries named POIs (shops, studios, gyms, ...) that OneMap's
  // official address index generally doesn't index.
  const url = `${NOMINATIM_SEARCH}?format=jsonv2&q=${encodeURIComponent(q)}` +
    `&countrycodes=sg&addressdetails=1&limit=6&viewbox=${SG_VIEWBOX}&bounded=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  return (data || [])
    .map(r => ({
      name: r.name || (r.display_name || "").split(",")[0],
      addr: r.display_name || "",
      lat: +r.lat, lng: +r.lon,
      src: "osm",
    }))
    .filter(r => r.name && !isNaN(r.lat) && !isNaN(r.lng));
}

// Merge OneMap + OSM results, deduping anything within ~60m of an
// already-picked hit (OneMap wins the dedupe since its addresses read cleaner).
function mergeSuggestions(primary, extra) {
  const out = [...primary];
  for (const cand of extra) {
    const dup = out.some(o => haversine(o.lat, o.lng, cand.lat, cand.lng) < 60);
    if (!dup) out.push(cand);
  }
  return out.slice(0, 8);
}

async function suggest(q) {
  try {
    const [oneMap, osm] = await Promise.all([
      fetchOneMapSuggestions(q).catch(() => []),
      fetchOsmSuggestions(q).catch(() => []),
    ]);
    const results = mergeSuggestions(oneMap, osm);
    const box = $("suggestions");
    box.innerHTML = "";
    if (!results.length) { hideSuggestions(); return; }
    for (const r of results) {
      const div = document.createElement("div");
      div.innerHTML = `${esc(r.name)}<span class="addr">${esc(r.addr)}${r.src === "osm" ? ' <span class="src-tag">OSM</span>' : ""}</span>`;
      div.addEventListener("click", () => {
        setDestination(r.lat, r.lng, r.name);
        $("search").value = r.name;
        hideSuggestions();
      });
      box.appendChild(div);
    }
    box.classList.remove("hidden");
  } catch { hideSuggestions(); }
}
const hideSuggestions = () => $("suggestions").classList.add("hidden");

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Geolocation not supported by this browser.");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("search").value = "My location";
      setDestination(pos.coords.latitude, pos.coords.longitude, "My location");
    },
    () => alert("Could not get your location — check location permissions."),
  );
});

// ---------------------------------------------------------------- core
function setDestination(lat, lng, name) {
  state.dest = { lat, lng, name };
  $("controls").classList.remove("hidden");
  $("placeholder").classList.add("hidden");
  $("mobileToggle").classList.remove("hidden");
  document.body.classList.add("show-list");
  if (destMarker) destMarker.remove();
  destMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "dest-pin", html: "📍", iconSize: [28, 28], iconAnchor: [14, 26] }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`<b>${esc(name)}</b>`);
  render();
}

function selectedWhen() {
  const v = $("when").value;
  const d = v ? new Date(v) : new Date();
  return isNaN(d) ? new Date() : d;
}

function candidates() {
  const { dest } = state;
  const radius = +$("radius").value;
  const shelteredOnly = $("sheltered").getAttribute("aria-pressed") === "true";
  const mustHaveLots = $("hasLots").getAttribute("aria-pressed") === "true";
  const when = selectedWhen();
  const durMin = +$("duration").value;

  const destKey = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  let rows = state.carparks
    .map(cp => {
      const dist = haversine(dest.lat, dest.lng, cp.lat, cp.lng);
      if (dist > radius) return null;
      const rt = state.walkCache.get(`${destKey}|${cp.id}`);
      return {
        cp, dist, av: getAvail(cp), cost: estimateCost(cp.rates, when, durMin),
        walkM: rt ? rt.dist : dist * ROUTE_FACTOR,
        walkMin: rt ? Math.max(1, Math.round(rt.secs / 60)) : walkMins(dist),
        routed: !!rt,
      };
    })
    .filter(Boolean)
    .filter(r => !shelteredOnly || r.cp.sheltered)
    .filter(r => !mustHaveLots || (r.av && r.av.lots > 0));

  const price = (r) => r.cost ?? Infinity;
  if (state.sort === "walk") rows.sort((a, b) => a.walkM - b.walkM);
  else if (state.sort === "price") rows.sort((a, b) => price(a) - price(b) || a.walkM - b.walkM);
  else if (state.sort === "avail") rows.sort((a, b) => (b.av?.lots ?? -1) - (a.av?.lots ?? -1) || a.walkM - b.walkM);
  return rows.slice(0, MAX_RESULTS);
}

async function fetchWalkRoutes(rows) {
  // Fill walkCache with real OSM pedestrian network distances for unrouted rows.
  const { dest } = state;
  const destKey = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  const todo = rows.filter(r => !r.routed);
  if (!todo.length || state.routingFor === destKey) return;
  state.routingFor = destKey;
  try {
    const coords = [`${dest.lng},${dest.lat}`,
      ...todo.map(r => `${r.cp.lng},${r.cp.lat}`)].join(";");
    const res = await fetch(`${OSRM_TABLE}${coords}?sources=0&annotations=duration,distance`);
    const data = await res.json();
    if (data.code !== "Ok") return;
    todo.forEach((r, i) => {
      const secs = data.durations?.[0]?.[i + 1];
      const dist = data.distances?.[0]?.[i + 1];
      if (secs != null && dist != null)
        state.walkCache.set(`${destKey}|${r.cp.id}`, { dist, secs });
    });
    if (state.dest && `${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)}` === destKey)
      render();
  } catch { /* keep straight-line estimates */ }
  finally { state.routingFor = null; }
}

function lotsBadge(av) {
  if (!av || isNaN(av.lots)) return "";
  const cls = av.lots === 0 ? "lots-none" : av.lots < 20 ? "lots-low" : "lots-ok";
  return `<span class="badge ${cls}">🚗 ${av.lots} lots</span>`;
}

function priceBox(cost, durMin) {
  if (cost == null) return `<div class="price na">—</div><div class="price-sub">see rate details</div>`;
  const label = cost === 0 ? "Free" : `$${cost.toFixed(2)}`;
  return `<div class="price">${label}</div><div class="price-sub">est · ${fmtDur(durMin)}</div>`;
}

function closeNavMenus() {
  document.querySelectorAll(".nav-options").forEach(el => el.classList.add("hidden"));
}

function render() {
  if (!state.dest) return;
  const rows = candidates();
  const durMin = +$("duration").value;
  const list = $("list");
  list.innerHTML = `<div class="count"><b>${rows.length}</b> carpark${rows.length === 1 ? "" : "s"} within ${fmtDist(+$("radius").value)} of <b>${esc(state.dest.name)}</b></div>`;
  markerLayer.clearLayers();

  const bounds = [[state.dest.lat, state.dest.lng]];
  fetchWalkRoutes(rows);
  rows.forEach((r, i) => {
    const { cp, av, cost } = r;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = cp.id;
    card.innerHTML = `
      <div class="card-top">
        <span class="rank">${i + 1}</span>
        <div class="card-main">
          <h3>${esc(cp.name)}</h3>
          <p class="addr">${esc(cp.addr)}${cp.type ? " · " + esc(cp.type) : ""}</p>
        </div>
        <div class="price-box">${priceBox(cost, durMin)}</div>
      </div>
      <div class="badges">
        <span class="badge walk" title="${r.routed ? "Walking route via OpenStreetMap" : "Straight-line estimate"}">🚶 ${r.routed ? "" : "~"}${r.walkMin} min · ${fmtDist(r.walkM)}</span>
        ${cp.sheltered ? '<span class="badge shelter">☂️ Sheltered</span>' : ""}
        ${lotsBadge(av)}
        ${cp.gantry ? `<span class="badge">↕ ${cp.gantry.toFixed(2)} m</span>` : ""}
      </div>
      <details class="rates-details">
        <summary>Rate details</summary>
        <p class="rates">
          <b>Weekday:</b> ${esc(cp.rateWd) || "–"}
          ${cp.rateSat ? `<br><b>Sat:</b> ${esc(cp.rateSat)}` : ""}
          ${cp.rateSun ? `<br><b>Sun/PH:</b> ${esc(cp.rateSun)}` : ""}
          ${cp.freeParking ? `<br><b>Free:</b> ${esc(cp.freeParking)}` : ""}
          ${cp.nightParking ? "<br><b>Night parking:</b> Yes" : ""}
          ${cp.remarks ? `<br>${esc(cp.remarks)}` : ""}
        </p>
      </details>
      <div class="card-actions">
        <div class="nav-menu">
          <div class="nav-options hidden">
            <a href="https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lng}&travelmode=driving"
               target="_blank" rel="noopener"><span class="nav-ico g">G</span>Google Maps</a>
            <a href="https://www.waze.com/ul?ll=${cp.lat}%2C${cp.lng}&navigate=yes"
               target="_blank" rel="noopener"><span class="nav-ico w">W</span>Waze</a>
          </div>
          <button class="nav-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2 19 21l-7-4-7 4L12 2z"/></svg>
            Navigate
          </button>
        </div>
      </div>`;

    card.querySelector(".nav-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const opts = card.querySelector(".nav-options");
      const wasHidden = opts.classList.contains("hidden");
      closeNavMenus();
      if (wasHidden) opts.classList.remove("hidden");
    });
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, .nav-menu, details")) return;
      focusCarpark(cp.id, true);
    });
    list.appendChild(card);

    const full = av && av.lots === 0;
    const m = L.marker([cp.lat, cp.lng], {
      icon: L.divIcon({
        className: `cp-pin${full ? " full" : ""}`,
        html: `${i + 1}`, iconSize: [24, 24], iconAnchor: [12, 12],
      }),
    }).addTo(markerLayer)
      .bindTooltip(`${cp.name}${cost != null ? ` · $${cost.toFixed(2)}` : ""}`)
      .on("click", () => focusCarpark(cp.id, false));
    m._cpId = cp.id;
    bounds.push([cp.lat, cp.lng]);
  });

  if (bounds.length > 1) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
  else map.setView([state.dest.lat, state.dest.lng], 16);
}

function focusCarpark(id, fromCard) {
  state.activeId = id;
  document.querySelectorAll(".card").forEach(c =>
    c.classList.toggle("active", c.dataset.id === id));
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card && !fromCard) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  markerLayer.eachLayer(l => {
    if (l._cpId === id) {
      map.panTo(l.getLatLng());
      l.openTooltip();
    }
  });
}

// ---------------------------------------------------------------- wiring
for (const id of ["when", "duration", "radius"])
  $(id).addEventListener("change", render);

for (const btn of document.querySelectorAll(".segmented button"))
  btn.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach(b => b.classList.toggle("on", b === btn));
    state.sort = btn.dataset.sort;
    render();
  });

for (const id of ["sheltered", "hasLots"])
  $(id).addEventListener("click", () => {
    const el = $(id);
    el.setAttribute("aria-pressed", el.getAttribute("aria-pressed") !== "true");
    render();
  });

// mobile-only list/map full-height toggle (see .mobile-toggle in style.css)
for (const btn of document.querySelectorAll(".mobile-toggle button"))
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mobile-toggle button").forEach(b => {
      b.classList.toggle("on", b === btn);
      b.setAttribute("aria-selected", b === btn ? "true" : "false");
    });
    const showMap = btn.dataset.view === "map";
    document.body.classList.toggle("show-map", showMap);
    document.body.classList.toggle("show-list", !showMap);
    if (showMap) setTimeout(() => map.invalidateSize(), 50);
  });

function initWhen() {
  // default: now, rounded up to the next 5 minutes, in local time
  const d = new Date(Date.now() + 4 * 60000);
  d.setMinutes(d.getMinutes() + (5 - d.getMinutes() % 5) % 5, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("when").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

(async function init() {
  initWhen();
  await Promise.all([loadCarparks(), loadAvailability()]);
  await loadLtaAvailability(); // needs carparks loaded for proximity matching
  setInterval(loadAvailability, 60_000);
  setInterval(loadLtaAvailability, 120_000);
  // re-render on availability refresh if a destination is active
  setInterval(() => { if (state.dest) render(); }, 60_000);
})();
