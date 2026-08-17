import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { ingressStock } from './inventory';
import { checkout } from './checkout';
import {
  recordPayment, getPayments, paymentsBySale, saleBalance,
  recordRefund, getRefunds, refundsBySale, clientBalance,
} from './payments';
import { refundIdOf } from './types';
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
    isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: '30 días', operatorId: 'op',
    lines: [rollLine(bid, 'R1', 10, 10)],
    payments: { paidUsdCash: paid, paidUsdTransfer: 0, paidBs: 0 },
  });
}

describe('saleBalance — the derived truth about what is owed', () => {
  it('with no collections, reduces to the sale\'s own checkout figures', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 40);
    const b = saleBalance(sale, [], []);
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
    const b = saleBalance(sale, payments, []);
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
    const b = saleBalance(sale, await getPayments(db), []);
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
    const b = saleBalance(sale, await getPayments(db), []);
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

  it('is idempotent on the dialog-minted uid+date — a double submit returns the same doc', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db); // $100 owed
    const minted = { date: new Date().toISOString(), paymentUid: 'uid-dialog-1' };
    const first = await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 40, paidUsdTransfer: 0, paidBs: 0, ...minted, // PARTIAL: overpay guard doesn't apply
    });
    const second = await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 40, paidUsdTransfer: 0, paidBs: 0, ...minted,
    });
    expect(second._id).toBe(first._id);
    expect(await getPayments(db)).toHaveLength(1); // $40 collected once, not twice
  });

  it('rejects zero, negative and rate-less collections, and unknown sales', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db);
    const base = { saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op', paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 };
    await expect(recordPayment(db, base)).rejects.toThrow(/mayor que cero/);
    await expect(recordPayment(db, { ...base, paidUsdCash: -5 })).rejects.toThrow(/no puede ser negativo/);
    await expect(recordPayment(db, { ...base, paidUsdCash: Infinity })).rejects.toThrow(/no es un número válido/);
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
    expect(saleBalance(sale, bySale.get('sale:other') ?? [], []).owedUsd).toBe(100);
  });
});

describe('vuelto — money the business owes the client', () => {
  it('an overpaid checkout derives a credit, never a negative debt', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120); // $100 sale paid with $120 cash
    const b = saleBalance(sale, [], []);
    expect(b).toEqual({ paidUsd: 120, owedUsd: 0, creditUsd: 20, status: 'PAID' });
  });

  it('recordRefund settles the credit; a fresh second refund is rejected', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120);
    await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      givenUsdCash: 20, givenUsdTransfer: 0, givenBs: 0,
    });
    const b = saleBalance(sale, [], await getRefunds(db, { saleId: sale._id }));
    expect(b.creditUsd).toBe(0);
    expect(b.status).toBe('PAID');
    await expect(
      recordRefund(db, {
        saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
        givenUsdCash: 20, givenUsdTransfer: 0, givenBs: 0,
      }),
    ).rejects.toThrow(/excede el saldo a favor/);
  });

  it('is idempotent on the dialog-minted uid+date — a double submit returns the same doc', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120);
    const minted = { date: new Date().toISOString(), refundUid: 'uid-dialog-1' };
    const first = await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      givenUsdCash: 10, givenUsdTransfer: 0, givenBs: 0, ...minted,
    });
    const second = await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      givenUsdCash: 10, givenUsdTransfer: 0, givenBs: 0, ...minted,
    });
    expect(second._id).toBe(first._id);
    expect(await getRefunds(db)).toHaveLength(1); // $10 given once, not twice
  });

  it('a forced over-refund (two devices) self-reports as an ordinary receivable', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120); // credit $20
    await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      givenUsdCash: 20, givenUsdTransfer: 0, givenBs: 0,
    });
    // Second device, offline, wrote its own doc — unique id, no conflict.
    await db.put({
      _id: refundIdOf(new Date().toISOString(), 'uuid-device-b'), type: 'refund',
      saleId: sale._id, date: new Date().toISOString(), exchangeRateBCV: RATE,
      givenUsdCash: 20, givenUsdTransfer: 0, givenBs: 0, note: '', operatorId: 'op2',
    });
    const refunds = await getRefunds(db, { saleId: sale._id });
    const b = saleBalance(sale, [], refunds);
    expect(b.owedUsd).toBe(20); // $40 handed out against a $20 credit
    expect(b.status).toBe('PARTIAL');
    // ...and the prescribed correction — an ordinary collection — is accepted.
    await recordPayment(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 20, paidUsdTransfer: 0, paidBs: 0,
    });
    const after = saleBalance(sale, await getPayments(db, { saleId: sale._id }), refunds);
    expect(after.owedUsd).toBe(0);
  });

  it('a Bs vuelto converts at the rate locked on the refund, not the sale', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120); // credit $20, sale rate 36.5
    await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: 73, operatorId: 'op',
      givenUsdCash: 0, givenUsdTransfer: 0, givenBs: 730, // $10 at ITS rate
    });
    const b = saleBalance(sale, [], await getRefunds(db, { saleId: sale._id }));
    expect(b.creditUsd).toBe(10);
  });

  it('recordPayment allows an overpaying collection only with the explicit flag', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db); // $100 owed
    const input = {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      paidUsdCash: 120, paidUsdTransfer: 0, paidBs: 0,
    };
    await expect(recordPayment(db, input)).rejects.toThrow(/excede el saldo pendiente/);
    await recordPayment(db, { ...input, allowOverpayment: true });
    const b = saleBalance(sale, await getPayments(db, { saleId: sale._id }), []);
    expect(b.creditUsd).toBe(20);
    expect(b.status).toBe('PAID');
  });

  it('a refund doc never carries derived Bs fields', async () => {
    const db = makeTestDb();
    const sale = await creditSale(db, 120);
    const refund = await recordRefund(db, {
      saleId: sale._id, exchangeRateBCV: RATE, operatorId: 'op',
      givenUsdCash: 0, givenUsdTransfer: 0, givenBs: 365,
    });
    expect(refund).not.toHaveProperty('amountBs');
    expect(refund).not.toHaveProperty('totalBs');
    expect(refund.givenBs).toBe(365);
  });

  it('clientBalance reports both directions un-netted', async () => {
    const db = makeTestDb();
    const saleA = await creditSale(db, 120); // client is owed $20 change here
    // A second sale, unpaid: the client owes $100 there. Netting would hide both.
    const bid = batchIdOf('Azul', '30', 'Jersey');
    const saleB = await checkout(db, {
      transactionId: 'tx-b', createdAt: new Date().toISOString(), clientId: 'client:v-1',
      isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: '30 días', operatorId: 'op',
      lines: [rollLine(bid, 'R1', 10, 10)],
      payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
    });
    const cb = clientBalance(
      [saleA, saleB],
      paymentsBySale(await getPayments(db)),
      refundsBySale(await getRefunds(db)),
    );
    expect(cb).toEqual({ owedToBusinessUsd: 100, owedToClientUsd: 20 });
  });
});
