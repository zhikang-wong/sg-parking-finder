#!/usr/bin/env python3
"""Fetch live carpark availability from LTA DataMall.

Emits availability.json with LTA- and URA-managed carparks (malls, commercial,
URA public lots). HDB lots are not included — the web app already gets those
directly from api.data.gov.sg, which needs no key.

Usage: DATAMALL_KEY=<AccountKey> python3 fetch_datamall.py [out.json]
"""
import json
import os
import sys
import time
import urllib.request

API = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2"


def main():
    key = os.environ.get("DATAMALL_KEY")
    if not key:
        sys.exit("DATAMALL_KEY env var not set")
    out_path = sys.argv[1] if len(sys.argv) > 1 else "availability.json"

    records, skip = [], 0
    while True:
        req = urllib.request.Request(f"{API}?$skip={skip}",
                                     headers={"AccountKey": key, "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            batch = json.load(resp)["value"]
        records.extend(batch)
        if len(batch) < 500:
            break
        skip += 500

    out = []
    for r in records:
        if r.get("Agency") == "HDB" or r.get("LotType") != "C":
            continue
        try:
            lat, lng = map(float, r["Location"].split())
        except (ValueError, KeyError):
            continue
        if lat == 0 and lng == 0:
            continue
        out.append({
            "dev": r.get("Development", "").strip(),
            "lat": round(lat, 6), "lng": round(lng, 6),
            "lots": int(r.get("AvailableLots", 0)),
            "agency": r.get("Agency"),
        })

    payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime(time.time() + 8 * 3600)),
               "carparks": out}
    json.dump(payload, open(out_path, "w"), separators=(",", ":"))
    print(f"{len(records)} records -> {len(out)} LTA/URA car lots -> {out_path}")


if __name__ == "__main__":
    main()
