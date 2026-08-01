import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import {
  saleTaxes, grandTotalUsd, IVA_RATE, IGTF_RATE,
  saveFiscalConfig, getFiscalConfig, saveDailyRate, getConfig,
} from './queries';
import { saleBalance } from './payments';
import { checkout } from './checkout';
import { ingressStock } from './inventory';
import { batchIdOf, productIdOf, type CartLineItem, type SaleDoc } from './types';

const RATE = 40;

const sale = (over: Partial<SaleDoc> = {}): SaleDoc => ({
  _id: 'sale:2026-08-01T00:00:00.000Z:tx', type: 'sale', transactionId: 'tx',
  clientId: null, date: '2026-08-01T00:00:00.000Z', isOnTheBooks: true,
  exchangeRateBCV: RATE, totalUsd: 100,
  paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0,
  paymentStatus: 'PENDING', creditTerms: null, lineItems: [],
  ...over,
});

describe('saleTaxes — the one definition of the money rules', () => {
  it('leaves a sale with no rates exactly as it was', () => {
    // The whole back catalogue. Sales are immutable, so if this grew 16% the
    // day tax shipped, the phantom debt could never be corrected.
    const t = saleTaxes(sale({ ivaRate: undefined, igtfRate: undefined }));
    expect(t).toEqual({ baseUsd: 100, ivaUsd: 0, igtfUsd: 0, grandTotalUsd: 100 });
  });

  it('adds 16% IVA and no IGTF when nothing is paid in divisas', () => {
    const t = saleTaxes(sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE }));
    expect(t.ivaUsd).toBe(16);
    expect(t.igtfUsd).toBe(0);
    expect(t.grandTotalUsd).toBe(116);
  });

  it('charges IGTF on the pre-IVA base, in proportion to what is paid in divisas', () => {
    // The whole bill before IGTF is 116; paying 58 in cash settles half of it.
    const half = saleTaxes(sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidUsdCash: 58 }));
    expect(half.igtfUsd).toBe(1.5); // 100 base × 0.5 × 3%
    expect(half.grandTotalUsd).toBe(117.5);

    // Paying the lot in divisas taxes the whole base.
    const all = saleTaxes(sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidUsdTransfer: 116 }));
    expect(all.igtfUsd).toBe(3);
    expect(all.grandTotalUsd).toBe(119);
  });

  it('never charges IGTF on more than the whole base, however much is tendered', () => {
    const over = saleTaxes(sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidUsdCash: 10_000 }));
    expect(over.igtfUsd).toBe(3);
  });

  it('treats bolívares as not-divisas', () => {
    // paidBs is not part of the divisa share — that is the whole point of IGTF.
    const t = saleTaxes(sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidBs: 4640 }));
    expect(t.igtfUsd).toBe(0);
  });

  it('survives a zero-total sale without dividing by zero', () => {
    const t = saleTaxes(sale({ totalUsd: 0, ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidUsdCash: 5 }));
    expect(t).toEqual({ baseUsd: 0, ivaUsd: 0, igtfUsd: 0, grandTotalUsd: 0 });
  });
});

describe('saleBalance — what is owed is the GRAND total', () => {
  it('counts the tax as debt', () => {
    const s = sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, totalUsd: 100 });
    expect(grandTotalUsd(s)).toBe(116);
    expect(saleBalance(s).owedUsd).toBe(116);
    expect(saleBalance(s).status).toBe('PENDING');
  });

  it('does not call a sale paid when the payment covers the net but not the IVA', () => {
    // The exact failure the one-commit switch exists to prevent: frozen PAID,
    // and the tax portion invisible in every receivable screen thereafter.
    const s = sale({ ivaRate: IVA_RATE, igtfRate: IGTF_RATE, paidUsdCash: 100 });
    const b = saleBalance(s);
    expect(b.status).toBe('PARTIAL');
    // $100 against a $116 bill is an 86.2% divisa share, so IGTF is
    // 100 × 0.862 × 3% = 2.59 and the grand total is 118.59.
    expect(b.owedUsd).toBe(18.59);
  });

  it('leaves an untaxed sale balance exactly where it was', () => {
    const s = sale({ paidUsdCash: 100 });
    expect(saleBalance(s)).toEqual({ paidUsd: 100, owedUsd: 0, status: 'PAID' });
  });
});

