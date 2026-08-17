# CouchDB provisioning

`setup.sh` provisions a CouchDB node for the app. It is idempotent — re-run it
any time. It reads secrets from a sibling `../.env` (never commit that file).

## What `setup.sh` does

1. Enables `chttpd/require_valid_user` — no admin party, no anonymous access.
2. Ensures the system databases (`_users`, `_replicator`, `_global_changes`).
3. Creates the application database (`APP_DB`, default `crm`).
4. Writes `_security` so only the app role (`APP_ROLE`, default `crm`) and
   server admins can read/write.
5. Writes `_security` on `_users` (see *Roles* below).
6. Pushes the `validate_doc_update` design doc from `validate_doc_update.js`
   (substituting `APP_ROLE` for its `__APP_ROLE__` placeholder), which rejects
   derived fields (`totalBs`, `amountBs`), any write from a user lacking the
   app role, any mutation of an existing `sale:`/`payment:`/`refund:`/
   `expense:`/`movement:` document, and any write the writer's **function role**
   does not allow.
7. Creates the first application user in `_users` with the base + `-operador`
   roles. Existing users are never touched — see *Roles* → migration.

## Roles (2026-08-17)

Four roles, all derived from `APP_ROLE` inside the validator (no new `.env`
values, no new placeholders):

| Role | Who | May write |
|---|---|---|
| `$APP_ROLE` | everyone | nothing by itself — it is the **sync** role (`_security` membership) and what lets the conflict watcher delete losing revs |
| `$APP_ROLE-operador` | sellers / warehouse | `sale:` `payment:` `refund:` `expense:` `movement:` `client:` `batch:` `product:` and any future prefix |
| `$APP_ROLE-admin` | owner | everything an operador can, plus every `config:` document and `rate:` — and db-admin rights on `_users` (create users, reset passwords) |
| `$APP_ROLE-rates` | the VPS BCV timer only | `rate:{date}` + `config:system`. **No** operational access — its `sale:` writes are rejected |

`_admin` (server admin) still bypasses everything; that is what conflict cleanup
and the immutability exemption run as.

**Deletions only ever need the base role.** `src/lib/conflicts.ts` deletes losing
revs of `batch:`/`product:`/`client:`/`config:` docs on every device, under
whoever is logged in there; gating deletes would break the watcher on operador
devices and let the cached counters drift. Deleting an append-only doc is already
rejected by the immutability rule, which runs first. The matrix is covered by
`src/lib/validate-ddoc.test.ts`, which evaluates this exact file.

### `_users` security

```json
{"admins": {"names": [], "roles": ["_admin", "$APP_ROLE-admin"]},
 "members": {"names": [], "roles": []}}
```

Empty `members` is deliberate and safe — verified against the CouchDB 3.5 sources
(the reasoning is spelled out in `setup.sh` step 5):

- `_users/_all_docs` and `_users/_changes` remain **server-admin only** no matter
  what the security object says (`chttpd_auth_request.erl`) — so there is no way
  to enumerate accounts, and an in-app Usuarios panel can only work with ids it
  already knows.
- A non-admin can read/write **only their own** user doc; someone else's comes
  back with every field stripped → `404` (`couch_users_db.erl`). No hash leaks.
- Nobody but a `_users` admin can change roles, and no role starting with `_` can
  ever be granted (the built-in `_design/_auth` validator).

That gives everyone self-service password change, and gives `$APP_ROLE-admin`
user management, without a server-admin credential in the browser. It depends on
`require_valid_user` staying enabled (step 1).

### One-time role migration

`setup.sh` does **not** re-role existing accounts. The exact commands are in the
marked comment block in `setup.sh` (after step 7): round-trip each `_users` doc
(GET → add role → PUT the whole document) and add `-operador` to the app user,
`-rates` to `svc-rates`, `-admin` to the owner. Run it **before** the new
validation ddoc lands — a user without a function role has every write rejected
at replication, which looks like success in the browser and silently loses the
document. Never hand-write a user doc body: omitting `derived_key`/`salt`
destroys the password.

## Design-doc history

**2026-08-17 — function roles** (see *Roles*). ⚠️ Needs BOTH: the one-time role
migration first, then `setup.sh` (ddoc + `_users` `_security`) on **every** node.
A node still running the old validator accepts writes this one rejects.

**2026-07-30 — `payment:` added to the append-only regex** (payment ledger).
Pushed to the **cloud node**; verified by reading `_design/validation` back:
`^(sale|payment|expense|movement):`. ⚠️ The **Pi has not been provisioned yet** —
when it is, `setup.sh` must be run against it too, or it ships a stale validator
that lets any role member rewrite a collection.

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

Each cashier/manager/owner gets their own `_users` document with the base role
**plus a function role** (`-operador` or `-admin`; the base role alone can sync
but not write):

```sh
curl -f -u "$COUCH_USER:$COUCH_PASS" \
  -H 'Content-Type: application/json' \
  -X PUT "$COUCH_URL/_users/org.couchdb.user:NUEVO_USUARIO" \
  -d "{\"name\":\"NUEVO_USUARIO\",\"password\":\"***\",\"roles\":[\"$APP_ROLE\",\"$APP_ROLE-operador\"],\"type\":\"user\"}"
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
needs its own inline scripts. `script-src 'unsafe-inline'` is still required —
not by the auth gate anymore (external since 2026-08-16) but by Astro's own
`client:only` island bootstrap, which the compiler renders inline on every page
with an island. Revisit when Astro's CSP-hash support leaves experimental.

**Login rate limiting — two layers.** CouchDB 3.5 has a built-in lockout
(after ~5 failed logins it answers `403` for a while). fail2ban watches
`/_session` 401s **and** those lockout 403s and escalates to a network ban.
Note: fail2ban strips the timestamp from each line before matching, so the
regex must NOT account for the timestamp field. The deployed files are vendored
in `couch/fail2ban/` (copy to `/etc/fail2ban/filter.d/` and `/etc/fail2ban/jail.d/`
on a new node, then `systemctl reload fail2ban` — a rebuilt VPS must not silently
lose the jail). Deployed config (ban verified end-to-end: 8 failures → IP blocked
at the firewall, then unbanned):

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

**Password hashing.** `setup.sh` pins `chttpd_auth` to `pbkdf2` / `sha256` /
600 000 iterations — CouchDB 3.5's own defaults (the live `_users` hashes were
verified at exactly these values, 2026-08-16), made explicit so a rebuilt or
older node cannot drift below them. Pinning never re-hashes existing user docs;
rotate a password (see above) if a hash predates the pin.

## Trust boundary — read this

The client-side login (`src/lib/auth.ts`) is **UX only**. The real enforcement is
CouchDB `_security` + `validate_doc_update`: an unauthenticated or unauthorized
request is rejected by the server regardless of what the browser UI allows.

Local IndexedDB data on each device is **not** protected by CouchDB — it relies on
**device security** (OS login + full-disk encryption). Treat every factory
terminal and manager laptop accordingly.
