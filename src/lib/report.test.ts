import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { weekPeriod, monthPeriod, shiftPeriod, buildReport, buildPayrollSummary } from './report';
import {
  saleIdOf, expenseIdOf, movementIdOf, paymentIdOf, refundIdOf,
  type SaleDoc, type ExpenseDoc, type InventoryMovementDoc, type PaymentDoc, type RefundDoc,
  type PayrollPayDoc,
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
