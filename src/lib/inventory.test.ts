import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import {
  ingressStock, adjustStock, returnStock, returnPieceId, updateRollDetails,
  RETURN_REASON, EXCHANGE_REASON,
} from './inventory';
import { checkout } from './checkout';
import { getMovements } from './queries';
import { recomputeBatchCounters } from './conflicts';
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
      isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
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

// The builder-erasure finding: buildRoll rebuilds the doc from an explicit field
// list with no spread, so anything it does not name is WIPED by the next ingress
// onto the same roll. Lot metadata is optional and often omitted on a top-up —
// it has to survive that, and a newly typed lot number has to win.
describe('ingressStock — optional lot metadata survives a later ingress', () => {
  const ARTICLE = { color: 'Rojo Vino', nm: '30', fabricType: 'Piqué', productType: 'ROLL' as const, operatorId: 'op' };
  const roll = (weightKg: number) => [{ pieceId: 'R1', weightKg, purchaseValueUsd: 5, salePriceUsd: 8 }];

  it('carries lot/pantone/composición forward, and a new lot number overrides', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ARTICLE.color, ARTICLE.nm, ARTICLE.fabricType);
    await ingressStock(db, {
      ...ARTICLE,
      lotNumber: '4471', pantone: '19-4052 TCX', fiberComposition: '100% algodón',
      rolls: roll(20),
    });

    // Top up the SAME roll with no metadata typed — nothing may be erased.
    await ingressStock(db, { ...ARTICLE, rolls: roll(5) });
    const kept = (await db.get(productIdOf(bid, 'R1'))) as ProductDoc;
    expect(kept.currentWeightKg).toBe(25);
    expect(kept.lotNumber).toBe('4471');
    expect(kept.pantone).toBe('19-4052 TCX');
    expect(kept.fiberComposition).toBe('100% algodón');

    // More fabric of a DIFFERENT lot onto the same roll id: the new number wins,
    // the fields not retyped stay.
    await ingressStock(db, { ...ARTICLE, lotNumber: '4482', rolls: roll(5) });
    const updated = (await db.get(productIdOf(bid, 'R1'))) as ProductDoc;
    expect(updated.lotNumber).toBe('4482');
    expect(updated.pantone).toBe('19-4052 TCX');
  });

  it('stores nothing for a blank lot number (legacy rolls stay S/L)', async () => {
    const db = makeTestDb();
    const bid = batchIdOf('Blanco', '24', 'Jersey');
    await ingressStock(db, {
      color: 'Blanco', nm: '24', fabricType: 'Jersey', productType: 'ROLL', operatorId: 'op',
      lotNumber: '   ',
      rolls: roll(10),
    });
    const p = (await db.get(productIdOf(bid, 'R1'))) as ProductDoc;
    expect(p.lotNumber).toBeUndefined();
  });
});

