# SG Parking Finder

Find the nearest, cheapest, or sheltered carpark near any destination in Singapore,
with live HDB lot availability and one-tap navigation via Google Maps or Waze.

## Features

- **Destination search** — OneMap (SLA) + OpenStreetMap autocomplete, or use your current location
- **Ranked results** — sort by shortest walk, lowest estimated price (2-hr park), or most lots available
- **Filters** — sheltered-only, has-lots-now, search radius (500 m – 2 km)
- **Live availability** — HDB lot counts from data.gov.sg, refreshed every minute
- **Navigation deeplinks** — Google Maps and Waze buttons on every carpark
- **Mobile layout** — the whole page scrolls (header and map scroll away with the
  list), with a List/Map toggle for a full-screen map. Desktop keeps the
  side-by-side map + scrolling results pane.

## Data sources

| Source | What | Count |
|---|---|---|
| sgcarmart carpark API (scraped) | Malls / offices / hotels with rate text + coordinates | ~1,147 |
| HDB Carpark Information (data.gov.sg CSV) | HDB carparks: SVY21 coords, type, night/free parking | ~1,900 short-term |
| data.gov.sg carpark-availability API | Live HDB lot counts (no API key needed) | live |
| LTA DataMall CarParkAvailabilityv2 | Live mall/URA lot counts, via scheduled GitHub Action | live, 5-min refresh |
| OneMap search API | Destination geocoding: SG addresses/buildings (client-side) | live |
| OSM Nominatim search API | Destination geocoding: POIs/businesses not in OneMap's address index (client-side) | live |
| OSRM foot routing (routing.openstreetmap.de) | Real walking distance/time over the OSM pedestrian network | live |

Destination search: every keystroke (3+ chars) queries OneMap and Nominatim in
parallel and merges the results, deduping anything within 60 m. OneMap's index is
official SG addresses/buildings, so a query like a street or building name resolves
there; Nominatim carries OSM POI tags (shops, studios, gyms, ...) that OneMap doesn't
index, so a named business shows up via OSM instead — labelled with an "OSM" tag in
the suggestion list. Nominatim's public instance is rate-limited (≈1 req/s) and asks
for identifying traffic; fine for personal use, but swap in a self-hosted instance or
Photon before sharing this with many concurrent users.

Mall availability: DataMall blocks browser calls (no CORS) and needs an AccountKey, so
`.github/workflows/availability.yml` fetches it every 5 minutes (key in the `DATAMALL_KEY`
repo secret — never committed) and force-pushes `availability.json` to the `availability`
branch, which the app reads via raw.githubusercontent.com and matches to carparks by
proximity (≤150 m).

Rate text is parsed (`scripts/rates.py`) into structured time segments — first-hour,
per-interval, per-entry and free rules with day/evening windows for weekday / Sat / Sun —
and the app walks your selected arrival time + duration through those segments to
estimate the total cost. Public holidays are treated as regular days; always check the
displayed rate text. HDB carparks use the standard $0.60/30 min rate ($1.20/30 min
weekday daytime for the 16 central-area carparks; free Sun 7am–10.30pm where offered).

## Run it

```bash
cd docs
python3 -m http.server 8080
# open http://localhost:8080
```

(Any static file server works; `fetch()` needs http://, not file://.)

## Refresh the data

```bash
python3 scripts/scrape_sgcarmart.py   # re-scrape sgcarmart rates (resumable, ~6 min)
python3 scripts/build_data.py         # rebuild docs/carparks.json
```

`build_data.py` reads `data/HDBCarparkInformation.csv` (source: data.gov.sg, HDB carpark
information). `data/sg_poi.csv` is a Singapore points-of-interest dataset kept alongside
the carpark data for potential future use (e.g. destination suggestions) — not currently
consumed by the app.

## Notes

- "Sheltered" is exact for HDB (multi-storey/basement vs surface); for commercial carparks
  it's assumed true unless the name suggests an open-air/off-street lot.
