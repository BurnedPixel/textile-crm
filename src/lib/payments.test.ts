import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import { recordPayment, getPayments, paymentsBySale, saleBalance } from './payments';
import { batchIdOf, productIdOf, type CartLineItem, type SaleDoc } from './types';

const RATE = 36.5;

function rollLine(batchId: string, pieceId: string, qty: number, price: number): CartLineItem {
  return {
    productId: productIdOf(batchId, pieceId),
    batchId,
    description: 'x',
    quantity: qty,
    unitOfMeasure: 'Kg',
    unitPriceAtSale: price,
    lineSubtotalUsd: 0,
  };
}

/** A $100 credit sale with nothing paid at checkout. */
async function creditSale(db: PouchDB.Database, paid = 0): Promise<SaleDoc> {
  const bid = batchIdOf('Azul', '30', 'Jersey');
  await ingressStock(db, {
    color: 'Azul', nm: '30', fabricType: 'Jersey', productType: 'ROLL', operatorId: 'op',
    rolls: [{ pieceId: 'R1', weightKg: 50, purchaseValueUsd: 5, salePriceUsd: 10 }],
  });
  return checkout(db, {
    transactionId: 'tx-credit', createdAt: new Date().toISOString(), clientId: 'client:v-1',
    isOnTheBooks: true, exchangeRateBCV: RATE, creditTerms: '30 días', operatorId: 'op',
    lines: [rollLine(bid, 'R1', 10, 10)],
    payments: { paidUsdCash: paid, paidUsdTransfer: 0, paidBs: 0 },
  });
}

describe('saleBalance — the derived truth about what is owed', () => {
  it('with no collections, reduces to the sale\'s own checkout figures', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 40);
    const b = saleBalance(sale, []);
    expect(b.paidUsd).toBe(40);
    expect(b.owedUsd).toBe(60);
    expect(b.status).toBe('PARTIAL');
  });

  it('a later collection settles the sale even though sale.paymentStatus still says PENDING', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    expect(sale.paymentStatus).toBe('PENDING'); // frozen at checkout, forever

    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 100, paidUsdTransfer: 0, paidBs: 0,
    });

    const payments = await getPayments(db, { saleId: sale._id });
    const b = saleBalance(sale, payments);
    expect(b.owedUsd).toBe(0);
    expect(b.status).toBe('PAID');
    // The sale document itself was NOT touched — it is immutable. Still at rev
    // generation 1, i.e. written once and never updated.
    const reread = (await db.get(sale._id)) as SaleDoc;
    expect(reread.paymentStatus).toBe('PENDING');
    expect(reread._rev?.startsWith('1-')).toBe(true);
  });

  it('converts each Bs collection at ITS OWN locked rate, not the sale\'s', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db); // $100 owed, sale rate 36.5
    // Bs 3650 at the sale's rate would be $100. Collected later at 73 Bs/$ it is $50.
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: 73, operatorId: 'op',
      paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 3650,
    });
    const b = saleBalance(sale, await getPayments(db));
    expect(b.paidUsd).toBe(50);
    expect(b.owedUsd).toBe(50);
    expect(b.status).toBe('PARTIAL');
  });

  it('sums several collections across channels', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 30, paidUsdTransfer: 0, paidBs: 0,
    });
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 0, paidUsdTransfer: 20, paidBs: 36.5, // + $1
    });
    const b = saleBalance(sale, await getPayments(db));
    expect(b.paidUsd).toBe(51);
    expect(b.owedUsd).toBe(49);
  });
});

describe('recordPayment — boundary validation', () => {
  it('rejects a collection larger than the outstanding balance', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    await expect(
      recordPayment(db, {
        saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
        paidUsdCash: 1000, paidUsdTransfer: 0, paidBs: 0, // an extra digit
      }),
    ).rejects.toThrow(/excede el saldo pendiente/);
    expect(await getPayments(db)).toHaveLength(0);
  });

  it('counts earlier collections when checking the balance', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 60, paidUsdTransfer: 0, paidBs: 0,
    });
    await expect(
      recordPayment(db, {
        saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
        paidUsdCash: 60, paidUsdTransfer: 0, paidBs: 0, // only 40 left
      }),
    ).rejects.toThrow(/excede el saldo pendiente/);
  });

  it('rejects zero, negative and rate-less collections, and unknown sales', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    const base = { saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op', paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 };
    await expect(recordPayment(db, base)).rejects.toThrow(/mayor que cero/);
    await expect(recordPayment(db, { ...base, paidUsdCash: -5 })).rejects.toThrow(/negativos/);
    await expect(recordPayment(db, { ...base, exchangeRateBCV: 0, paidUsdCash: 10 })).rejects.toThrow(/tasa de cambio/);
    await expect(
      recordPayment(db, { ...base, saleId: 'sale:nope', paidUsdCash: 10 }),
    ).rejects.toThrow(/Venta no encontrada/);
  });

  it('never writes a derived amountBs field (the validation layer would reject it)', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    const payment = await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 365,
    });
    expect(payment).not.toHaveProperty('amountBs');
    expect(payment).not.toHaveProperty('totalBs');
    expect(payment.paidBs).toBe(365);
  });
});

describe('paymentsBySale', () => {
  it('groups by saleId and leaves unpaid sales absent', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 10, paidUsdTransfer: 0, paidBs: 0,
    });
    const bySale = paymentsBySale(await getPayments(db));
    expect(bySale.get(sale._id)).toHaveLength(1);
    expect(bySale.get('sale:other')).toBeUndefined();
    // A sale with no collections must still balance — the Map returns undefined.
    expect(saleBalance(sale, bySale.get('sale:other')).owedUsd).toBe(100);
  });
});
