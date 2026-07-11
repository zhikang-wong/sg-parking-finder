#!/usr/bin/env python3
"""Scrape carpark rate details from sgcarmart's carpark API.

Reads data/sgcarmart_list.json (the 1,147 carparks embedded in
https://www.sgcarmart.com/carpark) and fetches each carpark's detail
record, which includes address and rate text for weekday/Sat/Sun.
Resumable: already-fetched ids are skipped on re-run.
"""
import json
import os
import sys
import time
import urllib.request

BASE = "https://www.sgcarmart.com/api/carpark/fetch-carpark-detail-data?id={}"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIST_PATH = os.path.join(ROOT, "data", "sgcarmart_list.json")
OUT_PATH = os.path.join(ROOT, "data", "sgcarmart_details.json")
DELAY = 0.25  # seconds between requests


def fetch(carpark_id):
    req = urllib.request.Request(BASE.format(carpark_id), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    return payload["data"]["data"]


def main():
    carparks = json.load(open(LIST_PATH))
    details = {}
    if os.path.exists(OUT_PATH):
        details = json.load(open(OUT_PATH))

    todo = [c for c in carparks if str(c["id"]) not in details]
    print(f"{len(carparks)} total, {len(details)} done, {len(todo)} to fetch", flush=True)

    errors = 0
    for i, cp in enumerate(todo):
        cid = str(cp["id"])
        try:
            details[cid] = fetch(cp["id"])
        except Exception as e:
            errors += 1
            print(f"  error id={cid} ({cp.get('name')}): {e}", flush=True)
            if errors > 30:
                print("too many errors, aborting", flush=True)
                break
        if (i + 1) % 50 == 0:
            json.dump(details, open(OUT_PATH, "w"))
            print(f"  {i + 1}/{len(todo)} fetched", flush=True)
        time.sleep(DELAY)

    json.dump(details, open(OUT_PATH, "w"))
    print(f"done: {len(details)} details saved, {errors} errors", flush=True)


if __name__ == "__main__":
    sys.exit(main())
