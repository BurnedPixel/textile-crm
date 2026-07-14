import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import { recomputeBatchCounters, resolveDocConflicts } from './conflicts';
import { batchIdOf, productIdOf, type CartLineItem } from './types';

const RATE = 36.5;

function rollLine(batchId: string, pieceId: string, qty: number): CartLineItem {
  return {
    productId: productIdOf(batchId, pieceId),
    batchId,
    description: 'x',
    quantity: qty,
    unitOfMeasure: 'Kg',
    unitPriceAtSale: 8,
    lineSubtotalUsd: 0,
  };
}

describe('recomputeBatchCounters — ledger is source of truth', () => {
  it('rebuilds product weight + batch units from movements', async () => {
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Negro',
      nm: '24',
      fabricType: 'Rib',
      productType: 'ROLL',
      operatorId: 'op',
      rolls: [
        { pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
        { pieceId: 'R2', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
      ],
    });
    const bid = batchIdOf('Negro', '24', 'Rib');
    await checkout(db, {
      transactionId: 'tx',
      createdAt: new Date().toISOString(),
      clientId: null,
      isOnTheBooks: true,
      exchangeRateBCV: RATE,
      creditTerms: null,
      operatorId: 'op',
      lines: [rollLine(bid, 'R1', 5)],
      payments: { paidUsdCash: 40, paidUsdTransfer: 0, paidBs: 0 },
    });

    // Corrupt the cached counters directly, then recompute from the ledger.
    const r1 = (await db.get(productIdOf(bid, 'R1'))) as { currentWeightKg: number } & Record<string, unknown>;
    await db.put({ ...r1, currentWeightKg: 999 });
    const batch = (await db.get(bid)) as { currentUnits: number } & Record<string, unknown>;
    await db.put({ ...batch, currentUnits: 999 });

    await recomputeBatchCounters(db, bid);

    const r1b = (await db.get(productIdOf(bid, 'R1'))) as { currentWeightKg: number };
    expect(r1b.currentWeightKg).toBe(15); // 20 in - 5 out
    const batchB = (await db.get(bid)) as { currentUnits: number };
    expect(batchB.currentUnits).toBe(2); // both rolls still non-empty
  });
});

describe('resolveDocConflicts — counters resolve via the ledger', () => {
  it('collapses conflicting counter revs injected with new_edits:false and rebuilds truth', async () => {
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Blanco',
      nm: '30',
      fabricType: 'Jersey',
      productType: 'ROLL',
      operatorId: 'op',
      rolls: [{ pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 }],
    });
    const bid = batchIdOf('Blanco', '30', 'Jersey');
    const pid = productIdOf(bid, 'R1');

    // Inject a conflicting revision of the product doc (as replication would).
    const current = (await db.get(pid)) as Record<string, unknown> & { _rev: string };
    const forkedRev = '2-' + 'a'.repeat(32);
    await db.bulkDocs(
      [{ ...current, _rev: forkedRev, currentWeightKg: 12345 }],
      { new_edits: false } as never,
    );

    // Confirm a conflict now exists.
    const withConflicts = (await db.get(pid, { conflicts: true })) as { _conflicts?: string[] };
    expect(withConflicts._conflicts?.length).toBeGreaterThan(0);

    await resolveDocConflicts(db, pid);

    const resolved = (await db.get(pid, { conflicts: true })) as {
      _conflicts?: string[];
      currentWeightKg: number;
    };
    expect(resolved._conflicts ?? []).toHaveLength(0); // conflicts gone
    expect(resolved.currentWeightKg).toBe(20); // rebuilt from ledger, not the bogus rev
  });
});
