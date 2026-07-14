# CouchDB provisioning

`setup.sh` provisions a CouchDB node for the app. It is idempotent — re-run it
any time. It reads secrets from a sibling `../.env` (never commit that file).

## What `setup.sh` does

1. Enables `chttpd/require_valid_user` — no admin party, no anonymous access.
2. Ensures the system databases (`_users`, `_replicator`, `_global_changes`).
3. Creates the application database (`APP_DB`, default `crm`).
4. Writes `_security` so only the app role (`APP_ROLE`, default `crm`) and
   server admins can read/write.
5. Pushes the `validate_doc_update` design doc from `validate_doc_update.js`
   (substituting `APP_ROLE` for its `__APP_ROLE__` placeholder), which rejects
   derived fields (`totalBs`, `amountBs`) and any write from a user lacking the
   app role.
6. Creates the first application user in `_users` with the app role.

## `.env` (in the repo root, gitignored)

```sh
COUCH_USER=admin
COUCH_PASS=***               # CouchDB server admin
APP_USER=caja1
APP_PASS=***                 # first app user (gets APP_ROLE)
APP_DB=crm                   # application database name
APP_ROLE=crm                 # role required to read/write it
COUCH_URL=https://app.example.com/db      # your cloud node (or http://pi.local:5984)
```

## Run it

```sh
./couch/setup.sh
```

## Adding more users

Each cashier/manager/owner gets their own `_users` document with the app role
(`$APP_ROLE`):

```sh
curl -f -u "$COUCH_USER:$COUCH_PASS" \
  -H 'Content-Type: application/json' \
  -X PUT "$COUCH_URL/_users/org.couchdb.user:NUEVO_USUARIO" \
  -d "{\"name\":\"NUEVO_USUARIO\",\"password\":\"***\",\"roles\":[\"$APP_ROLE\"],\"type\":\"user\"}"
```

Rotate a password by PUTting the user doc again with its current `_rev` and a new
`password` field. Never store plaintext passwords anywhere but the request body.

## Pi node

Run the **same** `setup.sh` against the Pi's CouchDB (override `COUCH_URL`, e.g.
`COUCH_URL=http://pi.local:5984 ./couch/setup.sh`). Then configure **continuous
bidirectional** replication of both `$APP_DB` **and** `_users` between the Pi and
the cloud, so credentials and data stay consistent through internet outages:

```sh
# On the Pi (persist in _replicator so it survives restarts). Do this both ways.
curl -f -u "$COUCH_USER:$COUCH_PASS" -H 'Content-Type: application/json' \
  -X POST "http://localhost:5984/_replicator" -d '{
    "_id": "app-pi-to-cloud",
    "source": "http://localhost:5984/'"$APP_DB"'",
    "target": "https://.../db/'"$APP_DB"'",
    "continuous": true, "retry": true
  }'
# ... plus cloud->pi for the app db, and both directions for _users.
```

## Hardening (APPLIED on the VPS 2026-07-13 — mirror on the Pi when provisioning it)

**Caddy: cookie flags + security headers.** CouchDB sets its `AuthSession`
cookie `HttpOnly` but doesn't know TLS terminates at Caddy, so the missing
flags are appended at the proxy (cloud node; the Pi speaks plain LAN HTTP,
where `Secure` would break login). The deployed `/etc/caddy/Caddyfile`:

```caddyfile
app.example.com {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "same-origin"
	}
	handle_path /db/* {
		reverse_proxy 127.0.0.1:5984 {
			header_down Set-Cookie "(?i)^(AuthSession=[^;]*(?:;.*)?)$" "$1; Secure; SameSite=Lax"
		}
	}
	handle {
		header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'"
		root * /srv/APP_DIR
		file_server
	}
}

# Interim name — permanent redirect to the real domain.
old-interim-name.example.com {
	redir https://app.example.com{uri} permanent
}
```

The CSP is scoped to the static app only (`handle`) — Fauxton under `/db/_utils`
needs its own inline scripts. `script-src 'unsafe-inline'` is required by the
Astro `is:inline` auth-gate script in `Layout.astro`; re-verify the CSP against
the real bundle when the app is deployed.

**Login rate limiting — two layers.** CouchDB 3.5 has a built-in lockout
(after ~5 failed logins it answers `403` for a while). fail2ban watches
`/_session` 401s **and** those lockout 403s and escalates to a network ban.
Note: fail2ban strips the timestamp from each line before matching, so the
regex must NOT account for the timestamp field. Deployed config (ban verified
end-to-end: 8 failures → IP blocked at the firewall, then unbanned):

```ini
# /etc/fail2ban/filter.d/couchdb-auth.conf
# Line: [notice] TS couchdb@host <pid> reqid HOSTNAME CLIENTIP user POST /_session 401 ok ms
[Definition]
failregex = ^\[notice\]\s+(?:\S+\s+)?couchdb@\S+\s+<[^>]+>\s+\S+\s+\S+\s+<HOST>\s+\S+\s+POST /_session 40[13]

# /etc/fail2ban/jail.d/couchdb.local
[couchdb-auth]
enabled = true
filter = couchdb-auth
port = http,https
logpath = /var/log/couchdb/couchdb.log
backend = polling
maxretry = 8
findtime = 300
bantime = 900
```

**Network exposure.** CouchDB listens on `127.0.0.1:5984` only — Caddy
(80/443) is the sole way in. Keep it that way; never bind CouchDB to a public
interface.

**Payload caps.** `setup.sh` sets `couchdb/max_document_size` to 1 MB — app
documents are small by design (embedded arrays are bounded), so anything larger
is abuse, not data.

**Session lifetime.** Default `chttpd_auth/timeout` is 600 s but the cookie is
refreshed on activity. Offline work never depends on the session — the app is
local-first; an expired session only pauses sync until the next login.

## Trust boundary — read this

The client-side login (`src/lib/auth.ts`) is **UX only**. The real enforcement is
CouchDB `_security` + `validate_doc_update`: an unauthenticated or unauthorized
request is rejected by the server regardless of what the browser UI allows.

Local IndexedDB data on each device is **not** protected by CouchDB — it relies on
**device security** (OS login + full-disk encryption). Treat every factory
terminal and manager laptop accordingly.
