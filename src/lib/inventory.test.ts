import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock, adjustStock } from './inventory';
import { checkout } from './checkout';
import { getMovements } from './queries';
import { batchIdOf, productIdOf, type CartLineItem, type ProductDoc, type BatchDoc } from './types';

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

// The critical finding: after a roll sells out, a NEW pieceId must create a new
// roll doc (not refill the empty one). Verifies ingressStock treats a fresh
// pieceId as a create and bumps currentUnits, leaving the sold-out roll intact.
describe('ingressStock — fresh pieceId after sellout creates a new roll', () => {
  it('does not clobber a sold-out roll and increments the batch count', async () => {
    const db = makeTestDb();
    const bid = batchIdOf('Negro', '24', 'Rib');
    await ingressStock(db, {
      color: 'Negro', nm: '24', fabricType: 'Rib', productType: 'ROLL', operatorId: 'op',
      rolls: [
        { pieceId: 'R1', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
        { pieceId: 'R2', weightKg: 20, purchaseValueUsd: 5, salePriceUsd: 8 },
      ],
    });
    // Sell R1 to zero → currentUnits drops from 2 to 1.
    await checkout(db, {
      transactionId: 'tx', createdAt: new Date().toISOString(), clientId: null,
      isOnTheBooks: true, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [rollLine(bid, 'R1', 20)],
      payments: { paidUsdCash: 160, paidUsdTransfer: 0, paidBs: 0 },
    });
    const afterSale = (await db.get(bid)) as BatchDoc;
    expect(afterSale.currentUnits).toBe(1);

    // Ingress a NEW roll R3 (correct id, past the max). R1 must stay at 0.
    await ingressStock(db, {
      color: 'Negro', nm: '24', fabricType: 'Rib', productType: 'ROLL', operatorId: 'op',
      rolls: [{ pieceId: 'R3', weightKg: 15, purchaseValueUsd: 5, salePriceUsd: 8 }],
    });
    const r1 = (await db.get(productIdOf(bid, 'R1'))) as ProductDoc;
    const r3 = (await db.get(productIdOf(bid, 'R3'))) as ProductDoc;
    const batch = (await db.get(bid)) as BatchDoc;
    expect(r1.currentWeightKg).toBe(0); // sold-out roll untouched
    expect(r3.currentWeightKg).toBe(15); // new roll created
    expect(batch.currentUnits).toBe(2); // R2 + R3
  });
});

// The counter-409 finding: a concurrent local write bumps the counter _rev
// between our read and our write. The retry must re-read and re-apply the delta,
// not drop it. Simulated by failing the counter write once with a 409.
describe('ingressStock/adjustStock — counter 409 retries instead of dropping the delta', () => {
  it('adjustStock lands the delta after a one-shot 409 on the counter', async () => {
    const db = makeTestDb();
    const bid = batchIdOf('Blanco', '30', 'Jersey');
    await ingressStock(db, {
      color: 'Blanco', nm: '30', fabricType: 'Jersey', productType: 'COMBO', operatorId: 'op',
      units: 10, unitPurchaseValueUsd: 1, unitSalePriceUsd: 2,
    });

    // Fail the FIRST bulkDocs at the counter slot with a 409, exactly as a
    // concurrent write would: the movement (index 0) commits, but the counter
    // (index 1) is NOT written and reports conflict — so the old rev survives and
    // the retry must re-read it and re-apply the +5 on top.
    const orig = db.bulkDocs.bind(db);
    let tripped = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).bulkDocs = async (docs: any[], ...rest: any[]) => {
      if (!tripped && docs.length > 1) {
        tripped = true;
        const committed = await orig(docs.slice(0, 1), ...rest); // movement only
        return [
          ...committed,
          { id: docs[1]._id, error: true, status: 409, name: 'conflict' },
        ];
      }
      return orig(docs, ...rest);
    };

    await adjustStock(db, {
      batchId: bid, productId: productIdOf(bid, 'stock'),
      quantityChanged: 5, operatorId: 'op', reason: 'recount',
    });
    (db as any).bulkDocs = orig; // eslint-disable-line @typescript-eslint/no-explicit-any

    const batch = (await db.get(bid)) as BatchDoc;
    expect(batch.currentUnits).toBe(15); // 10 + 5, delta not lost
    const movements = await getMovements(db, { limit: 50 });
    expect(movements.filter((m) => m.movementType === 'ADJUST')).toHaveLength(1); // no dup ledger
  });
});