// The same builder-erasure finding, one level up: colorCode lives on the BATCH,
// and ingressStock's buildBatch is the one batch builder that rebuilds from an
// explicit field list. Everything else that writes a batch (returnStock,
// adjustStock, recomputeBatchCounters) spreads the current doc — these tests are
// what would catch any of them being rewritten as a rebuild later.
describe('ingressStock — the colour-chart code survives every batch rewrite', () => {
  const ARTICLE = { color: 'Rosa Pastel', nm: '30', fabricType: 'Jersey', productType: 'ROLL' as const, operatorId: 'op' };
  const bid = batchIdOf(ARTICLE.color, ARTICLE.nm, ARTICLE.fabricType);
  const roll = (pieceId: string, weightKg: number) =>
    [{ pieceId, weightKg, purchaseValueUsd: 5, salePriceUsd: 8 }];

  it('stores the code, carries it through a later ingress, and lets a new code win', async () => {
    const db = makeTestDb();
    await ingressStock(db, { ...ARTICLE, colorCode: '115', lotNumber: '4471', rolls: roll('R1', 20) });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('115');

    // A top-up with the field left blank must not erase it.
    await ingressStock(db, { ...ARTICLE, rolls: roll('R2', 10) });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('115');

    // A corrected code wins.
    await ingressStock(db, { ...ARTICLE, colorCode: '215', rolls: roll('R3', 10) });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('215');
  });

  it('an explicit empty string CLEARS a stored code — absent ≠ blank', async () => {
    // Another ingress is the only batch-level write path, so a mistyped code
    // that a blank could not clear would be permanent.
    const db = makeTestDb();
    await ingressStock(db, { ...ARTICLE, colorCode: '115', rolls: roll('R1', 20) });
    await ingressStock(db, { ...ARTICLE, colorCode: '', rolls: roll('R2', 10) });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBeUndefined();
  });

  it('stores nothing for a blank code (articles with no chart entry)', async () => {
    const db = makeTestDb();
    await ingressStock(db, { ...ARTICLE, colorCode: '   ', rolls: roll('R1', 10) });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBeUndefined();
  });

  it('rejects an over-long code at the module boundary, in Spanish', async () => {
    const db = makeTestDb();
    await expect(
      ingressStock(db, { ...ARTICLE, colorCode: '1'.repeat(13), rolls: roll('R1', 10) }),
    ).rejects.toThrow(/código de color no puede superar 12 caracteres/i);
  });

  it('survives adjustStock, returnStock and a rebuild from the ledger', async () => {
    const db = makeTestDb();
    await ingressStock(db, { ...ARTICLE, colorCode: '315', lotNumber: '9001', rolls: roll('R1', 20) });

    await adjustStock(db, {
      batchId: bid, productId: productIdOf(bid, 'R1'), quantityChanged: -20,
      operatorId: 'op', reason: 'merma',
    });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('315');

    await returnStock(db, {
      returnId: 'cccc1111-2222-3333-4444-555555555555',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 3,
      operatorId: 'op',
    });
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('315');

    await recomputeBatchCounters(db, bid);
    expect(((await db.get(bid)) as BatchDoc).colorCode).toBe('315');
  });
});

// ─── The counter guard: currentUnits tracks empty→non-empty TRANSITIONS ───────
//
// The old rule was "the product document did not exist". That is a different
// question: checkout drops a roll off the count the moment it hits empty, so
// refilling a sold-out roll puts a roll back on the shelf without creating any
// document — and the batch stayed one short, silently, forever.

const ROLL_ARTICLE = {
  color: 'Verde', nm: '30', fabricType: 'Jersey', productType: 'ROLL' as const, operatorId: 'op',
};
const rollsOf = (...rows: Array<[string, number]>) =>
  rows.map(([pieceId, weightKg]) => ({ pieceId, weightKg, purchaseValueUsd: 5, salePriceUsd: 8 }));

describe('ingressStock — the batch roll count follows empty↔non-empty transitions', () => {
  it('refilling a SOLD-OUT roll puts it back on the count without creating a document', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20]) });
    await checkout(db, {
      transactionId: 'tx-empty', createdAt: new Date().toISOString(), clientId: null,
      isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [rollLine(bid, 'R1', 20)],
      payments: { paidUsdCash: 160, paidUsdTransfer: 0, paidBs: 0 },
    });
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(0);

    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 10]) });
    const batch = (await db.get(bid)) as BatchDoc;
    expect(batch.currentUnits).toBe(1); // back on the shelf
    expect(batch.initialUnitCount).toBe(1); // still ONE roll ever received
    expect(((await db.get(productIdOf(bid, 'R1'))) as ProductDoc).currentWeightKg).toBe(10);
  });

  it('topping up a roll that still has fabric does not count it twice', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20]) });
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 5]) });
    const batch = (await db.get(bid)) as BatchDoc;
    expect(batch.currentUnits).toBe(1);
    expect(((await db.get(productIdOf(bid, 'R1'))) as ProductDoc).currentWeightKg).toBe(25);
  });

  it('two rows carrying the SAME pieceId in one call count one roll, not two', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 10], ['R1', 5]) });
    const batch = (await db.get(bid)) as BatchDoc;
    expect(batch.currentUnits).toBe(1);
    expect(batch.initialUnitCount).toBe(1);
    // Both deltas still land — the second write loses on _id and re-applies.
    expect(((await db.get(productIdOf(bid, 'R1'))) as ProductDoc).currentWeightKg).toBe(15);
  });
});

