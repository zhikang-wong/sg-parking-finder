#!/usr/bin/env python3
"""Merge sgcarmart + HDB carpark data into docs/carparks.json.

Sources:
  data/sgcarmart_details.json  - scraped commercial carpark rates (lat/lng included)
  data/HDBCarparkInformation.csv - HDB carparks, SVY21 coords, type, night/free parking
"""
import csv
import json
import math
import os
import re

from rates import parse_carpark_rates

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HDB_CSV = os.path.join(ROOT, "data", "HDBCarparkInformation.csv")
DETAILS = os.path.join(ROOT, "data", "sgcarmart_details.json")
OUT = os.path.join(ROOT, "docs", "carparks.json")

# ---------------------------------------------------------------- SVY21 -> WGS84
A = 6378137.0
F = 1 / 298.257223563
O_LAT, O_LON = 1.366666, 103.833333   # origin, degrees
O_N, O_E, K = 38744.572, 28001.642, 1.0

B = A * (1 - F)
E2 = 2 * F - F * F
E4, E6 = E2 * E2, E2 * E2 * E2
A0 = 1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256
A2 = (3 / 8) * (E2 + E4 / 4 + 15 * E6 / 128)
A4 = (15 / 256) * (E4 + 3 * E6 / 4)
A6 = 35 * E6 / 3072


def calc_m(lat_deg):
    lat = math.radians(lat_deg)
    return A * (A0 * lat - A2 * math.sin(2 * lat) + A4 * math.sin(4 * lat)
                - A6 * math.sin(6 * lat))


def svy21_to_latlon(n, e):
    m_prime = calc_m(O_LAT) + (n - O_N) / K
    nr = (A - B) / (A + B)
    n2, n3, n4 = nr * nr, nr ** 3, nr ** 4
    g = A * (1 - nr) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64) * (math.pi / 180)
    sigma = m_prime * math.pi / (180 * g)
    lat_p = (sigma
             + ((3 * nr / 2) - (27 * n3 / 32)) * math.sin(2 * sigma)
             + ((21 * n2 / 16) - (55 * n4 / 32)) * math.sin(4 * sigma)
             + (151 * n3 / 96) * math.sin(6 * sigma)
             + (1097 * n4 / 512) * math.sin(8 * sigma))

    sin2 = math.sin(lat_p) ** 2
    rho = A * (1 - E2) / (1 - E2 * sin2) ** 1.5
    v = A / (1 - E2 * sin2) ** 0.5
    psi = v / rho
    t = math.tan(lat_p)
    ep = e - O_E
    x = ep / (K * v)
    lf = t / (K * rho)

    lat = (lat_p
           - lf * (ep * x / 2)
           + lf * (ep * x ** 3 / 24) * (-4 * psi ** 2 + 9 * psi * (1 - t * t) + 12 * t * t)
           - lf * (ep * x ** 5 / 720) * (8 * psi ** 4 * (11 - 24 * t * t)
                                         - 12 * psi ** 3 * (21 - 71 * t * t)
                                         + 15 * psi ** 2 * (15 - 98 * t * t + 15 * t ** 4)
                                         + 180 * psi * (5 * t * t - 3 * t ** 4) + 360 * t ** 4)
           + lf * (ep * x ** 7 / 40320) * (1385 - 3633 * t * t + 4095 * t ** 4 + 1575 * t ** 6))

    sec = 1 / math.cos(lat_p)
    lon = (math.radians(O_LON)
           + x * sec
           - (x ** 3 * sec / 6) * (psi + 2 * t * t)
           + (x ** 5 * sec / 120) * (-4 * psi ** 3 * (1 - 6 * t * t)
                                     + psi ** 2 * (9 - 68 * t * t) + 72 * psi * t * t + 24 * t ** 4)
           - (x ** 7 * sec / 5040) * (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6))
    return round(math.degrees(lat), 6), round(math.degrees(lon), 6)


