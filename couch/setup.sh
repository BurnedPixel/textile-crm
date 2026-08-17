#!/usr/bin/env bash
# Idempotent CouchDB provisioning. Run against the cloud node
# and (with COUCH_URL overridden) against the Pi node. Re-running is safe.
#
# Requires a sibling ../.env (see couch/README.md) with:
#   COUCH_USER, COUCH_PASS          — CouchDB server admin
#   APP_USER, APP_PASS              — first application user (gets APP_ROLE)
#   APP_DB, APP_ROLE                — database and role names (default: crm)
#   COUCH_URL                       — required, e.g. https://app.example.com/db
#
# NEVER echoes passwords. curl -f fails loudly on any HTTP error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../.env"

: "${COUCH_USER:?COUCH_USER no definido en .env}"
: "${COUCH_PASS:?COUCH_PASS no definido en .env}"
: "${APP_USER:?APP_USER no definido en .env}"
: "${APP_PASS:?APP_PASS no definido en .env}"
APP_DB="${APP_DB:-crm}"
APP_ROLE="${APP_ROLE:-crm}"
: "${COUCH_URL:?COUCH_URL no definido en .env}"
COUCH_URL="${COUCH_URL%/}"

DB="${APP_DB}"

# Admin credentials go through a mode-600 netrc file removed on exit, never argv:
# `-u user:pass` sits in /proc/<pid>/cmdline, world-readable for the whole run.
COUCH_HOST="$(printf '%s' "${COUCH_URL}" | sed -E 's#^[a-z]+://##; s#[/:].*$##')"
NETRC="$(mktemp)"
chmod 600 "${NETRC}"
trap 'rm -f "${NETRC}"' EXIT
printf 'machine %s login %s password %s\n' \
  "${COUCH_HOST}" "${COUCH_USER}" "${COUCH_PASS}" > "${NETRC}"
AUTH=(--netrc-file "${NETRC}")
# -f: fail on HTTP >=400 (except we tolerate 412 "already exists" below via || true checks).
CURL=(curl -fsS --retry 3 "${AUTH[@]}" -H 'Content-Type: application/json')

echo "==> CouchDB target: ${COUCH_URL}"

# 1. Require authenticated users for all requests (no admin party, no anon writes).
echo "==> Enabling require_valid_user"
"${CURL[@]}" -X PUT "${COUCH_URL}/_node/_local/_config/chttpd/require_valid_user" \
  -d '"true"' >/dev/null

# 2. Ensure the system databases exist (fresh installs need these).
for sysdb in _users _replicator _global_changes; do
  echo "==> Ensuring system db ${sysdb}"
  curl -fsS "${AUTH[@]}" -X PUT "${COUCH_URL}/${sysdb}" >/dev/null 2>&1 \
    || echo "    ${sysdb} already exists"
done

# 3. Create the application database (ignore 412 = already exists).
echo "==> Ensuring database ${DB}"
curl -fsS "${AUTH[@]}" -X PUT "${COUCH_URL}/${DB}" >/dev/null 2>&1 \
  || echo "    ${DB} already exists"

# 4. Lock down _security: only the app role (or admins) may read/write.
echo "==> Setting _security on ${DB}"
"${CURL[@]}" -X PUT "${COUCH_URL}/${DB}/_security" -d '{
  "admins":  { "names": [], "roles": ["_admin"] },
  "members": { "names": [], "roles": ["'"${APP_ROLE}"'"] }
}' >/dev/null

# 5. _users security: let the app's own admins manage accounts, and let every
#    authenticated user reach their OWN user doc (self-service password change).
#
#    Verified against the CouchDB 3.5 sources before writing an EMPTY members
#    section (apache/couchdb tag 3.5.0):
#      · src/chttpd/src/chttpd_auth_request.erl — GET/PUT of /_users/<docid>
#        goes through db_authorization_check, i.e. the security object below.
#        Empty members = every authenticated user passes it (require_valid_user
#        above is what keeps "authenticated" meaningful — do not disable it).
#        _users/_all_docs and _users/_changes stay SERVER-admin only, always:
#        that clause runs before the security object is even consulted.
#      · src/couch/src/couch_users_db.erl — before_doc_update throws not_found
#        unless the writer is a db admin or the doc IS their own; after_doc_read
#        strips every non-public field (default: all of them) from someone
#        else's doc. So an operador can read/write only their own account, and
#        no password hash leaks to a peer.
#      · src/couch/include/couch_js_functions.hrl (the built-in _design/_auth
#        validator) — a non-admin cannot change roles at all, and NOBODY can
#        grant a role starting with "_". "Admin" there counts db admins BY ROLE,
#        which is exactly why ${APP_ROLE}-admin is listed below: it is what lets
#        the in-app Usuarios panel create users and reset passwords.
echo "==> Setting _security on _users (admins: ${APP_ROLE}-admin)"
# CouchDB 3.x blocks editing _users/_security unless users_db_security_editable
# is on (403 otherwise). Enable just for this PUT, then restore the guard —
# the stored security object keeps applying either way; only EDITING is gated.
"${CURL[@]}" -X PUT "${COUCH_URL}/_node/_local/_config/couchdb/users_db_security_editable" \
  -d '"true"' >/dev/null
"${CURL[@]}" -X PUT "${COUCH_URL}/_users/_security" -d '{
  "admins":  { "names": [], "roles": ["_admin", "'"${APP_ROLE}"'-admin"] },
  "members": { "names": [], "roles": [] }
}' >/dev/null
"${CURL[@]}" -X PUT "${COUCH_URL}/_node/_local/_config/couchdb/users_db_security_editable" \
  -d '"false"' >/dev/null