describe('checkout — locks the rates, never the amounts', () => {
  const line = (batchId: string, pieceId: string, qty: number, price: number): CartLineItem => ({
    productId: productIdOf(batchId, pieceId), batchId, description: 'x',
    quantity: qty, unitOfMeasure: 'Kg', unitPriceAtSale: price, lineSubtotalUsd: 0,
  });

  const stocked = async () => {
    const db = makeTestDb();
    const bid = batchIdOf('Azul', '30', 'Jersey');
    await ingressStock(db, {
      color: 'Azul', nm: '30', fabricType: 'Jersey', productType: 'ROLL', operatorId: 'op',
      rolls: [{ pieceId: 'R1', weightKg: 100, purchaseValueUsd: 5, salePriceUsd: 10 }],
    });
    return { db, bid };
  };

  it('stores ivaRate/igtfRate and NO derived amount when the sale is en libros', async () => {
    const { db, bid } = await stocked();
    const s = await checkout(db, {
      transactionId: 'tx1', createdAt: new Date().toISOString(), clientId: 'client:1',
      isOnTheBooks: true, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [line(bid, 'R1', 10, 10)],
      payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
    });
    expect(s.totalUsd).toBe(100); // the document keeps the PRE-tax figure
    expect(s.ivaRate).toBe(IVA_RATE);
    expect(s.igtfRate).toBe(IGTF_RATE);
    for (const forbidden of ['ivaUsd', 'igtfUsd', 'grandTotalUsd', 'totalBs']) {
      expect(forbidden in s).toBe(false);
    }
    expect(grandTotalUsd(s)).toBe(116);
  });

  it('charges nothing when the sale is not en libros', async () => {
    const { db, bid } = await stocked();
    const s = await checkout(db, {
      transactionId: 'tx2', createdAt: new Date().toISOString(), clientId: null,
      isOnTheBooks: false, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [line(bid, 'R1', 10, 10)],
      payments: { paidUsdCash: 100, paidUsdTransfer: 0, paidBs: 0 },
    });
    expect(s.ivaRate).toBe(0);
    expect(s.paymentStatus).toBe('PAID');
    expect(grandTotalUsd(s)).toBe(100);
  });

  it('will not freeze an en-libros sale as PAID on the net amount alone', async () => {
    const { db, bid } = await stocked();
    // $100 of fabric + IVA + IGTF is $119; handing over $100 leaves a debt, so
    // this needs a client — and that guard runs on the grand total too.
    await expect(checkout(db, {
      transactionId: 'tx3', createdAt: new Date().toISOString(), clientId: null,
      isOnTheBooks: true, exchangeRateBCV: RATE, creditTerms: null, operatorId: 'op',
      lines: [line(bid, 'R1', 10, 10)],
      payments: { paidUsdCash: 100, paidUsdTransfer: 0, paidBs: 0 },
    })).rejects.toThrow(/crédito requieren un cliente/i);
  });
});

describe('config:fiscal — its own document', () => {
  it('is not touched when the daily rate is saved', async () => {
    const db = makeTestDb();
    await saveFiscalConfig(db, {
      businessName: 'ML Textiles, C.A.', taxId: 'J-30665094-6',
      address: 'Calle Manduca, edf. 90, La Candelaria, Caracas',
    });
    // saveDailyRate rebuilds config:system from an explicit field list. If the
    // header lived there, this line would delete it.
    await saveDailyRate(db, 41.5);
    const fiscalDoc = await getFiscalConfig(db);
    expect(fiscalDoc?.businessName).toBe('ML Textiles, C.A.');
    expect(fiscalDoc?.taxId).toBe('J-30665094-6');
    expect((await getConfig(db))?.currentDailyRateBCV).toBe(41.5);
  });

  it('rejects an unusable RIF and an empty razón social', async () => {
    const db = makeTestDb();
    await expect(saveFiscalConfig(db, { businessName: '', taxId: 'J-30665094-6', address: '' }))
      .rejects.toThrow(/razón social/i);
    await expect(saveFiscalConfig(db, { businessName: 'X, C.A.', taxId: 'no-es-un-rif', address: '' }))
      .rejects.toThrow(/RIF/i);
  });
});
