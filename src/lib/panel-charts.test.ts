import { describe, it, expect } from 'vitest';
import { dailySalesSeries, stockByFabric, expensesByCategory } from './panel-charts';
import type { SaleDoc, PaymentDoc, RefundDoc, ExpenseDoc, BatchDoc, ProductDoc } from './types';

const sale = (over: Partial<SaleDoc>): SaleDoc =>
  ({
    _id: `sale:${over.date}:t`,
    type: 'sale',
    totalUsd: 0,
    paidUsdCash: 0,
    paidUsdTransfer: 0,
    paidBs: 0,
    exchangeRateBCV: 100,
    ...over,
  }) as SaleDoc;

describe('dailySalesSeries', () => {
  it('zero-fills the window and ends at todayIso', () => {
    const s = dailySalesSeries([], [], [], 7, '2026-08-18');
    expect(s).toHaveLength(7);
    expect(s[0].date).toBe('2026-08-12');
    expect(s[6].date).toBe('2026-08-18');
    expect(s.every((p) => p.facturadoUsd === 0 && p.cobradoUsd === 0)).toBe(true);
  });

  it('facturado uses the grand total (IVA on top of base)', () => {
    const s = dailySalesSeries(
      [sale({ date: '2026-08-18T10:00:00.000Z', totalUsd: 100, ivaRate: 0.16 })],
      [], [], 3, '2026-08-18',
    );
    expect(s[2].facturadoUsd).toBe(116);
  });

  it('cobrado converts each doc at ITS OWN locked rate and subtracts vueltos', () => {
    const sales = [sale({ date: '2026-08-17T09:00:00.000Z', totalUsd: 10, paidBs: 500, exchangeRateBCV: 100 })];
    const pays = [
      { date: '2026-08-18T09:00:00.000Z', paidUsdCash: 1, paidUsdTransfer: 0, paidBs: 500, exchangeRateBCV: 200 } as PaymentDoc,
    ];
    const refs = [
      { date: '2026-08-18T12:00:00.000Z', givenUsdCash: 0.5, givenUsdTransfer: 0, givenBs: 0, exchangeRateBCV: 200 } as RefundDoc,
    ];
    const s = dailySalesSeries(sales, pays, refs, 3, '2026-08-18');
    expect(s[1].cobradoUsd).toBe(5); // 500 Bs at the SALE's rate 100
    expect(s[2].cobradoUsd).toBe(3); // 1 + 500/200 − 0.5, at the docs' own rates
  });

  it('ignores docs outside the window', () => {
    const s = dailySalesSeries(
      [sale({ date: '2026-07-01T00:00:00.000Z', totalUsd: 99 })],
      [], [], 7, '2026-08-18',
    );
    expect(s.every((p) => p.facturadoUsd === 0)).toBe(true);
  });
});

describe('stockByFabric', () => {
  const b = (fabricType: string, productType: string, currentUnits = 0): BatchDoc =>
    ({ fabricType, productType, currentUnits }) as BatchDoc;
  const roll = (kg: number): ProductDoc => ({ currentWeightKg: kg }) as ProductDoc;

  it('separates Kg (ROLL) from Units and never mixes them', () => {
    const { kg, units } = stockByFabric([
      { batch: b('Jersey', 'ROLL'), products: [roll(10), roll(5.5)] },
      { batch: b('Piqué', 'COMBO', 40), products: [] },
    ]);
    expect(kg).toEqual([{ label: 'Jersey', value: 15.5 }]);
    expect(units).toEqual([{ label: 'Piqué', value: 40 }]);
  });

  it('ranks descending and folds the tail into Otros past topN', () => {
    const stocked = ['A', 'B', 'C', 'D'].map((f, i) => ({
      batch: b(f, 'ROLL'),
      products: [roll(10 - i)],
    }));
    const { kg } = stockByFabric(stocked, 2);
    expect(kg.map((r) => r.label)).toEqual(['A', 'B', 'Otros']);
    expect(kg[2].value).toBe(15); // C(8) + D(7)
  });

  it('drops zero-stock fabrics', () => {
    const { kg } = stockByFabric([{ batch: b('Jersey', 'ROLL'), products: [roll(0)] }]);
    expect(kg).toEqual([]);
  });
});

describe('expensesByCategory', () => {
  const exp = (date: string, category: string, amountUsd: number): ExpenseDoc =>
    ({ date, category, amountUsd }) as ExpenseDoc;

  it('filters to the month, sums by category, ranks descending', () => {
    const rows = expensesByCategory(
      [
        exp('2026-08-02T00:00:00.000Z', 'Limpieza', 10),
        exp('2026-08-15T00:00:00.000Z', 'Materia prima', 200),
        exp('2026-08-20T00:00:00.000Z', 'Limpieza', 5),
        exp('2026-07-30T00:00:00.000Z', 'Publicidad', 999),
      ],
      '2026-08',
    );
    expect(rows).toEqual([
      { label: 'Materia prima', value: 200 },
      { label: 'Limpieza', value: 15 },
    ]);
  });
});
