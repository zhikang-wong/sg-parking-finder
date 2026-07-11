# SG Parking Finder

Find the nearest, cheapest, or sheltered carpark near any destination in Singapore,
with live HDB lot availability and one-tap navigation via Google Maps or Waze.

## Features

- **Destination search** — OneMap (SLA) address/POI autocomplete, or use your current location
- **Ranked results** — sort by shortest walk, lowest estimated price (2-hr park), or most lots available
- **Filters** — sheltered-only, has-lots-now, search radius (500 m – 2 km)
- **Live availability** — HDB lot counts from data.gov.sg, refreshed every minute
- **Navigation deeplinks** — Google Maps and Waze buttons on every carpark

## Data sources

| Source | What | Count |
|---|---|---|
| sgcarmart carpark API (scraped) | Malls / offices / hotels with rate text + coordinates | ~1,147 |
| HDB Carpark Information (data.gov.sg CSV) | HDB carparks: SVY21 coords, type, night/free parking | ~1,900 short-term |
| data.gov.sg carpark-availability API | Live HDB lot counts (no API key needed) | live |
| OneMap search API | Destination geocoding (client-side) | live |

Prices shown are **estimates for a 2-hour weekday daytime park**, parsed from free-text
rate descriptions — always check the displayed rate text. HDB carparks use the standard
$0.60/30 min rate ($1.20/30 min for the 16 central-area carparks).

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

`build_data.py` reads `HDBCarparkInformation.csv` from `~/Desktop/CarParkAvailability/`.

## Notes / possible upgrades

- LTA DataMall's CarParkAvailability v2 also has live lots for malls (Suntec, Plaza Sing, …)
  but needs a free AccountKey — could be added as an optional backend proxy.
- "Sheltered" is exact for HDB (multi-storey/basement vs surface); for commercial carparks
  it's assumed true unless the name suggests an open-air/off-street lot.
