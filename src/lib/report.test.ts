import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { weekPeriod, monthPeriod, shiftPeriod, buildReport, buildPayrollSummary } from './report';
import { round2 } from './format';
import {
  saleIdOf, expenseIdOf, movementIdOf, paymentIdOf, refundIdOf,
  type SaleDoc, type ExpenseDoc, type InventoryMovementDoc, type PaymentDoc, type RefundDoc,
  type PayrollPayDoc, type ClientDoc, type BatchDoc, type ProductDoc,
} from './types';

// ---- Period math ----

describe('weekPeriod', () => {
  it('Monday..Sunday for a mid-week date', () => {
    const p = weekPeriod(new Date(2026, 7, 13)); // Thursday 13 Aug 2026
    expect(p.start).toBe('2026-08-10'); // Monday
    expect(p.end).toBe('2026-08-16'); // Sunday
    expect(p.label).toBe('Semana del 10 al 16 de agosto de 2026');
  });

  it('a Sunday belongs to the week that just ended', () => {
    const p = weekPeriod(new Date(2026, 7, 16)); // Sunday
    expect(p.start).toBe('2026-08-10');
    expect(p.end).toBe('2026-08-16');
  });

  it('crosses a month boundary', () => {
    const p = weekPeriod(new Date(2026, 7, 31)); // Monday 31 Aug 2026
    expect(p.start).toBe('2026-08-31');
    expect(p.end).toBe('2026-09-06');
    expect(p.label).toContain('31 de agosto al 6 de septiembre de 2026');
  });

  it('crosses a year boundary', () => {
    const p = weekPeriod(new Date(2026, 11, 31)); // Thursday 31 Dec 2026
    expect(p.start).toBe('2026-12-28');
    expect(p.end).toBe('2027-01-03');
    expect(p.label).toContain('2026 al 3 de enero de 2027');
  });
});

describe('monthPeriod', () => {
  it('full calendar month, label capitalized', () => {
    const p = monthPeriod(new Date(2026, 7, 13));
    expect(p.start).toBe('2026-08-01');
    expect(p.end).toBe('2026-08-31');
    expect(p.label).toBe('Agosto 2026');
  });

  it('handles a short month (February, non-leap)', () => {
    const p = monthPeriod(new Date(2027, 1, 1));
    expect(p.end).toBe('2027-02-28');
  });

  it('handles a leap February', () => {
    const p = monthPeriod(new Date(2028, 1, 1));
    expect(p.end).toBe('2028-02-29');
  });
});

describe('shiftPeriod', () => {
  it('shifts a week by 7 days per delta', () => {
    const p = weekPeriod(new Date(2026, 7, 13));
    const next = shiftPeriod(p, 1);
    expect(next.start).toBe('2026-08-17');
    const prev = shiftPeriod(p, -1);
    expect(prev.start).toBe('2026-08-03');
  });

  it('shifts a month by calendar months, across a year boundary', () => {
    const p = monthPeriod(new Date(2026, 11, 1)); // December 2026
    const next = shiftPeriod(p, 1);
    expect(next.start).toBe('2027-01-01');
    expect(next.end).toBe('2027-01-31');
    const prev = shiftPeriod(p, -13);
    expect(prev.start).toBe('2025-11-01');
  });
});

// ---- buildReport ----

function sale(id: string, date: string, over: Partial<SaleDoc>): SaleDoc {
  return {
    _id: id, type: 'sale', transactionId: id, clientId: null, date,
    isOnTheBooks: false, exchangeRateBCV: 36, totalUsd: 0,
    paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0, paymentStatus: 'PENDING',
    creditTerms: null, lineItems: [], ...over,
  };
}

function expense(id: string, date: string, over: Partial<ExpenseDoc>): ExpenseDoc {
  return {
    _id: id, type: 'expense', expenseId: id, date, category: 'Otros', description: '',
    isFixedExpense: false, entryMethod: 'CASH', amountUsd: 0, exchangeRateBCV: 36, ...over,
  };
}

