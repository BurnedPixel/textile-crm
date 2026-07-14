# Textile CRM — offline-first inventory & sales

CRM + inventory system for a Venezuelan textile factory (fabric wholesale): sale terminal,
weight-tracked fabric inventory, clients, expenses, and multi-currency
accounting (USD + VES at the daily BCV rate). Built to keep working through
internet outages — every device holds the full dataset and syncs when it can.

**Spanish UI, English code.** Keyboard-first: `/` search, `g`+key page chords,
full keyboard flows on the sale terminal and stock ingress.

## Architecture

- **No custom backend.** Static Astro build + PouchDB in the browser,
  replicating with CouchDB over a same-origin `/db/*` reverse proxy. All
  authorization is CouchDB's: `_security` roles + a `validate_doc_update`
  design doc (rejects derived fields, unauthorized writers, and mutations of
  append-only records). The client-side login gate is UX only.
- **Hybrid topology.** Remote users sync straight to the cloud CouchDB;
  on-site browsers sync to a Raspberry Pi on the LAN, which replicates
  continuously with the cloud — the Pi absorbs internet outages transparently,
  with no endpoint switching on any client.
- **Multi-master conflict resolution** is designed in, not bolted on:
  append-only ledgers with unique time-ordered ids cannot conflict; cached
  counters are recomputed from the movement ledger (ledger is truth); config
  and client docs resolve by newest timestamp. A live watcher applies this.
- **Domain invariants**, enforced in the data layer and again by the server
  validator:
  - Fabric rolls are tracked in **Kg**; combos and pieces in **units** — never
    mixed. A batch is identified by `color + nm + fabricType`, enforced at the
    DB level by its deterministic `_id`.
  - Every monetary field is explicitly suffixed (`Usd`, `Bs`). The BCV
    exchange rate is **locked** onto each sale/expense at creation; derived
    totals (`totalBs`, `amountBs`) are computed on read and never stored.
  - Prices are immutable once sold (`unitPriceAtSale` snapshots at checkout);
    historical records never mutate.
  - Every stock change writes an `InventoryMovement` audit entry — cached
    counters are recomputable from that ledger at any time.
  - Checkout writes sale + movement + counters in ONE `bulkDocs` call,
    idempotent on `transactionId` — no double deduction, ever.

## Stack

Astro 5 · React 19 islands · Tailwind 4 · PouchDB 9 ↔ CouchDB 3.5 ·
`@vite-pwa/astro` service worker (never caches `/db/*`) · self-hosted fonts ·
vitest (node + in-memory adapter) for the data layer.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321 — auto-seeds demo data, login gate off
npm test           # vitest — data-layer + security-behavior tests
npm run check      # astro check (keep at 0 errors)
npm run build      # production build → dist/
```

Logic modules take the database as their first argument and never import
browser-only code, so the whole data layer runs and is tested in node.

## Provision & deploy

- `couch/` — idempotent CouchDB provisioning (`setup.sh`), the server-side
  validator, and hardening notes (session cookie flags, fail2ban, payload
  caps, trust-boundary documentation). Reads secrets from a gitignored `.env`
  (see `.env.example`).
- `vps/` — the daily BCV exchange-rate service (systemd timer, 07:00
  America/Caracas) that logs official USD/EUR rates into the database and
  refreshes the app's daily rate.
- The client-facing business website is maintained privately (untracked here).
- Deploy = build from a clean `git archive HEAD`, rsync `dist/` to the host
  serving the app. Concrete hosts/domains are deliberately not in this repo.

## Data model

Source of truth: `src/lib/types.ts` (doc interfaces + `_id` builders).
`_id` is the only uniqueness constraint CouchDB has, so ids carry the design:
deterministic ids enforce identity (`batch:{color}:{nm}:{fabricType}`,
`client:{documentId}`), and append-only records get time-ordered prefixes
(`sale:{ISO}:{txId}`, `movement:{ISO}:{uuid}`, `expense:{ISO}:{uuid}`,
`rate:{YYYY-MM-DD}`) so every list view is a cheap `allDocs` range scan — no
Mango indexes anywhere. Line items embed in their parent (immutable +
bounded); mutable counters live on separate docs to avoid conflict hotspots.
User-supplied id components pass `norm()`, which strips the `:` delimiter —
the NoSQL analog of injection-proofing.
