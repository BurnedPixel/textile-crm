# VPS services

## bcv-rates — daily BCV exchange rates

Scrapes the official USD and EUR rates from https://www.bcv.org.ve/ every day
at **07:00 America/Caracas** and writes them to CouchDB:

- `rate:{YYYY-MM-DD}` — one doc per day: `bsPerUsd`, `bsPerEur`, `valueDate`
  (BCV's "Fecha Valor"), `source`, `fetchedAt`. Time-ordered ids -> history is a
  cheap `allDocs` range scan (`rate:` ... `rate:￰`).
- `config:system` — refreshes `currentDailyRateBCV` (USD) so the app opens each
  day on the official rate. Manual changes in the app's settings still stick
  until the next 07:00 run.

### Install

```sh
scp vps/bcv-rates.py   root@VPS:/usr/local/bin/bcv-rates.py
scp vps/bcv-rates.*    root@VPS:/etc/systemd/system/
ssh root@VPS chmod 755 /usr/local/bin/bcv-rates.py
# /etc/bcv-rates.env (root:root, 600) — see below, never in the repo
ssh root@VPS systemctl daemon-reload
ssh root@VPS systemctl enable --now bcv-rates.timer
ssh root@VPS systemctl start bcv-rates.service   # first run now
```

`/etc/bcv-rates.env` holds the CouchDB credentials of a dedicated `_users`
account (with the app role) used ONLY by this service:

```sh
COUCH_URL=http://127.0.0.1:5984
APP_DB=crm            # the application database name
RATES_USER=svc-rates
RATES_PASS=***        # generated at install time; lives only in this file
```

### Notes

- BCV's TLS chain is chronically incomplete -> the fetch skips verification.
  The script sanity-checks values (positivity, EUR/USD ratio band, >3x daily
  jump guard) and only ever talks to CouchDB over localhost.
- The fetch retries 3x (60 s apart); a failed day shows as a failed unit in
  `journalctl -u bcv-rates.service`. `Persistent=true` re-runs a missed
  schedule after downtime/reboot. Re-runs are idempotent (per-day upsert).
- Weekend/holiday runs re-log the standing rate — every calendar day gets its
  operative rate, which is what accounting wants.
