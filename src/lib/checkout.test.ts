import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import { getSales, getMovements } from './queries';
import { batchIdOf, productIdOf, type CartLineItem, type ProductDoc, type BatchDoc } from './types';

// These fixtures are about stock, counters and idempotency, not tax: they are
// plain (not en libros) sales so their arithmetic stays the pre-IVA one.
const RATE = 36.5;

function rollLine(
  batchId: string,
  pieceId: string,
  qty: number,
  price: number,
): CartLineItem {
  return {
    productId: productIdOf(batchId, pieceId),
    batchId,
    description: `${batchId} ${pieceId}`,
    quantity: qty,
    unitOfMeasure: 'Kg',
    unitPriceAtSale: price,
    lineSubtotalUsd: 0,
  };
}

function unitLine(batchId: string, qty: number, price: number): CartLineItem {
  return {
    productId: productIdOf(batchId, 'stock'),
    batchId,
    description: `${batchId} combo`,
    quantity: qty,
    unitOfMeasure: 'Units',
    unitPriceAtSale: price,
    lineSubtotalUsd: 0,
  };
}

async function seedRollBatch(db: PouchDB.Database) {
  await ingressStock(db, {
    color: 'Azul Rey',
    nm: '30',
    fabricType: 'Jersey',
    productType: 'ROLL',
    operatorId: 'op',
    rolls: [
      { pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
      { pieceId: 'R2', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
    ],
  });
  return batchIdOf('Azul Rey', '30', 'Jersey');
}

describe('checkout — happy path', () => {
  it('writes sale + movement + counters in a single bulkDocs', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);

    const bulkSpy: number[] = [];
    const orig = db.bulkDocs.bind(db);
    // @ts-expect-error test instrumentation
    db.bulkDocs = (...args: unknown[]) => {
      bulkSpy.push(1);
      // @ts-expect-error passthrough
      return orig(...args);
    };

    const sale = await checkout(db, {
      transactionId: 'tx1',
      createdAt: new Date().toISOString(),
      clientId: null,
      isOnTheBooks: false,
      exchangeRateBCV: RATE,
      creditTerms: null,
      operatorId: 'op',
      lines: [rollLine(bid, 'R1', 5, 8)],
      payments: { paidUsdCash: 40, paidUsdTransfer: 0, paidBs: 0 },
    });

    expect(bulkSpy.length).toBe(1); // ONE bulkDocs
    expect(sale.totalUsd).toBe(40);
    expect(sale.paymentStatus).toBe('PAID');

    const sales = await getSales(db);
    expect(sales).toHaveLength(1);
    const movements = await getMovements(db);
    expect(movements).toHaveLength(2); // ingress IN + sale OUT
    const out = movements.find((m) => m.movementType === 'OUT')!;
    expect(out.lineItems[0].quantityChanged).toBe(-5);

    const r1 = await db.get<ProductDoc>(productIdOf(bid, 'R1'));
    expect(r1.currentWeightKg).toBe(15);
    const batch = await db.get<BatchDoc>(bid);
    expect(batch.currentUnits).toBe(2); // both rolls still non-empty
  });

  it('emptying a roll decrements the batch roll count', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await checkout(db, {
      transactionId: 'tx-empty',
      createdAt: new Date().toISOString(),
      clientId: null,
      isOnTheBooks: false,
      exchangeRateBCV: RATE,
      creditTerms: null,
      operatorId: 'op',
      lines: [rollLine(bid, 'R1', 20, 8)],
      payments: { paidUsdCash: 160, paidUsdTransfer: 0, paidBs: 0 },
    });
    const batch = await db.get<BatchDoc>(bid);
    expect(batch.currentUnits).toBe(1);
    const r1 = await db.get<ProductDoc>(productIdOf(bid, 'R1'));
    expect(r1.currentWeightKg).toBe(0);
  });
});

