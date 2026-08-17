import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import { recomputeBatchCounters, resolveDocConflicts } from './conflicts';
import { saveFiscalConfig, getFiscalConfig } from './queries';
import { batchIdOf, productIdOf, FISCAL_CONFIG_ID, type CartLineItem } from './types';

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
      isOnTheBooks: false,
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

  it('agrees with the ledger at 0.001 kg granularity (audit I-7)', async () => {
    // Three 0.004 kg sales off a 10 kg roll: at 2-decimal rounding the cache
    // (10.00 - 0.00 x3 = 10.00) drifts from the ledger (10 - 0.012 = 9.988).
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Negro',
      nm: '24',
      fabricType: 'Rib',
      productType: 'ROLL',
      operatorId: 'op',
      rolls: [{ pieceId: 'R1', weightKg: 10, purchaseValueUsd: 5, salePriceUsd: 8 }],
    });
    const bid = batchIdOf('Negro', '24', 'Rib');
    for (const tx of ['tx1', 'tx2', 'tx3']) {
      await checkout(db, {
        transactionId: tx,
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [rollLine(bid, 'R1', 0.004)],
        payments: { paidUsdCash: 1, paidUsdTransfer: 0, paidBs: 0 },
      });
    }

    const r1 = (await db.get(productIdOf(bid, 'R1'))) as { currentWeightKg: number };
    expect(r1.currentWeightKg).toBe(9.988); // cache matches the ledger, not 10.00

    await recomputeBatchCounters(db, bid); // idempotent: rewrites the SAME value

    const r1b = (await db.get(productIdOf(bid, 'R1'))) as { currentWeightKg: number };
    expect(r1b.currentWeightKg).toBe(9.988);
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

  it('folds colorCode across revs — the arbitrary winner must not lose it', async () => {
    // Device A registers the code; device B, forked from a pre-code rev, tops
    // the batch up without one. colorCode is not derivable from the ledger, so
    // whichever rev wins, the code must survive the resolution.
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Azul Rey',
      nm: '30',
      fabricType: 'Jersey',
      productType: 'ROLL',
      colorCode: '215',
      operatorId: 'op',
      rolls: [{ pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 }],
    });
    const bid = batchIdOf('Azul Rey', '30', 'Jersey');

    // Inject device B's code-less fork with a rev id that SORTS ABOVE the
    // stored one, so CouchDB's deterministic winner rule picks the fork.
    const codeless = { ...((await db.get(bid)) as Record<string, unknown>) };
    delete codeless.colorCode;
    codeless._rev = '2-' + 'f'.repeat(32);
    await db.bulkDocs([codeless], { new_edits: false } as never);

    const winner = (await db.get(bid)) as { colorCode?: string };
    expect(winner.colorCode).toBeUndefined(); // the code-less fork won — the hazard is real

    await resolveDocConflicts(db, bid);

    const resolved = (await db.get(bid, { conflicts: true })) as {
      _conflicts?: string[];
      colorCode?: string;
    };
    expect(resolved._conflicts ?? []).toHaveLength(0);
    expect(resolved.colorCode).toBe('215'); // folded from the losing rev
  });

  it('folds a roll\'s lot metadata too — a stale fork must not erase a correction', async () => {
    // Same hazard one level down: lotNumber/pantone/fiberComposition are not
    // derivable from the ledger either, so a fork that predates a Buscar-y-
    // corregir correction used to silently delete it when it won.
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Verde', nm: '30', fabricType: 'Jersey', productType: 'ROLL', operatorId: 'op',
      lotNumber: '7892', pantone: '15-0343 TCX', fiberComposition: '65/35',
      rolls: [{ pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 }],
    });
    const bid = batchIdOf('Verde', '30', 'Jersey');
    const pid = productIdOf(bid, 'R1');

    const bare = { ...((await db.get(pid)) as Record<string, unknown>) };
    delete bare.lotNumber;
    delete bare.pantone;
    delete bare.fiberComposition;
    bare._rev = '2-' + 'f'.repeat(32); // sorts above the stored rev → it wins
    await db.bulkDocs([bare], { new_edits: false } as never);
    expect(((await db.get(pid)) as { lotNumber?: string }).lotNumber).toBeUndefined();

    await resolveDocConflicts(db, pid);

    const resolved = (await db.get(pid, { conflicts: true })) as {
      _conflicts?: string[];
      lotNumber?: string;
      pantone?: string;
      fiberComposition?: string;
      currentWeightKg: number;
    };
    expect(resolved._conflicts ?? []).toHaveLength(0);
    expect(resolved.lotNumber).toBe('7892');
    expect(resolved.pantone).toBe('15-0343 TCX');
    expect(resolved.fiberComposition).toBe('65/35');
    expect(resolved.currentWeightKg).toBe(20); // counters still rebuilt from the ledger
  });
});

// A new config document that falls through this resolver lands in the
// append-only branch, which keeps whichever revision CouchDB happened to pick.
// That is exactly what "never accept CouchDB's arbitrary winner" forbids, and
// it is silent: the losing edit is deleted and the stale RIF keeps printing.
describe('resolveDocConflicts — every config: doc resolves by newest lastUpdate', () => {
  it('keeps the newer fiscal header when two devices edited it offline', async () => {
    const db = makeTestDb();
    await saveFiscalConfig(db, {
      businessName: 'Vieja Razón, C.A.', taxId: 'J-30665094-6', address: 'Dirección vieja',
    });
    const stale = (await getFiscalConfig(db))!;

    // The other device's edit, made later and replicated in as a conflict.
    await saveFiscalConfig(db, {
      businessName: 'ML Textiles, C.A.', taxId: 'J-40123456-7', address: 'Dirección nueva',
    });
    const fresh = (await getFiscalConfig(db))!;
    expect(fresh.lastUpdate >= stale.lastUpdate).toBe(true);

    // The losing branch, explicitly older. (An exact lastUpdate tie would fall
    // back to CouchDB's pick — inherent to "newest wins", and the same for
    // config:system.)
    await db.put(
      { ...stale, businessName: 'Rama en conflicto', lastUpdate: '2020-01-01T00:00:00.000Z' },
      { force: true },
    );
    const conflicted = (await db.get(FISCAL_CONFIG_ID, { conflicts: true })) as {
      _conflicts?: string[];
    };
    expect(conflicted._conflicts?.length).toBe(1);

    await resolveDocConflicts(db, FISCAL_CONFIG_ID);
    const winner = (await getFiscalConfig(db))!;
    expect(winner.businessName).toBe('ML Textiles, C.A.');
    expect(winner.taxId).toBe('J-40123456-7');
    expect(((await db.get(FISCAL_CONFIG_ID, { conflicts: true })) as { _conflicts?: string[] })._conflicts)
      .toBeUndefined();
  });
});