function movement(id: string, date: string, over: Partial<InventoryMovementDoc>): InventoryMovementDoc {
  return {
    _id: id, type: 'movement', movementId: id, date, movementType: 'IN',
    referenceId: 'x', reason: 'Ingreso de inventario', operatorId: 'op', lineItems: [], ...over,
  };
}

describe('buildReport — seeded scenario', () => {
  it('aggregates every summary figure over a month, ignoring docs outside it', async () => {
    const db = makeTestDb();
    const inDate = '2026-08-15T10:00:00.000Z';
    const outDate = '2026-07-31T23:59:00.000Z'; // just before the period

    // Sale A: on-books, taxed, fully paid in divisas → IVA 16, IGTF 3.
    await db.put(sale(saleIdOf(inDate, 'A'), inDate, {
      isOnTheBooks: true, totalUsd: 100, ivaRate: 0.16, igtfRate: 0.03,
      paidUsdCash: 100, paidUsdTransfer: 0, paymentStatus: 'PAID',
    }));
    // Sale B: pre-tax legacy sale (no ivaRate/igtfRate) — reads as 0-rate.
    await db.put(sale(saleIdOf(inDate, 'B'), inDate, { totalUsd: 50 }));
    // Sale C: outside the period — must not be counted.
    await db.put(sale(saleIdOf(outDate, 'C'), outDate, { totalUsd: 999 }));

    // A later collection at a DIFFERENT rate than sale A's own (36).
    await db.put({
      _id: paymentIdOf(inDate, 'p1'), type: 'payment', paymentId: 'p1',
      saleId: saleIdOf(inDate, 'A'), date: inDate, exchangeRateBCV: 40,
      paidUsdCash: 20, paidUsdTransfer: 0, paidBs: 0, note: '', operatorId: 'op',
    } as PaymentDoc);
    // Change handed back on the same sale.
    await db.put({
      _id: refundIdOf(inDate, 'r1'), type: 'refund', saleId: saleIdOf(inDate, 'A'),
      date: inDate, exchangeRateBCV: 36, givenUsdCash: 5, givenUsdTransfer: 0, givenBs: 0,
      note: '', operatorId: 'op',
    } as RefundDoc);

    // Fixed + variable expenses, two in the same category.
    await db.put(expense(expenseIdOf(inDate, 'e1'), inDate, {
      category: 'Alquiler', isFixedExpense: true, amountUsd: 30,
    }));
    await db.put(expense(expenseIdOf(inDate, 'e2'), inDate, {
      category: 'Insumos', isFixedExpense: false, amountUsd: 20,
    }));
    await db.put(expense(expenseIdOf(inDate, 'e3'), inDate, {
      category: 'Insumos', isFixedExpense: false, amountUsd: 5,
    }));

    // A mixed-sign exchange (one movement, both legs, same reason) — net Kg 0
    // but 5 In and 5 Out on the gross side.
    await db.put(movement(movementIdOf(inDate, 'm1'), inDate, {
      movementType: 'ADJUST', reason: 'Cambio por garantía',
      lineItems: [
        { productId: 'product:a', quantityChanged: 5, unitOfMeasure: 'Kg', conditionTag: 'FIRST' },
        { productId: 'product:b', quantityChanged: -5, unitOfMeasure: 'Kg', conditionTag: 'FIRST' },
      ],
    }));
    // A plain ingress (Kg) and a plain sale deduction (Units), different reasons.
    await db.put(movement(movementIdOf(inDate, 'm2'), inDate, {
      movementType: 'IN', reason: 'Ingreso de inventario',
      lineItems: [{ productId: 'product:c', quantityChanged: 10, unitOfMeasure: 'Kg', conditionTag: 'FIRST' }],
    }));
    await db.put(movement(movementIdOf(inDate, 'm3'), inDate, {
      movementType: 'OUT', reason: 'Venta',
      lineItems: [{ productId: 'product:stock', quantityChanged: -3, unitOfMeasure: 'Units', conditionTag: 'FIRST' }],
    }));
    // Outside the period.
    await db.put(movement(movementIdOf(outDate, 'm4'), outDate, {
      lineItems: [{ productId: 'product:d', quantityChanged: 999, unitOfMeasure: 'Kg', conditionTag: 'FIRST' }],
    }));

    const period = monthPeriod(new Date(2026, 7, 1));
    const report = await buildReport(db, period);

    expect(report.sales).toEqual({
      count: 2, baseUsd: 150, ivaUsd: 16, igtfUsd: 3, grandTotalUsd: 169,
      onBooksCount: 1, offBooksCount: 1,
    });

    expect(report.collections).toEqual({
      paymentsCount: 1, collectedUsd: 20, refundsCount: 1, refundedUsd: 5,
    });

    expect(report.expenses.count).toBe(3);
    expect(report.expenses.totalUsd).toBe(55);
    expect(report.expenses.fixedUsd).toBe(30);
    expect(report.expenses.variableUsd).toBe(25);
    expect(report.expenses.byCategory).toEqual([
      { category: 'Alquiler', count: 1, totalUsd: 30 },
      { category: 'Insumos', count: 2, totalUsd: 25 },
    ]);

    expect(report.movements.kgIn).toBe(15); // 5 (exchange leg) + 10 (ingress)
    expect(report.movements.kgOut).toBe(5); // exchange leg only
    expect(report.movements.unitsIn).toBe(0);
    expect(report.movements.unitsOut).toBe(3);
    expect(report.movements.byReason).toEqual(expect.arrayContaining([
      { reason: 'Cambio por garantía', count: 1, kg: 0, units: 0 },
      { reason: 'Ingreso de inventario', count: 1, kg: 10, units: 0 },
      { reason: 'Venta', count: 1, kg: 0, units: -3 },
    ]));
    expect(report.movements.byReason).toHaveLength(3);
  });

  it('empty period never throws and zeroes every summary', async () => {
    const db = makeTestDb();
    const period = monthPeriod(new Date(2020, 0, 1));
    const report = await buildReport(db, period);
    expect(report.sales).toEqual({
      count: 0, baseUsd: 0, ivaUsd: 0, igtfUsd: 0, grandTotalUsd: 0, onBooksCount: 0, offBooksCount: 0,
    });
    expect(report.collections).toEqual({ paymentsCount: 0, collectedUsd: 0, refundsCount: 0, refundedUsd: 0 });
    expect(report.expenses).toEqual({ count: 0, totalUsd: 0, fixedUsd: 0, variableUsd: 0, byCategory: [] });
    expect(report.movements).toEqual({ byReason: [], kgIn: 0, kgOut: 0, unitsIn: 0, unitsOut: 0 });
    expect(report.daily.every((d) => d.facturadoUsd === 0 && d.cobradoUsd === 0)).toBe(true);
    expect(report.avgTicketUsd).toBe(0);
    expect(report.bestDay).toBeNull();
    expect(report.topClients).toEqual([]);
    expect(report.topArticles).toEqual([]);
    expect(report.cogs).toEqual({ costUsd: 0, grossMarginUsd: 0, marginPct: 0, coverage: 0 });
    expect(report.previous).toEqual({ count: 0, grandTotalUsd: 0, expensesTotalUsd: 0, collectedUsd: 0 });
    expect(report.inventory).toEqual({ topOut: [], topIn: [] });
    expect(report.stockNow).toEqual({ batches: 0, kg: 0, units: 0, valueUsd: 0 });
  });
});