describe('adjustStock — a ROLL adjustment maintains the batch roll count', () => {
  it('adjusting a roll to zero drops it from the count, and back off zero restores it', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20], ['R2', 20]) });
    const productId = productIdOf(bid, 'R1');

    await adjustStock(db, {
      batchId: bid, productId, quantityChanged: -20, operatorId: 'op', reason: 'merma',
    });
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(1);

    await adjustStock(db, {
      batchId: bid, productId, quantityChanged: 3, operatorId: 'op', reason: 'reconteo',
    });
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(2);
  });

  it('an adjustment that does not cross zero leaves the count alone', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20]) });
    await adjustStock(db, {
      batchId: bid, productId: productIdOf(bid, 'R1'),
      quantityChanged: -5, operatorId: 'op', reason: 'merma',
    });
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(1);
  });
});

// ─── Devoluciones + cambios por garantía ─────────────────────────────────────

describe('returnStock — a returned roll becomes its own document', () => {
  const setup = async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, {
      ...ROLL_ARTICLE,
      lotNumber: '7252', pantone: '18-0135 TCX', fiberComposition: '100% algodón',
      rolls: rollsOf(['R1', 20], ['R2', 20]),
    });
    return { db, bid };
  };

  it('accepts a return of a roll that was sold to zero, carrying its lot and prices', async () => {
    const { db, bid } = await setup();
    await checkout(db, {
      transactionId: 'tx-sold', createdAt: new Date().toISOString(), clientId: null,
      isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [rollLine(bid, 'R1', 20)],
      payments: { paidUsdCash: 160, paidUsdTransfer: 0, paidBs: 0 },
    });
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(1); // only R2 left

    const movement = await returnStock(db, {
      returnId: 'aaaa1111-2222-3333-4444-555555555555',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 6,
      operatorId: 'op',
      referenceId: 'tx-sold',
    });

    const pieceId = returnPieceId('R1', 'aaaa1111-2222-3333-4444-555555555555');
    const returned = (await db.get(productIdOf(bid, pieceId))) as ProductDoc;
    expect(returned.currentWeightKg).toBe(6);
    expect(returned.conditionTag).toBe('DEFECT'); // Fallado by default — it warns, it does not block
    expect(returned.salePriceUsd).toBe(8); // carried from the roll it came off, never zeroed
    expect(returned.purchaseValueUsd).toBe(5);
    expect(returned.lotNumber).toBe('7252'); // the returned fabric is still that lot
    expect(returned.pantone).toBe('18-0135 TCX');

    // The sold-out original is untouched; the batch gains one roll back.
    expect(((await db.get(productIdOf(bid, 'R1'))) as ProductDoc).currentWeightKg).toBe(0);
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(2);

    expect(movement.reason).toBe(RETURN_REASON);
    expect(movement.movementType).toBe('IN');
    expect(movement.referenceId).toBe('tx-sold');
    expect(movement.lineItems).toHaveLength(1);
    expect(movement.lineItems[0].quantityChanged).toBe(6);
  });

  it('is idempotent on returnId — a double tap credits stock once', async () => {
    const { db, bid } = await setup();
    const input = {
      returnId: 'bbbb1111-2222-3333-4444-555555555555',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 4,
      operatorId: 'op',
    };
    const first = await returnStock(db, input);
    const second = await returnStock(db, input);
    expect(second._id).toBe(first._id);

    const pieceId = returnPieceId('R1', input.returnId);
    expect(((await db.get(productIdOf(bid, pieceId))) as ProductDoc).currentWeightKg).toBe(4);
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(3); // R1 + R2 + the return
    const ins = (await getMovements(db, { limit: 50 })).filter((m) => m.reason === RETURN_REASON);
    expect(ins).toHaveLength(1);
  });

  it('gives a SECOND return of the same roll its own document, not the first one fattened', async () => {
    const { db, bid } = await setup();
    const base = {
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 3,
      operatorId: 'op',
    };
    await returnStock(db, { ...base, returnId: 'cccc1111-2222-3333-4444-555555555555' });
    await returnStock(db, { ...base, returnId: 'dddd1111-2222-3333-4444-555555555555' });

    const a = returnPieceId('R1', 'cccc1111-2222-3333-4444-555555555555');
    const b = returnPieceId('R1', 'dddd1111-2222-3333-4444-555555555555');
    expect(a).not.toBe(b);
    expect(((await db.get(productIdOf(bid, a))) as ProductDoc).currentWeightKg).toBe(3);
    expect(((await db.get(productIdOf(bid, b))) as ProductDoc).currentWeightKg).toBe(3);
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(4); // R1 + R2 + two returns
  });

  it('refuses a return against a COMBO article', async () => {
    const db = makeTestDb();
    const bid = batchIdOf('Blanco', '30', 'Combo');
    await ingressStock(db, {
      color: 'Blanco', nm: '30', fabricType: 'Combo', productType: 'COMBO', operatorId: 'op',
      units: 10, unitPurchaseValueUsd: 1, unitSalePriceUsd: 2,
    });
    await expect(
      returnStock(db, {
        returnId: 'eeee1111-2222-3333-4444-555555555555',
        date: new Date().toISOString(),
        productId: productIdOf(bid, 'stock'),
        weightKg: 2,
        operatorId: 'op',
      }),
    ).rejects.toThrow(/rollos/i);
  });
});

