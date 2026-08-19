// Chart data for the Panel — PURE functions over docs the Dashboard already
// fetches. No DB access here: the Panel's read cost stays exactly what it was
// (cached counters + the existing ledger scans), and everything is node-testable
// without an adapter.
//
// Money rules honored: facturado = grandTotalUsd (saleTaxes, never re-derived);
// cobrado = cash flow, each doc's Bs converted at ITS OWN locked rate (usdPaid).

import type { SaleDoc, PaymentDoc, RefundDoc, ExpenseDoc, BatchDoc, ProductDoc } from './types';
import { grandTotalUsd, usdPaid } from './queries';
import { round2 } from './format';

export interface DayPoint {
  /** YYYY-MM-DD (UTC day, same convention as the Panel's todaySales) — or an ISO instant when `label` overrides the axis text (report.ts hourly series). */
  date: string;
  /** Grand totals of sales dated that day. */
  facturadoUsd: number;
  /** Cash in that day: checkout money + later cobros − vueltos, each at its own rate. */
  cobradoUsd: number;
  /** Overrides the axis/tooltip/table text derived from `date` (e.g. "14:00" for an hourly point). Panel points never set this. */
  label?: string;
}

/** Last `days` calendar days ending at `todayIso` (YYYY-MM-DD), zero-filled. */
export function dailySalesSeries(
  sales: SaleDoc[],
  payments: PaymentDoc[],
  refunds: RefundDoc[],
  days: number,
  todayIso: string,
  /**
   * Instant -> day key. Default: UTC day (the Panel's convention, same as
   * todaySales); report.ts passes a local-day key so its buckets match the
   * local calendar its periods are built from.
   */
  dayOf: (iso: string) => string = (iso) => iso.slice(0, 10),
): DayPoint[] {
  const points = new Map<string, DayPoint>();
  const end = new Date(`${todayIso}T00:00:00Z`).getTime();
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    points.set(date, { date, facturadoUsd: 0, cobradoUsd: 0 });
  }
  for (const s of sales) {
    const p = points.get(dayOf(s.date));
    if (!p) continue;
    p.facturadoUsd += grandTotalUsd(s);
    p.cobradoUsd += usdPaid(s.paidUsdCash, s.paidUsdTransfer, s.paidBs, s.exchangeRateBCV);
  }
  for (const pay of payments) {
    const p = points.get(dayOf(pay.date));
    if (p) p.cobradoUsd += usdPaid(pay.paidUsdCash, pay.paidUsdTransfer, pay.paidBs, pay.exchangeRateBCV);
  }
  for (const r of refunds) {
    const p = points.get(dayOf(r.date));
    if (p) p.cobradoUsd -= usdPaid(r.givenUsdCash, r.givenUsdTransfer, r.givenBs, r.exchangeRateBCV);
  }
  return [...points.values()].map((p) => ({
    ...p,
    facturadoUsd: round2(p.facturadoUsd),
    cobradoUsd: round2(p.cobradoUsd),
  }));
}

export interface RankedRow {
  label: string;
  value: number;
}

/** Rank a label→value map descending; past `topN` rows the tail folds into «Otros». */
function ranked(m: Map<string, number>, topN: number): RankedRow[] {
  const rows = [...m.entries()]
    .map(([label, value]) => ({ label, value: round2(value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  if (rows.length <= topN) return rows;
  const head = rows.slice(0, topN);
  const tail = round2(rows.slice(topN).reduce((s, r) => s + r.value, 0));
  return [...head, { label: 'Otros', value: tail }];
}

/** Stock grouped by fabric. Kg (ROLL) and Units (COMBO/PIECE) NEVER mix — two lists. */
export function stockByFabric(
  stocked: Array<{ batch: BatchDoc; products: ProductDoc[] }>,
  topN = 6,
): { kg: RankedRow[]; units: RankedRow[] } {
  const kg = new Map<string, number>();
  const units = new Map<string, number>();
  for (const { batch, products } of stocked) {
    if (batch.productType === 'ROLL') {
      const w = products.reduce((s, p) => s + p.currentWeightKg, 0);
      kg.set(batch.fabricType, (kg.get(batch.fabricType) ?? 0) + w);
    } else {
      units.set(batch.fabricType, (units.get(batch.fabricType) ?? 0) + batch.currentUnits);
    }
  }
  return { kg: ranked(kg, topN), units: ranked(units, topN) };
}

/** Expenses of the calendar month `monthIso` (YYYY-MM) by category, ranked. */
export function expensesByCategory(
  expenses: ExpenseDoc[],
  monthIso: string,
  topN = 6,
): RankedRow[] {
  const byCat = new Map<string, number>();
  for (const e of expenses) {
    if (e.date.slice(0, 7) !== monthIso) continue;
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amountUsd);
  }
  return ranked(byCat, topN);
}
