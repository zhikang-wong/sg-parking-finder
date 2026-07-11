/* SG Parking Finder */

const ONEMAP_SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search";
const AVAIL_API = "https://api.data.gov.sg/v1/transport/carpark-availability";
const WALK_SPEED = 80;      // metres per minute
const ROUTE_FACTOR = 1.25;  // straight-line -> street distance fudge
const MAX_RESULTS = 40;

const state = {
  carparks: [],
  avail: {},          // hdb carpark_no -> {lots, total}
  dest: null,         // {lat, lng, name}
  activeId: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true }).setView([1.3521, 103.8198], 12);
L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:16px;vertical-align:middle"> ' +
    '&copy; <a href="https://www.onemap.gov.sg/">OneMap</a> &copy; Singapore Land Authority',
}).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let destMarker = null;
new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById("map"));

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

// ---------------------------------------------------------------- search
let debounceTimer = null;
$("search").addEventListener("input", (e) => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  debounceTimer = setTimeout(() => suggest(q), 280);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) hideSuggestions();
});

async function suggest(q) {
  try {
    const url = `${ONEMAP_SEARCH}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const res = await fetch(url);
    const data = await res.json();
    const box = $("suggestions");
    box.innerHTML = "";
    const results = (data.results || []).slice(0, 8);
    if (!results.length) { hideSuggestions(); return; }
    for (const r of results) {
      const div = document.createElement("div");
      const name = r.SEARCHVAL || r.BUILDING || r.ADDRESS;
      div.innerHTML = `${esc(name)}<span class="addr">${esc(r.ADDRESS)}</span>`;
      div.addEventListener("click", () => {
        setDestination(+r.LATITUDE, +r.LONGITUDE, name);
        $("search").value = name;
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
  if (destMarker) destMarker.remove();
  destMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "dest-pin", html: "🎯", iconSize: [26, 26], iconAnchor: [13, 13] }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`<b>${esc(name)}</b>`);
  render();
}

function candidates() {
  const { dest } = state;
  const radius = +$("radius").value;
  const shelteredOnly = $("sheltered").checked;
  const mustHaveLots = $("hasLots").checked;
  const sort = $("sort").value;

  let rows = state.carparks
    .map(cp => {
      const dist = haversine(dest.lat, dest.lng, cp.lat, cp.lng);
      const av = cp.hdbNo ? state.avail[cp.hdbNo] : undefined;
      return { cp, dist, av };
    })
    .filter(r => r.dist <= radius)
    .filter(r => !shelteredOnly || r.cp.sheltered)
    .filter(r => !mustHaveLots || (r.av && r.av.lots > 0));

  const price = (r) => r.cp.p2 ?? Infinity;
  if (sort === "walk") rows.sort((a, b) => a.dist - b.dist);
  else if (sort === "price") rows.sort((a, b) => price(a) - price(b) || a.dist - b.dist);
  else if (sort === "avail") rows.sort((a, b) => (b.av?.lots ?? -1) - (a.av?.lots ?? -1) || a.dist - b.dist);
  return rows.slice(0, MAX_RESULTS);
}

function lotsBadge(av) {
  if (!av || isNaN(av.lots)) return "";
  const cls = av.lots === 0 ? "lots-none" : av.lots < 20 ? "lots-low" : "lots-ok";
  return `<span class="badge ${cls}">🚗 ${av.lots} lots free</span>`;
}

function render() {
  if (!state.dest) return;
  const rows = candidates();
  const list = $("list");
  list.innerHTML = `<div class="count">${rows.length} carpark${rows.length === 1 ? "" : "s"} within ${fmtDist(+$("radius").value)} of <b>${esc(state.dest.name)}</b></div>`;
  markerLayer.clearLayers();

  const bounds = [[state.dest.lat, state.dest.lng]];
  rows.forEach((r, i) => {
    const { cp, dist, av } = r;
    const priceBadge = cp.p2 != null
      ? `<span class="badge price">~$${cp.p2.toFixed(2)} / 2 hrs</span>`
      : `<span class="badge">rates: see below</span>`;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = cp.id;
    card.innerHTML = `
      <h3>${i + 1}. ${esc(cp.name)}</h3>
      <p class="addr">${esc(cp.addr)}${cp.type ? " · " + esc(cp.type) : ""}</p>
      <div class="badges">
        <span class="badge walk">🚶 ${walkMins(dist)} min (${fmtDist(dist)})</span>
        ${priceBadge}
        ${cp.sheltered ? '<span class="badge shelter">☂️ Sheltered</span>' : ""}
        ${lotsBadge(av)}
        ${cp.gantry ? `<span class="badge">↕ ${cp.gantry.toFixed(2)} m</span>` : ""}
      </div>
      <p class="rates">
        <b>Weekday:</b> ${esc(cp.rateWd) || "–"}
        ${cp.rateSat ? `<br><b>Sat:</b> ${esc(cp.rateSat)}` : ""}
        ${cp.rateSun ? `<br><b>Sun/PH:</b> ${esc(cp.rateSun)}` : ""}
        ${cp.freeParking ? `<br><b>Free:</b> ${esc(cp.freeParking)}` : ""}
        ${cp.nightParking ? "<br><b>Night parking:</b> Yes" : ""}
        ${cp.remarks ? `<br>${esc(cp.remarks)}` : ""}
      </p>
      <div class="nav-btns">
        <a class="gmaps" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${cp.lat},${cp.lng}&travelmode=driving">Google Maps</a>
        <a class="waze" target="_blank" rel="noopener"
           href="https://www.waze.com/ul?ll=${cp.lat}%2C${cp.lng}&navigate=yes">Waze</a>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      focusCarpark(cp.id, true);
    });
    list.appendChild(card);

    const m = L.circleMarker([cp.lat, cp.lng], {
      radius: 8, weight: 2, color: "#0b6e4f",
      fillColor: av && av.lots === 0 ? "#b91c1c" : "#0b6e4f", fillOpacity: .75,
    }).addTo(markerLayer)
      .bindTooltip(`${i + 1}. ${cp.name}`)
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
for (const id of ["sort", "radius", "sheltered", "hasLots"])
  $(id).addEventListener("change", render);

(async function init() {
  await Promise.all([loadCarparks(), loadAvailability()]);
  setInterval(loadAvailability, 60_000).unref?.();
  // re-render on availability refresh if a destination is active
  setInterval(() => { if (state.dest) render(); }, 60_000);
})();