describe('buildReport — period boundary', () => {
  it('attributes a sale by its LOCAL calendar day, not by the UTC day in its id', async () => {
    const db = makeTestDb();
    // 23:30 on the last local day of August. West of Greenwich that instant is
    // already September in UTC — which is what the id (and the scan) carry.
    const date = new Date(2026, 7, 31, 23, 30).toISOString();
    const db_id = saleIdOf(date, 'Z');
    await db.put(sale(db_id, date, { totalUsd: 100 }));

    const agosto = await buildReport(db, monthPeriod(new Date(2026, 7, 1)));
    expect(agosto.sales.count).toBe(1);
    expect(agosto.daily[agosto.daily.length - 1]).toMatchObject({ date: '2026-08-31', facturadoUsd: 100 });

    const septiembre = await buildReport(db, monthPeriod(new Date(2026, 8, 1)));
    expect(septiembre.sales.count).toBe(0);
  });
});

describe('buildReport — performance metrics', () => {
  it('computes daily series, top clients/articles, COGS, previous period and stock snapshot', async () => {
    const db = makeTestDb();
    const day1 = '2026-08-03T10:00:00.000Z';
    const day2 = '2026-08-04T10:00:00.000Z';

    await db.put({
      _id: 'client:v-1', type: 'client', documentId: 'V-1', entityType: 'PERSON',
      name: 'ANA PEREZ', address: '', phoneNumber: '', email: '', specialty: [],
      updatedAt: day1,
    } as ClientDoc);

    await db.put({
      _id: 'batch:azul:30:jersey', type: 'batch', color: 'Azul', nm: '30', fabricType: 'Jersey',
      productType: 'ROLL', initialUnitCount: 1, currentUnits: 1, location: '', createdAt: day1,
    } as BatchDoc);
    await db.put({
      _id: 'product:batch:azul:30:jersey:R1', type: 'product', batchId: 'batch:azul:30:jersey',
      pieceId: 'R1', initialWeightKg: 20, currentWeightKg: 15, purchaseValueUsd: 2, salePriceUsd: 5,
      conditionTag: 'FIRST', createdAt: day1,
    } as ProductDoc);

    // Second batch, whose lone product carries NO cost — exercises `coverage`.
    await db.put({
      _id: 'batch:negro:20:algodon', type: 'batch', color: 'Negro', nm: '20', fabricType: 'Algodón',
      productType: 'COMBO', initialUnitCount: 10, currentUnits: 4, location: '', createdAt: day1,
    } as BatchDoc);
    await db.put({
      _id: 'product:batch:negro:20:algodon:stock', type: 'product', batchId: 'batch:negro:20:algodon',
      pieceId: 'stock', initialWeightKg: 0, currentWeightKg: 0, purchaseValueUsd: 0, salePriceUsd: 3,
      conditionTag: 'FIRST', createdAt: day1,
    } as ProductDoc);

    // Sale day 1: client Ana, one line off the Jersey roll (cost known) → $50.
    await db.put(sale(saleIdOf(day1, 'A'), day1, {
      clientId: 'client:v-1', totalUsd: 50,
      lineItems: [{
        productId: 'product:batch:azul:30:jersey:R1', batchId: 'batch:azul:30:jersey',
        description: 'Azul · 30 · Jersey', quantity: 5, unitOfMeasure: 'Kg',
        unitPriceAtSale: 10, lineSubtotalUsd: 50,
      }],
    }));
    // Sale day 2: walk-in (Contado), Negro combo line (cost UNKNOWN) → $30, bigger than day 1.
    await db.put(sale(saleIdOf(day2, 'B'), day2, {
      clientId: null, totalUsd: 90,
      lineItems: [{
        productId: 'product:batch:negro:20:algodon:stock', batchId: 'batch:negro:20:algodon',
        description: 'Negro · 20 · Algodón', quantity: 10, unitOfMeasure: 'Units',
        unitPriceAtSale: 9, lineSubtotalUsd: 90,
      }],
    }));

    // Movement: 5 Kg IN and 5 Kg OUT on the same jersey roll product (mixed signs, one line each).
    await db.put(movement(movementIdOf(day1, 'm1'), day1, {
      movementType: 'ADJUST', reason: 'Ajuste',
      lineItems: [
        { productId: 'product:batch:azul:30:jersey:R1', quantityChanged: 8, unitOfMeasure: 'Kg', conditionTag: 'FIRST' },
        { productId: 'product:batch:azul:30:jersey:R1', quantityChanged: -3, unitOfMeasure: 'Kg', conditionTag: 'FIRST' },
      ],
    }));

    // Previous period (the week before day1's week) — one sale, for the `previous` comparison.
    const prevDate = '2026-07-27T10:00:00.000Z';
    await db.put(sale(saleIdOf(prevDate, 'P'), prevDate, { totalUsd: 40 }));

    const period = weekPeriod(new Date(2026, 7, 3)); // Monday 3 Aug 2026 .. Sunday 9 Aug
    const report = await buildReport(db, period);

    // Daily series covers the whole week, zero-filled, matching each day's totals.
    expect(report.daily).toHaveLength(7);
    expect(report.daily[0].date).toBe(period.start);
    const d1 = report.daily.find((d) => d.date === '2026-08-03')!;
    const d2 = report.daily.find((d) => d.date === '2026-08-04')!;
    expect(d1.facturadoUsd).toBe(50);
    expect(d2.facturadoUsd).toBe(90);

    expect(report.avgTicketUsd).toBe(70); // (50+90)/2
    expect(report.bestDay).toEqual({ date: '2026-08-04', totalUsd: 90 });

    expect(report.topClients).toEqual(expect.arrayContaining([
      { label: 'ANA PEREZ', value: 50 },
      { label: 'Contado', value: 90 },
    ]));

    expect(report.topArticles).toEqual(expect.arrayContaining([
      { label: 'Negro · 20 · Algodón', usd: 90, kg: 0, units: 10 },
      { label: 'Azul · 30 · Jersey', usd: 50, kg: 5, units: 0 },
    ]));

    // Cost: only the Jersey line has a costed product (5kg * $2 = $10); Negro's product costs 0.
    expect(report.cogs.costUsd).toBe(10);
    expect(report.cogs.grossMarginUsd).toBe(round2(report.sales.baseUsd - 10));
    expect(report.cogs.coverage).toBe(0.3571); // only the Jersey line's $50 is costed of $140

    expect(report.previous.count).toBe(1);
    expect(report.previous.grandTotalUsd).toBe(40);

    expect(report.inventory.topIn).toEqual([{ label: 'Azul · 30 · Jersey', value: 8 }]);
    expect(report.inventory.topOut).toEqual([{ label: 'Azul · 30 · Jersey', value: 3 }]);

    // Stock now: jersey roll has 15kg left (worth $2/kg), Negro combo has 4 units (worth $0/unit).
    expect(report.stockNow).toEqual({ batches: 2, kg: 15, units: 4, valueUsd: 30 });
  });

  it('empty base never throws and zeroes every new field', async () => {
    const db = makeTestDb();
    const report = await buildReport(db, monthPeriod(new Date(2020, 0, 1)));
    expect(report.daily.length).toBeGreaterThan(0);
    expect(report.daily.every((d) => d.facturadoUsd === 0)).toBe(true);
    expect(report.avgTicketUsd).toBe(0);
    expect(report.bestDay).toBeNull();
    expect(report.topClients).toEqual([]);
    expect(report.topArticles).toEqual([]);
    expect(report.cogs).toEqual({ costUsd: 0, grossMarginUsd: 0, marginPct: 0, coverage: 0 });
    expect(report.inventory).toEqual({ topOut: [], topIn: [] });
    expect(report.stockNow).toEqual({ batches: 0, kg: 0, units: 0, valueUsd: 0 });
  });
});

describe('buildPayrollSummary', () => {
  it('sums payrollpay docs in the period, ignoring ones outside it', async () => {
    const db = makeTestDb();
    const inDate = '2026-08-05T08:00:00.000Z';
    const outDate = '2026-06-01T08:00:00.000Z';
    const pay = (id: string, date: string, totalUsd: number): PayrollPayDoc => ({
      _id: id, type: 'payrollpay', payId: id, workerId: 'w1', date, entryMethod: 'CASH',
      exchangeRateBCV: 36, lines: [{ label: 'Salario', amountUsd: totalUsd, periodKey: '2026-W32' }],
      totalUsd, operatorId: 'op',
    });
    await db.put(pay('payrollpay:' + inDate + ':p1', inDate, 100));
    await db.put(pay('payrollpay:' + inDate + ':p2', inDate, 50.5));
    await db.put(pay('payrollpay:' + outDate + ':p3', outDate, 999));

    const summary = await buildPayrollSummary(db, monthPeriod(new Date(2026, 7, 1)));
    expect(summary).toEqual({ count: 2, totalUsd: 150.5 });
  });
});