// bulkDocs is per-document, not transactional: the sale and the movement land
// while a counter 409s against a concurrent write. That loser used to be dropped
// forever — the retry re-found the sale it had just written and returned it — so
// the roll kept its full weight while the batch lost a unit, with no conflicting
// rev anywhere for the watcher to heal.
describe('checkout — a counter that loses a 409 is re-applied, not dropped', () => {
  it('fully selling a roll whose rev is bumped mid-write still empties it, exactly once', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    const pid = productIdOf(bid, 'R1');

    const orig = db.bulkDocs.bind(db);
    let tripped = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).bulkDocs = async (docs: any, ...rest: any[]) => {
      if (tripped || !Array.isArray(docs) || docs.length < 3) return orig(docs, ...rest);
      tripped = true;
      // A concurrent write bumps the roll's rev between checkout's read and its
      // write; the roll's write therefore conflicts while everything else lands.
      await orig([{ ...((await db.get(pid)) as object) }] as never);
      const landed = await orig(docs.filter((d: any) => d._id !== pid), ...rest);
      const byId = new Map((landed as any[]).map((r) => [r.id, r]));
      return docs.map((d: any) =>
        d._id === pid ? { id: pid, error: true, status: 409, name: 'conflict' } : byId.get(d._id),
      );
    };

    await checkout(db, {
      transactionId: 'tx-409',
      createdAt: new Date().toISOString(),
      clientId: null,
      isOnTheBooks: false,
      exchangeRateBCV: RATE,
      creditTerms: null,
      operatorId: 'op',
      lines: [rollLine(bid, 'R1', 20, 8)], // the whole roll
      payments: { paidUsdCash: 160, paidUsdTransfer: 0, paidBs: 0 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).bulkDocs = orig;

    expect(tripped).toBe(true); // the interleave actually fired
    expect(await getSales(db)).toHaveLength(1); // sale written once
    expect((await getMovements(db)).filter((m) => m.movementType === 'OUT')).toHaveLength(1);

    const r1 = await db.get<ProductDoc>(pid);
    expect(r1.currentWeightKg).toBe(0); // the deduction landed on the fresh rev
    const batch = await db.get<BatchDoc>(bid);
    expect(batch.currentUnits).toBe(1); // 2 → 1: the transition counted ONCE
  });
});

describe('checkout — idempotency', () => {
  it('same transactionId twice → one sale, single deduction', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    const input = {
      transactionId: 'tx-idem',
      createdAt: '2026-07-13T10:00:00.000Z',
      clientId: null,
      isOnTheBooks: false,
      exchangeRateBCV: RATE,
      creditTerms: null,
      operatorId: 'op',
      lines: [rollLine(bid, 'R1', 5, 8)],
      payments: { paidUsdCash: 40, paidUsdTransfer: 0, paidBs: 0 },
    };
    const a = await checkout(db, input);
    const b = await checkout(db, input);
    expect(a._id).toBe(b._id);

    const sales = await getSales(db);
    expect(sales).toHaveLength(1);
    const r1 = await db.get<ProductDoc>(productIdOf(bid, 'R1'));
    expect(r1.currentWeightKg).toBe(15); // deducted once
  });
});

describe('checkout — rejections', () => {
  it('rejects insufficient stock', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await expect(
      checkout(db, {
        transactionId: 'tx-over',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [rollLine(bid, 'R1', 999, 8)],
        payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/insuficiente/i);
  });

  it('rejects unit-of-measure mismatch (Units on a ROLL batch)', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await expect(
      checkout(db, {
        transactionId: 'tx-mismatch',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [unitLine(bid, 2, 8)],
        payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/unidad/i);
  });

  it('rejects a fractional quantity on a Units line', async () => {
    const db = makeTestDb();
    await ingressStock(db, {
      color: 'Blanco', nm: '30', fabricType: 'Piqué', productType: 'COMBO', operatorId: 'op',
      units: 10, unitPurchaseValueUsd: 1, unitSalePriceUsd: 2,
    });
    const bid = batchIdOf('Blanco', '30', 'Piqué');
    await expect(
      checkout(db, {
        transactionId: 'tx-half-combo',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [unitLine(bid, 2.5, 8)],
        payments: { paidUsdCash: 20, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/entero/i);
    expect(await getSales(db)).toHaveLength(0);
  });

  it('rejects credit sales (not fully paid) with no client selected', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await expect(
      checkout(db, {
        transactionId: 'tx-credit-no-client',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [rollLine(bid, 'R1', 5, 8)],
        payments: { paidUsdCash: 10, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/crédito requieren un cliente/i);
  });

  it('rejects rate <= 0 and empty cart', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await expect(
      checkout(db, {
        transactionId: 'tx-rate',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: false,
        exchangeRateBCV: 0,
        creditTerms: null,
        operatorId: 'op',
        lines: [rollLine(bid, 'R1', 1, 8)],
        payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/tasa/i);
  });
});
