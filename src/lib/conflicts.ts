// Multi-master conflict resolution (Browser ↔ Pi ↔ cloud sync WILL conflict).
// Never accept CouchDB's arbitrary default winner. Rules per CLAUDE.md:
//   batch:/product:  → delete ALL conflicting revs, recompute counters from the ledger.
//   config:system    → newest lastUpdate wins.
//   client:          → newest updatedAt wins.
//   sale:/expense:/movement: → append-only unique ids; must not conflict. If they
//                              somehow do, keep the winner and warn.
// Takes `db` first; no browser imports (the watcher is started from db.ts).

import {
  type BatchDoc,
  type ProductDoc,
  type SystemConfigDoc,
  type ClientDoc,
  type InventoryMovementDoc,
} from './types';
import { round2 } from './format';

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
    // then rebuild from movements.
    await deleteRevs(db, id, conflicts);
    const batchId = id.startsWith('batch:') ? id : (await getBatchIdOfProduct(db, id));
    if (batchId) await recomputeBatchCounters(db, batchId);
    return;
  }

  if (id === 'config:system') {
    await keepBy<SystemConfigDoc>(db, id, conflicts, (a, b) =>
      a.lastUpdate >= b.lastUpdate ? a : b,
    );
    return;
  }

  if (id.startsWith('client:')) {
    await keepBy<ClientDoc>(db, id, conflicts, (a, b) => (a.updatedAt >= b.updatedAt ? a : b));
    return;
  }

  // sale:/expense:/movement: are append-only with unique ids — should be impossible.
  console.warn(`[conflicts] unexpected conflict on append-only doc ${id}; keeping winner.`);
  await deleteRevs(db, id, conflicts);
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
export async function recomputeBatchCounters(db: DB, batchId: string): Promise<void> {
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
    const total = round2(totalsByProduct.get(p._id) ?? 0);
    if (isRoll) {
      const weight = Math.max(0, total);
      writes.push({ ...p, currentWeightKg: weight });
      if (weight > 0.001) batchUnits += 1; // each non-empty roll = one unit
    } else {
      batchUnits += total; // COMBO/PIECE: units summed straight from the ledger
    }
  }

  writes.push({ ...batch, currentUnits: Math.max(0, batchUnits) });
  await db.bulkDocs(writes);
}