describe('returnStock — an exchange writes both legs in ONE movement', () => {
  it('credits the returned roll and deducts the replacement atomically', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20], ['R2', 20]) });

    const movement = await returnStock(db, {
      returnId: 'ffff1111-2222-3333-4444-555555555555',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 5,
      operatorId: 'op',
      referenceId: 'tx-garantia',
      replacement: { productId: productIdOf(bid, 'R2'), weightKg: 5 },
    });

    expect(movement.reason).toBe(EXCHANGE_REASON);
    expect(movement.lineItems).toHaveLength(1 + 1);
    expect(movement.lineItems.map((l) => l.quantityChanged)).toEqual([5, -5]);

    const pieceId = returnPieceId('R1', 'ffff1111-2222-3333-4444-555555555555');
    expect(((await db.get(productIdOf(bid, pieceId))) as ProductDoc).currentWeightKg).toBe(5);
    expect(((await db.get(productIdOf(bid, 'R2'))) as ProductDoc).currentWeightKg).toBe(15);
    // Same batch, both legs: ONE counter write holding the net (+1 returned roll,
    // R2 still has fabric so nothing comes off).
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(3);
  });

  it('emptying the replacement roll takes it off the batch count in the same write', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20], ['R2', 5]) });

    await returnStock(db, {
      returnId: '11112222-3333-4444-5555-666666666666',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'),
      weightKg: 5,
      operatorId: 'op',
      replacement: { productId: productIdOf(bid, 'R2'), weightKg: 5 },
    });

    expect(((await db.get(productIdOf(bid, 'R2'))) as ProductDoc).currentWeightKg).toBe(0);
    // +1 for the returned roll, −1 for the emptied replacement → back to 2.
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(2);
  });

  it('refuses a replacement that does not have the weight', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20], ['R2', 2]) });
    await expect(
      returnStock(db, {
        returnId: '22223333-4444-5555-6666-777777777777',
        date: new Date().toISOString(),
        productId: productIdOf(bid, 'R1'),
        weightKg: 5,
        operatorId: 'op',
        replacement: { productId: productIdOf(bid, 'R2'), weightKg: 5 },
      }),
    ).rejects.toThrow(/insuficiente/i);
    // Nothing partially written.
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(2);
  });
});