# 6. Push the validation design doc (preserving its _rev if it already exists).
echo "==> Pushing validation design doc"
VALIDATE_FN="$(sed "s/__APP_ROLE__/${APP_ROLE}/g" "${SCRIPT_DIR}/validate_doc_update.js")"
DDOC_ID="_design/validation"
REV="$(curl -fsS "${AUTH[@]}" "${COUCH_URL}/${DB}/${DDOC_ID}" 2>/dev/null \
  | grep -o '"_rev":"[^"]*"' | cut -d'"' -f4 || true)"

# Build the design doc JSON with the function embedded as a JSON string.
DDOC_JSON="$(VALIDATE_FN="${VALIDATE_FN}" REV="${REV}" DDOC_ID="${DDOC_ID}" python3 - <<'PY'
import json, os
doc = {"_id": os.environ["DDOC_ID"], "validate_doc_update": os.environ["VALIDATE_FN"]}
rev = os.environ.get("REV")
if rev:
    doc["_rev"] = rev
print(json.dumps(doc))
PY
)"
"${CURL[@]}" -X PUT "${COUCH_URL}/${DB}/${DDOC_ID}" -d "${DDOC_JSON}" >/dev/null

# 7. Create the first app user in _users (skip if present). Fresh installs get the
#    base sync role + operador; the base role alone no longer authorizes any write.
echo "==> Ensuring app user (roles: ${APP_ROLE}, ${APP_ROLE}-operador)"
USER_ID="org.couchdb.user:${APP_USER}"
if curl -fsS "${AUTH[@]}" "${COUCH_URL}/_users/${USER_ID}" >/dev/null 2>&1; then
  echo "    app user already exists (roles NOT touched — see migration note below)"
else
  USER_JSON="$(APP_USER="${APP_USER}" APP_PASS="${APP_PASS}" APP_ROLE="${APP_ROLE}" python3 - <<'PY'
import json, os
role = os.environ["APP_ROLE"]
print(json.dumps({
  "name": os.environ["APP_USER"],
  "password": os.environ["APP_PASS"],
  "roles": [role, role + "-operador"],
  "type": "user",
}))
PY
)"
  "${CURL[@]}" -X PUT "${COUCH_URL}/_users/${USER_ID}" -d "${USER_JSON}" >/dev/null
  echo "    app user created"
fi

# ─── ONE-TIME ROLE MIGRATION (existing nodes) — RUN MANUALLY AT DEPLOY ────────
# Deliberately NOT automated here: existing accounts may already carry per-person
# roles this script knows nothing about, and rewriting them blind is how a user
# loses sync at 7am. Run these BEFORE (or in the same maintenance window as) the
# new validation ddoc — until a user has a function role, every write they make
# is rejected at replication, which looks like success in the browser.
#
# ALWAYS round-trip the document: GET it, add the role, PUT the whole thing back.
# Hand-writing the body drops derived_key/salt/iterations and the account can
# never log in again (couch_users_db only re-hashes when a "password" field is
# present; everything else you omit is simply gone).
#
#   printf 'machine %s login %s password %s\n' "$COUCH_HOST" "$COUCH_USER" "$COUCH_PASS" > ~/.nc
#   chmod 600 ~/.nc                       # netrc, never -u: argv is world-readable
#   NC=(curl -fsS --netrc-file ~/.nc -H 'Content-Type: application/json')
#
#   ADD='import json,os,sys; d=json.load(sys.stdin); d["roles"]=sorted(set(d["roles"])|{os.environ["ROLE"]}); print(json.dumps(d))'
#   add_role() {   # add_role <username> <role>
#     U="$COUCH_URL/_users/org.couchdb.user:$1"
#     "${NC[@]}" "$U" | ROLE="$2" python3 -c "$ADD" | "${NC[@]}" -X PUT "$U" -d @-
#   }
#   add_role "$APP_USER" "${APP_ROLE}-operador"   # shared app user keeps working
#   add_role svc-rates   "${APP_ROLE}-rates"      # VPS BCV timer (rate: + config:system)
#   add_role DUENO       "${APP_ROLE}-admin"      # the owner's account (create it first if absent)
#
#   rm -f ~/.nc
#   # Verify (server admin only): each doc's roles came back as expected.
#   "${NC[@]}" "$COUCH_URL/_users/org.couchdb.user:$APP_USER"
# ─────────────────────────────────────────────────────────────────────────────

# 8. DoS hardening: cap document size (app docs are small by design; embedded
#    line-item arrays are bounded — 1 MB is generous).
echo "==> Capping max_document_size (1 MB)"
"${CURL[@]}" -X PUT "${COUCH_URL}/_node/_local/_config/couchdb/max_document_size" \
  -d '"1048576"' >/dev/null

# 9. Pin password hashing. These match CouchDB 3.5's defaults (the live node's
#    _users hashes were verified at exactly these values, 2026-08-16) — pinned
#    so a rebuilt node or an older CouchDB cannot silently drift below them.
#    A config change never re-hashes existing _users docs.
echo "==> Pinning password hashing (pbkdf2-sha256, 600k iterations)"
for kv in 'password_scheme "pbkdf2"' 'pbkdf2_prf "sha256"' 'iterations "600000"'; do
  key="${kv%% *}"; val="${kv#* }"
  "${CURL[@]}" -X PUT "${COUCH_URL}/_node/_local/_config/chttpd_auth/${key}" \
    -d "${val}" >/dev/null
done

# fail2ban is OS-level, not reachable over this HTTP API: the deployed jail is
# vendored in ./fail2ban/ — on a NEW node, copy couchdb-auth.conf to
# /etc/fail2ban/filter.d/ and couchdb.local to /etc/fail2ban/jail.d/, then
# `systemctl reload fail2ban` (see README.md → Hardening).

echo "==> Done. ${DB} is ready on ${COUCH_URL}"
