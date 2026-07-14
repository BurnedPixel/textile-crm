import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import { getSales, getMovements } from './queries';
import { batchIdOf, productIdOf, type CartLineItem, type ProductDoc, type BatchDoc } from './types';

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
      isOnTheBooks: true,
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
      isOnTheBooks: true,
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

describe('checkout — idempotency', () => {
  it('same transactionId twice → one sale, single deduction', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    const input = {
      transactionId: 'tx-idem',
      createdAt: '2026-07-13T10:00:00.000Z',
      clientId: null,
      isOnTheBooks: true,
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
        isOnTheBooks: true,
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
        isOnTheBooks: true,
        exchangeRateBCV: RATE,
        creditTerms: null,
        operatorId: 'op',
        lines: [unitLine(bid, 2, 8)],
        payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/unidad/i);
  });

  it('rejects rate <= 0 and empty cart', async () => {
    const db = makeTestDb();
    const bid = await seedRollBatch(db);
    await expect(
      checkout(db, {
        transactionId: 'tx-rate',
        createdAt: new Date().toISOString(),
        clientId: null,
        isOnTheBooks: true,
        exchangeRateBCV: 0,
        creditTerms: null,
        operatorId: 'op',
        lines: [rollLine(bid, 'R1', 1, 8)],
        payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
      }),
    ).rejects.toThrow(/tasa/i);
  });
});