// The cached counter is only ever a cache: recomputeBatchCounters rebuilding it
// from the movement ledger must land on the SAME number. Anything that drifts
// here is invisible until a sync conflict happens to fire the recompute.
describe('returnStock — the cached counter agrees with a rebuild from the ledger', () => {
  const rebuiltUnits = async (db: PouchDB.Database, bid: string) => {
    await recomputeBatchCounters(db, bid);
    return ((await db.get(bid)) as BatchDoc).currentUnits;
  };

  it('agrees after a return, an exchange, and an exchange that empties the replacement', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20], ['R2', 20], ['R3', 5]) });

    await returnStock(db, {
      returnId: '33334444-5555-6666-7777-888888888888',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R1'), weightKg: 7, operatorId: 'op',
    });
    let cached = ((await db.get(bid)) as BatchDoc).currentUnits;
    expect(cached).toBe(4);
    expect(await rebuiltUnits(db, bid)).toBe(cached);

    await returnStock(db, {
      returnId: '44445555-6666-7777-8888-999999999999',
      date: new Date().toISOString(),
      productId: productIdOf(bid, 'R2'), weightKg: 3, operatorId: 'op',
      replacement: { productId: productIdOf(bid, 'R3'), weightKg: 5 }, // empties R3
    });
    cached = ((await db.get(bid)) as BatchDoc).currentUnits;
    expect(cached).toBe(4); // +1 returned roll, −1 emptied R3
    expect(await rebuiltUnits(db, bid)).toBe(cached);
  });

  it('refuses a return so small it would store as an empty roll', async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, { ...ROLL_ARTICLE, rolls: rollsOf(['R1', 20]) });

    // round2(0.002) is 0 — the roll would arrive empty and the kilos would be
    // lost, while the batch counted a roll the ledger rebuild does not.
    await expect(
      returnStock(db, {
        returnId: '55556666-7777-8888-9999-aaaaaaaaaaaa',
        date: new Date().toISOString(),
        productId: productIdOf(bid, 'R1'), weightKg: 0.002, operatorId: 'op',
      }),
    ).rejects.toThrow(/demasiado pequeño/i);

    const batch = (await db.get(bid)) as BatchDoc;
    expect(batch.currentUnits).toBe(1);
    expect(await rebuiltUnits(db, bid)).toBe(1);
  });
});

// ─── Correcting a roll's details ─────────────────────────────────────────────
//
// The whole point of keeping the lot number OUT of the _id: correcting a
// mistyped one is an ordinary field write, with no migration and no dangling
// reference in the frozen sale history.

describe('updateRollDetails — corrects what is written on a roll, never its weight', () => {
  const setup = async () => {
    const db = makeTestDb();
    const bid = batchIdOf(ROLL_ARTICLE.color, ROLL_ARTICLE.nm, ROLL_ARTICLE.fabricType);
    await ingressStock(db, {
      ...ROLL_ARTICLE,
      lotNumber: '7250', pantone: '18-0135 TCX', fiberComposition: '100% algodón',
      rolls: rollsOf(['R1', 20]),
    });
    return { db, bid, productId: productIdOf(bid, 'R1') };
  };

  it('fixes a mistyped lot number without touching anything else', async () => {
    const { db, productId } = await setup();
    const updated = await updateRollDetails(db, { productId, lotNumber: '7252' });
    expect(updated.lotNumber).toBe('7252');
    expect(updated.pantone).toBe('18-0135 TCX');       // untouched
    expect(updated.fiberComposition).toBe('100% algodón');
    expect(updated.currentWeightKg).toBe(20);          // weight is the ledger's job
    expect(updated.salePriceUsd).toBe(8);
  });

  it('clears an optional field back to S/L when it is emptied', async () => {
    const { db, productId } = await setup();
    const updated = await updateRollDetails(db, { productId, lotNumber: '  ' });
    expect(updated.lotNumber).toBeUndefined();
    expect(updated.pantone).toBe('18-0135 TCX');
  });

  it('updates prices and condition, and rejects a nonsense price', async () => {
    const { db, productId } = await setup();
    const updated = await updateRollDetails(db, {
      productId, purchaseValueUsd: 6.25, salePriceUsd: 9.9, conditionTag: 'SECONDS',
    });
    expect(updated.purchaseValueUsd).toBe(6.25);
    expect(updated.salePriceUsd).toBe(9.9);
    expect(updated.conditionTag).toBe('SECONDS');

    await expect(updateRollDetails(db, { productId, salePriceUsd: Number.POSITIVE_INFINITY }))
      .rejects.toThrow(/precio de venta/i);
    await expect(updateRollDetails(db, { productId, lotNumber: 'x'.repeat(200) }))
      .rejects.toThrow(/lote/i);
  });

  it('refuses a roll that does not exist', async () => {
    const { db } = await setup();
    await expect(updateRollDetails(db, { productId: 'product:nope:r9', lotNumber: '1' }))
      .rejects.toThrow(/no encontrado/i);
  });

  it('leaves the cached counter agreeing with the ledger', async () => {
    const { db, bid, productId } = await setup();
    await updateRollDetails(db, { productId, lotNumber: '9999', salePriceUsd: 12 });
    const before = ((await db.get(bid)) as BatchDoc).currentUnits;
    await recomputeBatchCounters(db, bid);
    expect(((await db.get(bid)) as BatchDoc).currentUnits).toBe(before);
  });
});
