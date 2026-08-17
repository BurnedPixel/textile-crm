// Multi-master conflict resolution (Browser ↔ Pi ↔ cloud sync WILL conflict).
// Never accept CouchDB's arbitrary default winner. Rules per CLAUDE.md:
//   batch:/product:  → delete ALL conflicting revs, recompute counters from the ledger.
//   config:            → newest lastUpdate wins (system AND fiscal).
//   client:          → newest updatedAt wins.
//   sale:/payment:/refund:/expense:/movement: → append-only unique ids; must not conflict.
//                              If they somehow do, keep the winner and warn.
// Takes `db` first; no browser imports (the watcher is started from db.ts).

import {
  hasRollStock,
  type BatchDoc,
  type ProductDoc,
  type SystemConfigDoc,
  type ClientDoc,
  type InventoryMovementDoc,
} from './types';
import { round3 } from './format';

type DB = PouchDB.Database;

/** Start a live watcher that resolves conflicts as they arrive. Returns a stop fn. */
export function startConflictWatcher(db: DB): () => void {
  const feed = db
    .changes({ live: true, since: 'now', include_docs: false, conflicts: true })
    .on('change', (change) => {
      if (change.doc?._conflicts?.length || (change as { conflicts?: string[] }).conflicts) {
        void resolveDocConflicts(db, change.id);
      } else {
        // include_docs:false still flags conflicts on some adapters via a re-get.
        void maybeResolve(db, change.id);
      }
    });
  return () => feed.cancel();
}

async function maybeResolve(db: DB, id: string): Promise<void> {
  try {
    const doc = (await db.get(id, { conflicts: true })) as { _conflicts?: string[] };
    if (doc._conflicts?.length) await resolveDocConflicts(db, id);
  } catch {
    /* deleted or transient — ignore */
  }
}

/** Resolve all conflicting revisions of one document by its id prefix. */
export async function resolveDocConflicts(db: DB, id: string): Promise<void> {
  let doc: { _rev?: string; _conflicts?: string[] };
  try {
    doc = (await db.get(id, { conflicts: true })) as typeof doc;
  } catch {
    return; // gone
  }
  const conflicts = doc._conflicts ?? [];
  if (!conflicts.length) return;

  if (id.startsWith('batch:') || id.startsWith('product:')) {
    // Counters are a cache — the ledger is truth. Drop every conflicting rev,
    // then rebuild from movements. But not every field derives from the ledger:
    // fold those across every rev BEFORE the losers die, or they survive only
    // when CouchDB's arbitrary winner happens to carry them (device B's
    // code-less top-up beating device A's coded ingress; a stale fork of a roll
    // beating the Buscar-y-corregir correction of its lot number).
    //
    // A roll's purchaseValueUsd/salePriceUsd/conditionTag are NOT folded: they
    // are always present, so "first non-empty" says nothing about which rev is
    // the newer one, and ProductDoc carries no updatedAt to break the tie —
    // CouchDB's winner stands for those. Accepted caveat, the same one the batch
    // fold has always had: first-non-empty RESURRECTS a value a later rev
    // deliberately cleared (a lot number blanked on purpose comes back).
    await foldMeta(
      db,
      id,
      conflicts,
      id.startsWith('batch:')
        ? ['colorCode', 'location']
        : ['lotNumber', 'pantone', 'fiberComposition'],
    );
    await deleteRevs(db, id, conflicts);
    const batchId = id.startsWith('batch:') ? id : (await getBatchIdOfProduct(db, id));
    if (batchId) await recomputeBatchCounters(db, batchId);
    return;
  }

  // Every config: document, not just config:system. A new one that falls
  // through lands in the append-only branch below, which keeps whichever
  // revision CouchDB happened to pick — the one thing this module exists to
  // prevent. They all carry `lastUpdate`, so the rule already fits.
  if (id.startsWith('config:')) {
    await keepBy<SystemConfigDoc>(db, id, conflicts, (a, b) =>
      a.lastUpdate >= b.lastUpdate ? a : b,
    );
    return;
  }

  if (id.startsWith('client:')) {
    await keepBy<ClientDoc>(db, id, conflicts, (a, b) => (a.updatedAt >= b.updatedAt ? a : b));
    return;
  }

  // sale:/payment:/refund:/expense:/movement: are append-only with unique ids — should be impossible.
  console.warn(`[conflicts] unexpected conflict on append-only doc ${id}; keeping winner.`);
  await deleteRevs(db, id, conflicts);
}

type MetaDoc = Record<string, unknown> & { _rev?: string };

/**
 * Fields the ledger cannot rebuild (a batch's colorCode/location, a roll's
 * lot metadata): keep the winner's value when it has one, otherwise adopt the
 * first non-empty value among the conflicting revs. Revs are sorted descending
 * so every device folding the same rev set converges on the same doc — which
 * rev donates is arbitrary, determinism is what matters.
 */
