#!/usr/bin/env python3
# Daily BCV official exchange rates (USD, EUR) -> CouchDB. Stdlib only.
# Deployed on the VPS as /usr/local/bin/bcv-rates.py, run by the
# bcv-rates.timer systemd unit at 07:00 America/Caracas.
#
# Writes:
#   rate:{YYYY-MM-DD}   one doc per Caracas day (idempotent upsert; re-runs safe)
#   config:system       refreshes currentDailyRateBCV with the USD rate so the
#                       app starts each day on the official tasa
#
# Credentials come from /etc/bcv-rates.env (root:root 600) via the unit's
# EnvironmentFile: RATES_USER / RATES_PASS (CouchDB user with the app role)
# and APP_DB (database name, default crm).

import base64
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

CARACAS = timezone(timedelta(hours=-4))  # Venezuela has no DST
BCV_URL = "https://www.bcv.org.ve/"
COUCH = os.environ.get("COUCH_URL", "http://127.0.0.1:5984").rstrip("/")
DB = os.environ.get("APP_DB", "crm")
USER = os.environ["RATES_USER"]
PASS = os.environ["RATES_PASS"]
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()


def fetch_html() -> str:
    # BCV's TLS chain is chronically incomplete, so verification is off for this
    # public, read-only page. The data is sanity-checked below and the DB write
    # side is localhost — a spoofed page cannot do worse than a wrong rate,
    # which the jump guard rejects.
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(BCV_URL, headers={"User-Agent": "Mozilla/5.0 (bcv-rates)"})
    last_err = None
    for attempt in range(3):  # BCV flakes; 3 tries, 60 s apart, then fail loudly
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as err:  # noqa: BLE001 — any fetch failure is retryable
            last_err = err
            if attempt < 2:
                time.sleep(60)
    raise RuntimeError(f"BCV inaccesible tras 3 intentos: {last_err}")


def parse_rate(html: str, elem_id: str) -> float:
    m = re.search(r'id="%s".*?<strong[^>]*>\s*([\d.,]+)\s*</strong>' % elem_id, html, re.S)
    if not m:
        raise ValueError(f"no se encontró la tasa '{elem_id}' en el HTML del BCV")
    # BCV format: comma decimal ("723,99900000"), dot as (potential) thousands sep.
    return float(m.group(1).replace(".", "").replace(",", "."))


def couch(method: str, path: str, body: dict | None = None) -> dict | None:
    req = urllib.request.Request(
        COUCH + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Authorization": AUTH},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def main() -> None:
    html = fetch_html()
    usd = parse_rate(html, "dolar")
    eur = parse_rate(html, "euro")
    if not (usd > 0 and eur > 0 and 0.7 < eur / usd < 2.0):
        raise ValueError(f"tasas fuera de rango plausible: usd={usd} eur={eur}")

    m = re.search(r'Fecha Valor:.*?content="(\d{4}-\d{2}-\d{2})', html, re.S)
    value_date = m.group(1) if m else None

    now = datetime.now(CARACAS)
    today = now.date().isoformat()
    now_iso = now.isoformat()

    # Jump guard: a >3x move in one day is a parse glitch or a spoofed page,
    # not a market move. ponytail: fixed band; tighten if the bolívar stabilizes.
    cfg = couch("GET", f"/{DB}/config:system")
    prev = (cfg or {}).get("currentDailyRateBCV")
    if prev and not (prev / 3 < usd < prev * 3):
        raise ValueError(f"salto sospechoso de tasa: {prev} -> {usd}; no se guardó nada")

    doc = {
        "_id": f"rate:{today}",
        "type": "rate",
        "date": today,
        "bsPerUsd": usd,
        "bsPerEur": eur,
        "valueDate": value_date,
        "source": "bcv.org.ve",
        "fetchedAt": now_iso,
    }
    existing = couch("GET", f"/{DB}/rate:{today}")
    if existing:
        doc["_rev"] = existing["_rev"]
    couch("PUT", f"/{DB}/rate:{today}", doc)

    if cfg is None:
        cfg = {"_id": "config:system", "type": "config"}
    cfg["currentDailyRateBCV"] = usd
    cfg["lastUpdate"] = now_iso
    couch("PUT", f"/{DB}/config:system", cfg)

    print(f"ok {today}: USD {usd} Bs · EUR {eur} Bs · fecha valor {value_date}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 — one place to fail loudly for journald
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)