# ---------------------------------------------------------------- rate parsing
def parse_rate(text):
    """Estimate cost in $ for a 1-hour and 2-hour daytime park from rate text.

    Returns (price_1h, price_2h) or (None, None) when unparseable.
    """
    if not text:
        return None, None
    s = text.lower().replace("½", "1/2").replace(" ", " ")
    s = re.sub(r"\s+", " ", s)

    if "$" not in s:
        if "hdb" in s or "ura" in s:      # "HDB / URA parking rates"
            return 1.20, 2.40
        if "free" in s or "gratis" in s:
            return 0.0, 0.0
        return None, None

    # "Free for 1st hr, $Y for next subsequent hr/30min"
    m = re.search(r"free for (?:the )?(?:1st|first) (?:hour|hr)", s)
    if m:
        sub = re.search(r"\$(\d+(?:\.\d+)?)[^$]*?(?:(\d+) ?min|1\/2 ?(?:hr|hour)|(?:hr|hour))", s[m.end():])
        if sub:
            interval = int(sub.group(2)) if sub.group(2) else (30 if "1/2" in sub.group(0) else 60)
            return 0.0, round(float(sub.group(1)) * (60 / interval), 2)
        return 0.0, 0.0

    # "$X for 1st 2hr" (+ optionally "$Y for next subsequent 30min/hr")
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:for|:)?\s*(?:the )?(?:1st|first) ?2 ?(?:hours|hrs|hr)", s)
    if m:
        p2 = float(m.group(1))
        return p2, p2

    # "$X for 1st hr" or "1st hr: $X" (+ optionally "$Y per sub 30 min / 1/2 hr / ...")
    m = (re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|for|:)?\s*(?:the )?(?:1st|first) (?:hour|hr)", s)
         or re.search(r"(?:1st|first) ?(?:hour|hr)\s*[:\-]\s*\$(\d+(?:\.\d+)?)", s))
    if m:
        p1 = float(m.group(1))
        rest = s[m.end():]
        sub = re.search(
            r"\$(\d+(?:\.\d+)?)(?:\s*(?:for|per|\/|every)?\s*"
            r"(?:each |every |next |all )?(?:sub\.?s?e?q?u?e?n?t? ?|additional )?"
            r"(?:(\d+) ?min|1\/2 ?(?:hr|hour)|half (?:an )?(?:hr|hour)|(?:hr|hour)))", rest)
        if sub:
            per = float(sub.group(1))
            if sub.group(2):                     # "$Y ... 30 mins" style
                interval = int(sub.group(2))
            elif re.search(r"1\/2 ?(?:hr|hour)|half", sub.group(0)):
                interval = 30
            else:
                interval = 60
            return p1, round(p1 + per * (60 / interval), 2)
        return p1, p1 * 2  # assume same for 2nd hour

    # "$X per entry"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*entry", s)
    if m:
        p = float(m.group(1))
        return p, p

    # "$X per/for/each N min(s)"  e.g. "$1.30 / 30 mins", "$0.32 for 15 min"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for|every)?\s*(?:every |each )?(\d+) ?min", s)
    if m:
        p, interval = float(m.group(1)), int(m.group(2))
        return round(p * 60 / interval, 2), round(p * 120 / interval, 2)

    # "$X per 1/2 hr"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for)?\s*(?:1\/2 ?(?:hr|hour)|half (?:an )?(?:hr|hour))", s)
    if m:
        p = float(m.group(1))
        return p * 2, p * 4

    # "$X per hr"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for)?\s*(?:1 )?(?:hr|hour)", s)
    if m:
        p = float(m.group(1))
        return p, p * 2

    # "$X /min"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*\/? ?min", s)
    if m:
        p = float(m.group(1))
        return round(p * 60, 2), round(p * 120, 2)

    return None, None


# HDB carparks inside the CBD restricted zone charge $1.20/30min on weekdays 7am-5pm
HDB_CENTRAL = {"ACB", "BBB", "BRB1", "CY", "DUXM", "HLM", "KAB", "KAM", "KAS",
               "PRM", "SLS", "SR1", "SR2", "TPM", "UCS", "WCB"}