async function foldMeta(
  db: DB,
  id: string,
  conflicts: string[],
  fields: string[],
): Promise<void> {
  const winner = (await db.get(id).catch(() => null)) as MetaDoc | null;
  if (!winner) return;
  const revs = await Promise.all(
    conflicts.map((rev) => (db.get(id, { rev }) as Promise<MetaDoc>).catch(() => null)),
  );
  const ordered = [
    winner,
    ...revs
      .filter((r): r is MetaDoc => r !== null)
      .sort((a, b) => (a._rev! < b._rev! ? 1 : -1)),
  ];
  const folded: MetaDoc = {};
  let changed = false;
  for (const field of fields) {
    const value = ordered.find((r) => r[field])?.[field];
    if (value === undefined) continue; // nobody has one — leave the winner alone
    folded[field] = value;
    if (value !== winner[field]) changed = true;
  }
  if (changed) await db.put({ ...winner, ...folded });
}

/** Delete a set of revisions of a doc (used to collapse conflicting branches). */
async function deleteRevs(db: DB, id: string, revs: string[]): Promise<void> {
  await Promise.all(
    revs.map((rev) => db.remove(id, rev).catch(() => undefined)),
  );
}

/**
 * Keep the winner chosen by `pick`, delete the losing revs. Fetches each
 * conflicting rev, folds them with the current winner.
 */
async function keepBy<T extends { _id: string; _rev?: string }>(
  db: DB,
  id: string,
  conflicts: string[],
  pick: (a: T, b: T) => T,
): Promise<void> {
  const winner = (await db.get(id)) as T;
  const versions = await Promise.all(
    conflicts.map((rev) => db.get(id, { rev }) as Promise<T>),
  );
  let best = winner;
  for (const v of versions) best = pick(best, v);

  // Losers = everything that isn't the chosen rev.
  const losers = [winner, ...versions].filter((v) => v._rev !== best._rev);
  await deleteRevs(db, id, losers.map((v) => v._rev!).filter(Boolean));
}

async function getBatchIdOfProduct(db: DB, productId: string): Promise<string | null> {
  try {
    const doc = (await db.get(productId)) as ProductDoc;
    return doc.batchId;
  } catch {
    // Fallback: product id is product:{batchId}:{pieceId} — strip the last segment.
    const idx = productId.lastIndexOf(':');
    return idx > 0 ? productId.slice('product:'.length, idx) : null;
  }
}

/**
 * Rebuild cached counters for a batch from the InventoryMovement ledger (source
 * of truth). Sums quantityChanged per product; ROLL → product.currentWeightKg,
 * COMBO/PIECE → batch.currentUnits.
 * ponytail: O(all movements) full-ledger scan on every conflict — fine at factory
 * scale (thousands of movements). Add a per-batch movement index if it ever isn't.
 */
export async function recomputeBatchCounters(
  db: DB,
  batchId: string,
  isRetry = false,
): Promise<void> {
  const batch = (await db.get(batchId).catch(() => null)) as BatchDoc | null;
  if (!batch) return;

  // Scan the whole movement ledger (movement:… prefix) and total per product.
  const movements = await db.allDocs<InventoryMovementDoc>({
    include_docs: true,
    startkey: 'movement:',
    endkey: 'movement:￰',
  });
  const totalsByProduct = new Map<string, number>();
  for (const row of movements.rows) {
    const mv = row.doc as InventoryMovementDoc | undefined;
    if (!mv?.lineItems) continue;
    for (const li of mv.lineItems) {
      if (!li.productId.startsWith(`product:${batchId}:`)) continue;
      totalsByProduct.set(
        li.productId,
        (totalsByProduct.get(li.productId) ?? 0) + li.quantityChanged,
      );
    }
  }

  const products = await db.allDocs<ProductDoc>({
    include_docs: true,
    startkey: `product:${batchId}:`,
    endkey: `product:${batchId}:￰`,
  });

  const writes: Array<ProductDoc | BatchDoc> = [];
  let batchUnits = 0;
  const isRoll = batch.productType === 'ROLL';

  for (const row of products.rows) {
    const p = row.doc as ProductDoc | undefined;
    if (!p) continue;
    const total = round3(totalsByProduct.get(p._id) ?? 0);
    if (isRoll) {
      const weight = Math.max(0, total);
      writes.push({ ...p, currentWeightKg: weight });
      if (hasRollStock(weight)) batchUnits += 1; // each non-empty roll = one unit
    } else {
      batchUnits += total; // COMBO/PIECE: units summed straight from the ledger
    }
  }

  writes.push({ ...batch, currentUnits: Math.max(0, batchUnits) });
  const results = await db.bulkDocs(writes);

  // bulkDocs is per-document: a concurrent write can 409 one counter while the
  // others land, leaving exactly the drift this function exists to remove — and
  // it used to be discarded silently. Everything here derives from the ledger,
  // so re-running is idempotent: one bounded re-run on fresh revs, then warn.
  const failed = results.filter((r) => r && 'error' in r);
  if (!failed.length) return;
  if (!isRetry) return recomputeBatchCounters(db, batchId, true);
  console.warn(
    `[conflicts] recompute could not write: ${failed
      .map((f) => (f as { id?: string }).id ?? '?')
      .join(', ')}`,
  );
}
