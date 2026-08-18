import { describe, it, expect } from 'vitest';
import {
  periodKeyFor,
  previousPeriodKeys,
  inMonthEndWindow,
  dueForWorker,
  dueSummary,
  saveWorker,
  recordPayrollPayment,
} from './payroll';
import type { WorkerDoc, PayrollPayDoc } from './types';
import { makeTestDb } from './testdb';

const RATE = 36.5;

describe('periodKeyFor — ISO weeks', () => {
  it('Monday of a plain week', () => {
    expect(periodKeyFor(new Date(2026, 7, 17), 'WEEKLY')).toBe('2026-W34'); // Monday
  });

  it('Sunday stays in the same ISO week as its Monday', () => {
    expect(periodKeyFor(new Date(2026, 7, 23), 'WEEKLY')).toBe('2026-W34'); // Sunday
  });

  it('Jan 1 2027 (Friday) falls in week 53 of 2026', () => {
    expect(periodKeyFor(new Date(2027, 0, 1), 'WEEKLY')).toBe('2026-W53');
  });

  it('Dec 31 2018 (Monday) is already week 1 of 2019', () => {
    expect(periodKeyFor(new Date(2018, 11, 31), 'WEEKLY')).toBe('2019-W01');
  });

  it('Jan 1 2024 (Monday) is week 1 of 2024', () => {
    expect(periodKeyFor(new Date(2024, 0, 1), 'WEEKLY')).toBe('2024-W01');
  });

  it('monthly is plain YYYY-MM', () => {
    expect(periodKeyFor(new Date(2026, 7, 17), 'MONTHLY')).toBe('2026-08');
  });
});

describe('previousPeriodKeys', () => {
  it('current period first, weekly lookback', () => {
    const keys = previousPeriodKeys(new Date(2026, 7, 17), 'WEEKLY', 4);
    expect(keys).toEqual(['2026-W34', '2026-W33', '2026-W32', '2026-W31']);
  });

  it('crosses a year boundary going back', () => {
    const keys = previousPeriodKeys(new Date(2027, 0, 1), 'WEEKLY', 2);
    expect(keys).toEqual(['2026-W53', '2026-W52']);
  });

  it('monthly lookback', () => {
    const keys = previousPeriodKeys(new Date(2026, 0, 15), 'MONTHLY', 2);
    expect(keys).toEqual(['2026-01', '2025-12']);
  });
});

describe('inMonthEndWindow', () => {
  it('true in the last 7 days of a 31-day month', () => {
    expect(inMonthEndWindow(new Date(2026, 7, 25))).toBe(true);
    expect(inMonthEndWindow(new Date(2026, 7, 31))).toBe(true);
  });

  it('false earlier in the month', () => {
    expect(inMonthEndWindow(new Date(2026, 7, 24))).toBe(false);
  });

  it('handles February', () => {
    expect(inMonthEndWindow(new Date(2026, 1, 22))).toBe(true); // 2026 Feb has 28 days
    expect(inMonthEndWindow(new Date(2026, 1, 21))).toBe(false);
  });
});