SURFACE_HINTS = re.compile(r"off[- ]?street|open[- ]air|open car ?park|surface", re.I)

# carparks the public can't actually use
UNUSABLE = re.compile(r"carpark (?:is )?closed|not in use|season parking only|"
                      r"private car ?park|not for public", re.I)


def main():
    out = []

    # ---- sgcarmart commercial carparks
    details = json.load(open(DETAILS))
    n_rates = 0
    for cid, d in details.items():
        if not d or d.get("latitude") is None:
            continue
        wd1, wd2 = (d.get("wd1") or "").strip(), (d.get("wd2") or "").strip()
        sat, sun = (d.get("sat") or "").strip(), (d.get("sun") or "").strip()
        if UNUSABLE.search(wd1) or UNUSABLE.search(d.get("remarks") or ""):
            continue
        rates = parse_carpark_rates(wd1, wd2, sat, sun)
        if rates:
            n_rates += 1
        name = (d.get("name") or "").strip()
        out.append({
            "id": f"sgcm_{cid}",
            "src": "sgcarmart",
            "name": name,
            "addr": (d.get("address") or "").strip(),
            "lat": d["latitude"], "lng": d["longitude"],
            "sheltered": not SURFACE_HINTS.search(name + " " + wd1),
            "rates": rates,
            "rateWd": wd1 + (" | " + wd2 if wd2 and wd2 not in ("-", wd1) else ""),
            "rateSat": sat if sat not in ("-", "") else None,
            "rateSun": sun if sun not in ("-", "") else None,
            "remarks": (d.get("remarks") or "").strip() or None,
        })
    print(f"sgcarmart: {len(details)} details, {n_rates} with parsed rates")

    # ---- HDB carparks
    n_hdb = 0
    with open(HDB_CSV, newline="") as f:
        for row in csv.DictReader(f):
            lat, lng = svy21_to_latlon(float(row["y_coord"]), float(row["x_coord"]))
            cp_type = row["car_park_type"].strip()
            central = row["car_park_no"] in HDB_CENTRAL
            half_hr = 1.20 if central else 0.60
            short = row["short_term_parking"].strip()
            if short == "NO":
                continue  # season-parking only, not useful for visitors
            rate_txt = (f"${half_hr:.2f} per 30 min"
                        + (" (7am-5pm, central area)" if central else "")
                        + f"; short-term parking: {short.title()}")
            base = ["p", 0, 1440, 0.60, 30]
            wd_segs = ([["p", 0, 420, 0.60, 30], ["p", 420, 1020, 1.20, 30],
                        ["p", 1020, 1440, 0.60, 30]] if central else [base])
            free_sun = row["free_parking"] != "NO"
            sun_segs = ([["p", 0, 420, 0.60, 30], ["z", 420, 1350],
                         ["p", 1350, 1440, 0.60, 30]] if free_sun else [base])
            rates = {"w": wd_segs, "a": [base], "u": sun_segs}
            out.append({
                "id": f"hdb_{row['car_park_no']}",
                "src": "hdb",
                "hdbNo": row["car_park_no"],
                "name": row["address"].title(),
                "addr": row["address"].title(),
                "lat": lat, "lng": lng,
                "sheltered": any(k in cp_type for k in ("MULTI-STOREY", "BASEMENT", "COVERED", "MECHANISED")),
                "type": cp_type.title(),
                "rates": rates,
                "rateWd": rate_txt,
                "rateSat": None, "rateSun": None,
                "freeParking": None if row["free_parking"] == "NO" else row["free_parking"].title(),
                "nightParking": row["night_parking"] == "YES",
                "gantry": float(row["gantry_height"]) or None,
            })
            n_hdb += 1
    print(f"hdb: {n_hdb} short-term carparks")

    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"total {len(out)} carparks -> {OUT} ({os.path.getsize(OUT)//1024} KB)")


if __name__ == "__main__":
    main()
