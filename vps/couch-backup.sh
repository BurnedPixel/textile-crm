#!/bin/bash
# Nightly CouchDB backup → offsite object storage, with a doc-count anomaly
# alert (audit S-9). Deployed at /usr/local/sbin/couch-backup.sh, run by
# cron.daily. Vendored here so a VPS rebuild cannot silently lose it — same
# rule as couch/fail2ban/. Concrete targets live in /etc/couch-backup.env
# (COUCH_USER, COUCH_PASS, RCLONE_TARGET), never in this file.
set -euo pipefail
source /etc/couch-backup.env
: "${RCLONE_TARGET:?RCLONE_TARGET no definido en /etc/couch-backup.env}"
STAMP=$(date +%F)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Doc-count anomaly alert: CouchDB has no per-user quota, so an authenticated
# writer can flood the database — the nightly delta is the canary. No MTA on
# this box: alert = loud journal line + append-only log file.
STATE=/var/lib/couch-backup/doc_counts
mkdir -p "$(dirname "$STATE")"; touch "$STATE"
ALERT_ABS="${ALERT_ABS:-1000}"   # docs/day; legit use is ~200/day at peak
ALERT_PCT="${ALERT_PCT:-25}"     # or >25% one-day growth (min 100 docs, so tiny dbs don't cry)

for db in $(curl -sf -u "$COUCH_USER:$COUCH_PASS" http://127.0.0.1:5984/_all_dbs | jq -r '.[]'); do
  count=$(curl -sf -u "$COUCH_USER:$COUCH_PASS" "http://127.0.0.1:5984/$db" | jq -r '.doc_count')
  prev=$(awk -v db="$db" '$1==db{print $2}' "$STATE")
  if [[ -n "${prev:-}" ]]; then
    delta=$((count - prev))
    if (( delta > ALERT_ABS || (prev > 0 && delta > 100 && delta * 100 > prev * ALERT_PCT) )); then
      msg="ALERT: $db grew by $delta docs in one day ($prev -> $count)"
      logger -p daemon.err -t couch-backup "$msg" || true
      echo "$(date -Is) $msg" >> /var/log/couch-backup-alerts.log
    fi
  fi
  awk -v db="$db" -v c="$count" '$1!=db{print} END{print db, c}' "$STATE" > "$STATE.new" \
    && mv "$STATE.new" "$STATE"

  bash /opt/couchdb-dump/couchdb-dump.sh -b -H 127.0.0.1 -d "$db" \
    -u "$COUCH_USER" -p "$COUCH_PASS" -f "$WORK/$db-$STAMP.json"
  gzip "$WORK/$db-$STAMP.json"
done

rclone copy "$WORK" "$RCLONE_TARGET"