function makeWorker(over: Partial<WorkerDoc> = {}): WorkerDoc {
  return {
    _id: 'worker:v-1',
    type: 'worker',
    documentId: 'V-1',
    name: 'JUAN PEREZ',
    active: true,
    concepts: [
      { label: 'Salario', amountUsd: 100, frequency: 'WEEKLY' },
      { label: 'Utilidades', amountUsd: 50, frequency: 'MONTHLY' },
    ],
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function makePay(over: Partial<PayrollPayDoc> = {}): PayrollPayDoc {
  return {
    _id: 'payrollpay:x:1',
    type: 'payrollpay',
    payId: '1',
    workerId: 'worker:v-1',
    date: new Date().toISOString(),
    entryMethod: 'CASH',
    exchangeRateBCV: RATE,
    lines: [],
    totalUsd: 0,
    operatorId: 'op',
    ...over,
  };
}

describe('dueForWorker', () => {
  const now = new Date(2026, 7, 17); // Monday, 2026-W34, month 2026-08

  it('inactive worker has nothing due', () => {
    expect(dueForWorker(makeWorker({ active: false }), [], now)).toEqual([]);
  });

  it('current period paid is not due', () => {
    const pay = makePay({ lines: [{ label: 'Salario', amountUsd: 100, periodKey: '2026-W34' }] });
    const due = dueForWorker(makeWorker(), [pay], now);
    expect(due.some((d) => d.label === 'Salario' && d.periodKey === '2026-W34')).toBe(false);
  });

  it('a missed earlier week is overdue', () => {
    const due = dueForWorker(makeWorker(), [], now);
    const missedWeek = due.find((d) => d.label === 'Salario' && d.periodKey === '2026-W33');
    expect(missedWeek?.overdue).toBe(true);
  });

  it('current period is not overdue', () => {
    const due = dueForWorker(makeWorker(), [], now);
    const current = due.find((d) => d.label === 'Salario' && d.periodKey === '2026-W34');
    expect(current?.overdue).toBe(false);
  });

  it('monthly lookback is 2 periods', () => {
    const due = dueForWorker(makeWorker(), [], now);
    const monthly = due.filter((d) => d.label === 'Utilidades');
    expect(monthly.map((d) => d.periodKey).sort()).toEqual(['2026-07', '2026-08']);
  });

  it('oldest first', () => {
    const due = dueForWorker(makeWorker({ concepts: [{ label: 'Salario', amountUsd: 100, frequency: 'WEEKLY' }] }), [], now);
    const keys = due.map((d) => d.periodKey);
    expect(keys).toEqual([...keys].sort());
  });

  it('label match is exact — a different label does not count as paid', () => {
    const pay = makePay({ lines: [{ label: 'salario', amountUsd: 100, periodKey: '2026-W34' }] });
    const due = dueForWorker(makeWorker({ concepts: [{ label: 'Salario', amountUsd: 100, frequency: 'WEEKLY' }] }), [pay], now);
    expect(due.some((d) => d.periodKey === '2026-W34')).toBe(true);
  });
});

describe('dueSummary', () => {
  it('excludes workers with nothing due', () => {
    const now = new Date(2026, 7, 17);
    const paidAll = makePay({
      lines: [
        { label: 'Salario', amountUsd: 100, periodKey: '2026-W34' },
        { label: 'Salario', amountUsd: 100, periodKey: '2026-W33' },
        { label: 'Salario', amountUsd: 100, periodKey: '2026-W32' },
        { label: 'Salario', amountUsd: 100, periodKey: '2026-W31' },
        { label: 'Utilidades', amountUsd: 50, periodKey: '2026-08' },
        { label: 'Utilidades', amountUsd: 50, periodKey: '2026-07' },
      ],
    });
    const summary = dueSummary([makeWorker()], [paidAll], now);
    expect(summary).toEqual([]);
  });

  it('sums totalUsd for a worker with dues', () => {
    const now = new Date(2026, 7, 17);
    const summary = dueSummary(
      [makeWorker({ concepts: [{ label: 'Salario', amountUsd: 100, frequency: 'WEEKLY' }] })],
      [],
      now,
    );
    expect(summary).toHaveLength(1);
    expect(summary[0].totalUsd).toBe(400); // 4 weeks * 100
  });
});

describe('saveWorker', () => {
  it('creates with a normalized documentId', async () => {
    const db = makeTestDb();
    const worker = await saveWorker(db, {
      documentId: 'v12345678',
      name: 'ana lopez',
      active: true,
      concepts: [{ label: 'Salario', amountUsd: 200, frequency: 'WEEKLY' }],
    });
    expect(worker._id).toBe('worker:v-12345678');
    expect(worker.documentId).toBe('V-12345678');
    expect(worker.name).toBe('ANA LOPEZ');
  });

  it('rejects an invalid documentId on create', async () => {
    const db = makeTestDb();
    await expect(
      saveWorker(db, { documentId: 'not-an-id', name: 'Ana', active: true, concepts: [] }),
    ).rejects.toThrow();
  });

  it('update keeps the stored documentId verbatim (no re-normalization)', async () => {
    const db = makeTestDb();
    // Stored id keeps dashes exactly as typed the first time.
    const created = await saveWorker(db, {
      documentId: 'V-1234567',
      name: 'Ana',
      active: true,
      concepts: [],
    });
    const updated = await saveWorker(db, {
      documentId: created.documentId,
      name: 'Ana Maria',
      active: false,
      concepts: [{ label: 'Bono', amountUsd: 10, frequency: 'MONTHLY' }],
    });
    expect(updated._id).toBe(created._id);
    expect(updated.documentId).toBe(created.documentId);
    expect(updated.active).toBe(false);
  });

  it('field-list erasure: a field left off the input does not survive from a stale caller', async () => {
    const db = makeTestDb();
    await saveWorker(db, {
      documentId: 'V-2222222',
      name: 'Bea',
      active: true,
      concepts: [{ label: 'Salario', amountUsd: 50, frequency: 'WEEKLY' }],
    });
    const updated = await saveWorker(db, {
      documentId: 'V-2222222',
      name: 'Bea',
      active: true,
      concepts: [], // explicit empty list — must overwrite, not merge
    });
    expect(updated.concepts).toEqual([]);
  });

  it('rejects Infinity in a concept amount', async () => {
    const db = makeTestDb();
    await expect(
      saveWorker(db, {
        documentId: 'V-3333333',
        name: 'Cua',
        active: true,
        concepts: [{ label: 'Salario', amountUsd: Number('1e999'), frequency: 'WEEKLY' }],
      }),
    ).rejects.toThrow();
  });

  it('rejects more than 20 concepts', async () => {
    const db = makeTestDb();
    const concepts = Array.from({ length: 21 }, (_, i) => ({
      label: `Bono ${i}`,
      amountUsd: 1,
      frequency: 'WEEKLY' as const,
    }));
    await expect(
      saveWorker(db, { documentId: 'V-4444444', name: 'Dee', active: true, concepts }),
    ).rejects.toThrow();
  });
});

describe('recordPayrollPayment', () => {
  async function makeWorkerInDb(db: PouchDB.Database) {
    return saveWorker(db, {
      documentId: 'V-5555555',
      name: 'Elio',
      active: true,
      concepts: [{ label: 'Salario', amountUsd: 100, frequency: 'WEEKLY' }],
    });
  }

  it('writes a payment and derives totalUsd', async () => {
    const db = makeTestDb();
    const worker = await makeWorkerInDb(db);
    const pay = await recordPayrollPayment(
      db,
      {
        payId: 'p1',
        workerId: worker._id,
        date: '2026-08-17T00:00:00.000Z',
        entryMethod: 'CASH',
        lines: [{ label: 'Salario', amountUsd: 100, periodKey: '2026-W34' }],
        operatorId: 'op',
      },
      RATE,
    );
    expect(pay.totalUsd).toBe(100);
    expect(pay._id).toBe('payrollpay:2026-08-17T00:00:00.000Z:p1');
  });

  it('same payId twice returns one doc (idempotent)', async () => {
    const db = makeTestDb();
    const worker = await makeWorkerInDb(db);
    const input = {
      payId: 'dup-1',
      workerId: worker._id,
      date: '2026-08-17T00:00:00.000Z',
      entryMethod: 'CASH' as const,
      lines: [{ label: 'Salario', amountUsd: 100, periodKey: '2026-W34' }],
      operatorId: 'op',
    };
    const first = await recordPayrollPayment(db, input, RATE);
    const second = await recordPayrollPayment(db, input, RATE);
    expect(second._id).toBe(first._id);
    expect(second.totalUsd).toBe(first.totalUsd);
    const all = await db.allDocs({ startkey: 'payrollpay:', endkey: 'payrollpay:￿' });
    expect(all.rows).toHaveLength(1);
  });

  it('rejects an unknown worker', async () => {
    const db = makeTestDb();
    await expect(
      recordPayrollPayment(
        db,
        {
          payId: 'p2',
          workerId: 'worker:ghost',
          date: '2026-08-17T00:00:00.000Z',
          entryMethod: 'CASH',
          lines: [{ label: 'Salario', amountUsd: 100, periodKey: '2026-W34' }],
          operatorId: 'op',
        },
        RATE,
      ),
    ).rejects.toThrow();
  });

  it('rejects a malformed periodKey', async () => {
    const db = makeTestDb();
    const worker = await makeWorkerInDb(db);
    await expect(
      recordPayrollPayment(
        db,
        {
          payId: 'p3',
          workerId: worker._id,
          date: '2026-08-17T00:00:00.000Z',
          entryMethod: 'CASH',
          lines: [{ label: 'Salario', amountUsd: 100, periodKey: 'not-a-period' }],
          operatorId: 'op',
        },
        RATE,
      ),
    ).rejects.toThrow();
  });

  it('rejects Infinity exchangeRateBCV', async () => {
    const db = makeTestDb();
    const worker = await makeWorkerInDb(db);
    await expect(
      recordPayrollPayment(
        db,
        {
          payId: 'p4',
          workerId: worker._id,
          date: '2026-08-17T00:00:00.000Z',
          entryMethod: 'CASH',
          lines: [{ label: 'Salario', amountUsd: 100, periodKey: '2026-W34' }],
          operatorId: 'op',
        },
        Number('1e999'),
      ),
    ).rejects.toThrow();
  });
});
