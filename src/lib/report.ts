// Read-only weekly/monthly reports over existing data — NO new doc types, NO
// new indexes (time-ordered ids make every read a cheap scanLedger range scan).
// `db` first arg, no db.ts import (node-testable, like every other logic module).
//
// Money math is never re-derived here: saleTaxes/usdPaid/round2 come from
// queries.ts, the one definition every other module already shares.

import { scanLedger, scanPrefix, saleTaxes, usdPaid } from './queries';
import { round2, round3 } from './format';
import { dailySalesSeries, type DayPoint, type RankedRow } from './panel-charts';
import { hasRollStock } from './types';
import type {
  SaleDoc,
  PaymentDoc,
  RefundDoc,
  ExpenseDoc,
  InventoryMovementDoc,
  PayrollPayDoc,
  BatchDoc,
  ProductDoc,
  ClientDoc,
} from './types';

type DB = PouchDB.Database;

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const DAY_NAMES = [
  'domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado',
];

// ---- Local-date <-> ISO-date helpers (no UTC shift — period boundaries are
// local calendar days, per the design doc). ----

/** Local calendar day as YYYY-MM-DD. The ONE definition — components import it. */
export function toIsoDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' -> local Date (never UTC-parsed — a bare `new Date(iso)` shifts the day west of UTC). */
export function fromIsoDate(iso: string): Date {
  const [y, m, day] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  if (y < 100) d.setFullYear(y); // the Date constructor maps 0..99 to 1900+y
  return d;
}

/** A fraction kept to 2 decimals OF ITS PERCENTAGE (0.357142 -> 0.3571). */
const pct4 = (v: number): number => Math.round(v * 10000) / 10000;

/** A doc's UTC instant as the LOCAL calendar day it happened on. */
const localDay = (iso: string): string => toIsoDate(new Date(iso));

export type PeriodKind = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'HALF' | 'YEAR' | 'CUSTOM';

export interface ReportPeriod {
  kind: PeriodKind;
  /** Inclusive local ISO date (YYYY-MM-DD). */
  start: string;
  /** Inclusive local ISO date (YYYY-MM-DD). */
  end: string;
  label: string;
}

export const PERIOD_KIND_LABEL: Record<PeriodKind, string> = {
  DAY: 'Día', WEEK: 'Semana', MONTH: 'Mes', QUARTER: 'Trimestre',
  HALF: 'Semestre', YEAR: 'Año', CUSTOM: 'Personalizado',
};

/** "X de MES[, año] al Y de MES de año" — shared by WEEK's and CUSTOM's labels. */
function rangeLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${start.getDate()} al ${end.getDate()} de ${MONTH_NAMES[end.getMonth()]} de ${end.getFullYear()}`;
  }
  const startYear = start.getFullYear() !== end.getFullYear() ? ` de ${start.getFullYear()}` : '';
  return `${start.getDate()} de ${MONTH_NAMES[start.getMonth()]}${startYear} al ${end.getDate()} de ${MONTH_NAMES[end.getMonth()]} de ${end.getFullYear()}`;
}

/** A single local calendar day. */
export function dayPeriod(d: Date): ReportPeriod {
  const iso = toIsoDate(d);
  const dayName = DAY_NAMES[d.getDay()];
  const label = `${dayName[0].toUpperCase()}${dayName.slice(1)}, ${d.getDate()} de ${MONTH_NAMES[d.getMonth()]} de ${d.getFullYear()}`;
  return { kind: 'DAY', start: iso, end: iso, label };
}

/** Monday..Sunday, local time. */
export function weekPeriod(d: Date): ReportPeriod {
  const day = d.getDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { kind: 'WEEK', start: toIsoDate(start), end: toIsoDate(end), label: `Semana del ${rangeLabel(start, end)}` };
}

export function monthPeriod(d: Date): ReportPeriod {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); // day 0 of next month = last day of this one
  const label = `${MONTH_NAMES[start.getMonth()][0].toUpperCase()}${MONTH_NAMES[start.getMonth()].slice(1)} ${start.getFullYear()}`;
  return { kind: 'MONTH', start: toIsoDate(start), end: toIsoDate(end), label };
}

const QUARTER_ORDINAL = ['1.er', '2.º', '3.er', '4.º'];

export function quarterPeriod(d: Date): ReportPeriod {
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth() / 3); // 0..3
  const startMonth = q * 3;
  const start = new Date(y, startMonth, 1);
  const end = new Date(y, startMonth + 3, 0);
  return { kind: 'QUARTER', start: toIsoDate(start), end: toIsoDate(end), label: `${QUARTER_ORDINAL[q]} trimestre ${y}` };
}

const HALF_ORDINAL = ['1.er', '2.º'];

export function halfPeriod(d: Date): ReportPeriod {
  const y = d.getFullYear();
  const h = d.getMonth() < 6 ? 0 : 1;
  const start = new Date(y, h * 6, 1);
  const end = new Date(y, h * 6 + 6, 0);
  return { kind: 'HALF', start: toIsoDate(start), end: toIsoDate(end), label: `${HALF_ORDINAL[h]} semestre ${y}` };
}

export function yearPeriod(d: Date): ReportPeriod {
  const y = d.getFullYear();
  const start = new Date(y, 0, 1);
  const end = new Date(y, 11, 31);
  return { kind: 'YEAR', start: toIsoDate(start), end: toIsoDate(end), label: `Año ${y}` };
}

/**
 * Arbitrary [start, end]. start > end is normalized (swapped) rather than
 * rejected — a report screen wiring two date pickers shouldn't have to
 * validate order itself before calling this.
 */
export function customPeriod(startIso: string, endIso: string): ReportPeriod {
  const a = fromIsoDate(startIso);
  const b = fromIsoDate(endIso);
  const [start, end] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
  return { kind: 'CUSTOM', start: toIsoDate(start), end: toIsoDate(end), label: `Del ${rangeLabel(start, end)}` };
}

/** The period of `kind` that contains `d`. CUSTOM has no natural container, so it falls back to the month. */
export function periodOf(kind: PeriodKind, d: Date): ReportPeriod {
  switch (kind) {
    case 'DAY': return dayPeriod(d);
    case 'WEEK': return weekPeriod(d);
    case 'MONTH': return monthPeriod(d);
    case 'QUARTER': return quarterPeriod(d);
    case 'HALF': return halfPeriod(d);
    case 'YEAR': return yearPeriod(d);
    case 'CUSTOM': return monthPeriod(d);
  }
}

/**
 * ±N periods, same kind. DAY/WEEK/MONTH/QUARTER/HALF/YEAR step by their
 * own calendar unit (never by adding milliseconds — DST breaks that); CUSTOM
 * steps by its own length in days, so ranges tile with no overlap or gap.
 */
export function shiftPeriod(p: ReportPeriod, delta: number): ReportPeriod {
  const start = fromIsoDate(p.start);
  switch (p.kind) {
    case 'DAY':
      return dayPeriod(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta));
    case 'WEEK':
      return weekPeriod(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta * 7));
    case 'MONTH':
      return monthPeriod(new Date(start.getFullYear(), start.getMonth() + delta, 1));
    case 'QUARTER':
      return quarterPeriod(new Date(start.getFullYear(), start.getMonth() + delta * 3, 1));
    case 'HALF':
      return halfPeriod(new Date(start.getFullYear(), start.getMonth() + delta * 6, 1));
    case 'YEAR':
      return yearPeriod(new Date(start.getFullYear() + delta, 0, 1));
    case 'CUSTOM': {
      const spanDays = Math.round((fromIsoDate(p.end).getTime() - start.getTime()) / 86_400_000) + 1;
      const newStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta * spanDays);
      const newEnd = new Date(newStart.getFullYear(), newStart.getMonth(), newStart.getDate() + spanDays - 1);
      return customPeriod(toIsoDate(newStart), toIsoDate(newEnd));
    }
  }
}

// ---- Report data ----

export interface SalesSummary {
  count: number;
  baseUsd: number;
  ivaUsd: number;
  igtfUsd: number;
  grandTotalUsd: number;
  onBooksCount: number;
  offBooksCount: number;
}

export interface CollectionsSummary {
  paymentsCount: number;
  collectedUsd: number;
  refundsCount: number;
  refundedUsd: number;
}

export interface ExpensesSummary {
  count: number;
  totalUsd: number;
  fixedUsd: number;
  variableUsd: number;
  byCategory: { category: string; count: number; totalUsd: number }[];
}

export interface MovementsSummary {
  byReason: { reason: string; count: number; kg: number; units: number }[];
  kgIn: number;
  kgOut: number;
  unitsIn: number;
  unitsOut: number;
}

/** batch: color · NM · fabricType — same shape used everywhere else (frozen descriptions, panel). */
function batchLabel(batch: BatchDoc | undefined, fallback: string): string {
  return batch ? `${batch.color} · ${batch.nm} · ${batch.fabricType}` : fallback;
}

/** Top `n` entries of a label→value map, descending, no "Otros" fold (unlike panel-charts' ranked). */
function topN(m: Map<string, number>, n: number, round: (v: number) => number = round2): RankedRow[] {
  return [...m.entries()]
    .map(([label, value]) => ({ label, value: round(value) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

export interface ReportData {
  period: ReportPeriod;
  sales: SalesSummary;
  collections: CollectionsSummary;
  expenses: ExpensesSummary;
  movements: MovementsSummary;
  daily: DayPoint[];
  /** HOUR for a single-day period (24 points); DAY up to 62 days; MONTH beyond that (a year of daily points is unreadable/unbounded in the "Ver datos" table). */
  seriesGranularity: 'HOUR' | 'DAY' | 'MONTH';
  avgTicketUsd: number;
  bestDay: { date: string; totalUsd: number } | null;
  topClients: RankedRow[];
  topArticles: { label: string; usd: number; kg: number; units: number }[];
  cogs: { costUsd: number; grossMarginUsd: number; marginPct: number; coverage: number };
  previous: { count: number; grandTotalUsd: number; expensesTotalUsd: number; collectedUsd: number };
  inventory: { topOut: RankedRow[]; topIn: RankedRow[] };
  stockNow: { batches: number; kg: number; units: number; valueUsd: number };
}

function summarizeSales(sales: SaleDoc[]): SalesSummary {
  let baseUsd = 0, ivaUsd = 0, igtfUsd = 0, grandTotalUsd = 0, onBooksCount = 0, offBooksCount = 0;
  for (const sale of sales) {
    // NEVER re-derived — pre-tax sales read as 0-rate and keep their totals.
    const t = saleTaxes(sale);
    baseUsd += t.baseUsd;
    ivaUsd += t.ivaUsd;
    igtfUsd += t.igtfUsd;
    grandTotalUsd += t.grandTotalUsd;
    if (sale.isOnTheBooks) onBooksCount++; else offBooksCount++;
  }
  return {
    count: sales.length,
    baseUsd: round2(baseUsd),
    ivaUsd: round2(ivaUsd),
    igtfUsd: round2(igtfUsd),
    grandTotalUsd: round2(grandTotalUsd),
    onBooksCount,
    offBooksCount,
  };
}

function summarizeCollections(payments: PaymentDoc[], refunds: RefundDoc[]): CollectionsSummary {
  let collectedUsd = 0;
  for (const p of payments) collectedUsd += usdPaid(p.paidUsdCash, p.paidUsdTransfer, p.paidBs, p.exchangeRateBCV);
  let refundedUsd = 0;
  for (const r of refunds) refundedUsd += usdPaid(r.givenUsdCash, r.givenUsdTransfer, r.givenBs, r.exchangeRateBCV);
  return {
    paymentsCount: payments.length,
    collectedUsd: round2(collectedUsd),
    refundsCount: refunds.length,
    refundedUsd: round2(refundedUsd),
  };
}

function summarizeExpenses(expenses: ExpenseDoc[]): ExpensesSummary {
  let totalUsd = 0, fixedUsd = 0, variableUsd = 0;
  const byCategory = new Map<string, { count: number; totalUsd: number }>();
  for (const e of expenses) {
    totalUsd += e.amountUsd;
    if (e.isFixedExpense) fixedUsd += e.amountUsd; else variableUsd += e.amountUsd;
    const entry = byCategory.get(e.category) ?? { count: 0, totalUsd: 0 };
    entry.count++;
    entry.totalUsd += e.amountUsd;
    byCategory.set(e.category, entry);
  }
  return {
    count: expenses.length,
    totalUsd: round2(totalUsd),
    fixedUsd: round2(fixedUsd),
    variableUsd: round2(variableUsd),
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, count: v.count, totalUsd: round2(v.totalUsd) }))
      .sort((a, b) => b.totalUsd - a.totalUsd),
  };
}

function summarizeMovements(movements: InventoryMovementDoc[]): MovementsSummary {
  let kgIn = 0, kgOut = 0, unitsIn = 0, unitsOut = 0;
  const byReason = new Map<string, { count: number; kg: number; units: number }>();
  for (const m of movements) {
    const entry = byReason.get(m.reason) ?? { count: 0, kg: 0, units: 0 };
    entry.count++;
    // Line-level aggregation: a movement can mix signs (an exchange is one
    // movement with both legs), so the In/Out split has to look at lines, not
    // the movement as a whole.
    for (const li of m.lineItems) {
      if (li.unitOfMeasure === 'Kg') {
        entry.kg += li.quantityChanged;
        if (li.quantityChanged > 0) kgIn += li.quantityChanged; else kgOut += -li.quantityChanged;
      } else {
        entry.units += li.quantityChanged;
        if (li.quantityChanged > 0) unitsIn += li.quantityChanged; else unitsOut += -li.quantityChanged;
      }
    }
    byReason.set(m.reason, entry);
  }
  return {
    byReason: [...byReason.entries()].map(([reason, v]) => ({
      reason, count: v.count, kg: round3(v.kg), units: round2(v.units),
    })),
    kgIn: round3(kgIn),
    kgOut: round3(kgOut),
    unitsIn: round2(unitsIn),
    unitsOut: round2(unitsOut),
  };
}

/**
 * Ledger scan bounds for a period. Ids embed a UTC instant while the period is
 * local calendar days, so the bounds are the local day's first/last instant —
 * the bare YYYY-MM-DD shifts the window by the UTC offset, and in VET (-04)
 * every sale after 20:00 was reported in the following day (and month).
 */
export function periodScanOpts(period: ReportPeriod): { startDate: string; endDate: string } {
  // The end bound is 1 ms before the NEXT local midnight — never
  // setHours(23,…), which on a 25-hour day (DST fallback at midnight, e.g.
  // Chile) resolves to the first pass of 23:00 and leaves the repeated hour
  // in no period at all.
  const next = fromIsoDate(period.end);
  next.setDate(next.getDate() + 1);
  return { startDate: fromIsoDate(period.start).toISOString(), endDate: new Date(next.getTime() - 1).toISOString() };
}

/** Daily points folded into one point per calendar month (first-of-month date), summed. */
function monthlySeries(daily: DayPoint[]): DayPoint[] {
  const byMonth = new Map<string, DayPoint>();
  const first = daily[0]?.date ?? ''; // the period's own start day
  for (const d of daily) {
    const month = `${d.date.slice(0, 7)}-01`;
    // A partial first month keeps the period's start as its key: day 1 is
    // outside the reported range and reads as a real day in the chart/table.
    const key = month < first ? first : month;
    const entry = byMonth.get(key) ?? { date: key, facturadoUsd: 0, cobradoUsd: 0 };
    entry.facturadoUsd += d.facturadoUsd;
    entry.cobradoUsd += d.cobradoUsd;
    byMonth.set(key, entry);
  }
  return [...byMonth.values()].map((p) => ({
    ...p, facturadoUsd: round2(p.facturadoUsd), cobradoUsd: round2(p.cobradoUsd),
  }));
}

/**
 * 24 hourly points (00..23, local time) for a single-day period — the same
 * figures dailySalesSeries computes for a whole day, split by local hour.
 */
function hourlySeries(sales: SaleDoc[], payments: PaymentDoc[], refunds: RefundDoc[], dayIso: string): DayPoint[] {
  const base = fromIsoDate(dayIso);
  const points: DayPoint[] = Array.from({ length: 24 }, (_, h) => ({
    date: new Date(base.getFullYear(), base.getMonth(), base.getDate(), h).toISOString(),
    label: `${String(h).padStart(2, '0')}:00`,
    facturadoUsd: 0,
    cobradoUsd: 0,
  }));
  for (const s of sales) {
    const p = points[new Date(s.date).getHours()];
    p.facturadoUsd += saleTaxes(s).grandTotalUsd;
    p.cobradoUsd += usdPaid(s.paidUsdCash, s.paidUsdTransfer, s.paidBs, s.exchangeRateBCV);
  }
  for (const pay of payments) {
    points[new Date(pay.date).getHours()].cobradoUsd += usdPaid(pay.paidUsdCash, pay.paidUsdTransfer, pay.paidBs, pay.exchangeRateBCV);
  }
  for (const r of refunds) {
    points[new Date(r.date).getHours()].cobradoUsd -= usdPaid(r.givenUsdCash, r.givenUsdTransfer, r.givenBs, r.exchangeRateBCV);
  }
  return points.map((p) => ({ ...p, facturadoUsd: round2(p.facturadoUsd), cobradoUsd: round2(p.cobradoUsd) }));
}

/** Every summary in the period, zeroed (never throws) when it is empty. */
export async function buildReport(db: DB, period: ReportPeriod): Promise<ReportData> {
  const opts = periodScanOpts(period);
  const prevPeriod = shiftPeriod(period, -1);
  const prevOpts = periodScanOpts(prevPeriod);
  const [sales, payments, refunds, expenses, movements, batches, products, clients, prevSales, prevPayments, prevRefunds, prevExpenses] = await Promise.all([
    scanLedger<SaleDoc>(db, 'sale:', opts),
    scanLedger<PaymentDoc>(db, 'payment:', opts),
    scanLedger<RefundDoc>(db, 'refund:', opts),
    scanLedger<ExpenseDoc>(db, 'expense:', opts),
    scanLedger<InventoryMovementDoc>(db, 'movement:', opts),
    scanPrefix<BatchDoc>(db, 'batch:'),
    scanPrefix<ProductDoc>(db, 'product:'),
    scanPrefix<ClientDoc>(db, 'client:'),
    scanLedger<SaleDoc>(db, 'sale:', prevOpts),
    scanLedger<PaymentDoc>(db, 'payment:', prevOpts),
    scanLedger<RefundDoc>(db, 'refund:', prevOpts),
    scanLedger<ExpenseDoc>(db, 'expense:', prevOpts),
  ]);

  const salesSummary = summarizeSales(sales);
  const batchById = new Map(batches.map((b) => [b._id, b]));
  const productById = new Map(products.map((p) => [p._id, p]));
  const productsByBatchId = new Map<string, ProductDoc[]>();
  for (const p of products) {
    const arr = productsByBatchId.get(p.batchId) ?? [];
    arr.push(p);
    productsByBatchId.set(p.batchId, arr);
  }
  const clientById = new Map(clients.map((c) => [c._id, c]));

  // ---- Daily series — exactly the period's calendar days, zero-filled. ----
  const days = Math.round(
    (fromIsoDate(period.end).getTime() - fromIsoDate(period.start).getTime()) / 86_400_000,
  ) + 1;
  // A single-day period gets an hourly breakdown — one daily point is not a
  // chart. Beyond ~2 months a daily line/table is unreadable (and unbounded —
  // a year is 365 rows in the "Ver datos" table), so the series collapses to
  // one point per month, summed from the same daily figures (never re-derived).
  const seriesGranularity: 'HOUR' | 'DAY' | 'MONTH' = days === 1 ? 'HOUR' : days > 62 ? 'MONTH' : 'DAY';
  let daily: DayPoint[];
  let bestDay: { date: string; totalUsd: number } | null = null;
  if (seriesGranularity === 'HOUR') {
    daily = hourlySeries(sales, payments, refunds, period.start);
    bestDay = salesSummary.count > 0 ? { date: period.start, totalUsd: salesSummary.grandTotalUsd } : null;
  } else {
    // Local day keys — the same calendar the period bounds use, so every
    // scanned doc lands in one of the buckets.
    const dailyRaw = dailySalesSeries(sales, payments, refunds, days, period.end, localDay);
    daily = seriesGranularity === 'DAY' ? dailyRaw : monthlySeries(dailyRaw);
    // bestDay is always a real DAY, even when the series above is monthly.
    for (const d of dailyRaw) {
      if (d.facturadoUsd > 0 && (!bestDay || d.facturadoUsd > bestDay.totalUsd)) {
        bestDay = { date: d.date, totalUsd: d.facturadoUsd };
      }
    }
  }
  const avgTicketUsd = salesSummary.count > 0 ? round2(salesSummary.grandTotalUsd / salesSummary.count) : 0;

  // ---- Top clients / articles / COGS — one pass over lineItems. ----
  const byClient = new Map<string, number>();
  const articleUsd = new Map<string, number>();
  const articleKg = new Map<string, number>();
  const articleUnits = new Map<string, number>();
  const articleLabel = new Map<string, string>();
  let costUsd = 0, coveredSubtotal = 0, totalSubtotal = 0;
  for (const s of sales) {
    const clientLabel = s.clientId ? (clientById.get(s.clientId)?.name ?? s.clientId) : 'Contado';
    byClient.set(clientLabel, (byClient.get(clientLabel) ?? 0) + saleTaxes(s).grandTotalUsd);
    for (const li of s.lineItems) {
      articleUsd.set(li.batchId, (articleUsd.get(li.batchId) ?? 0) + li.lineSubtotalUsd);
      if (li.unitOfMeasure === 'Kg') {
        articleKg.set(li.batchId, (articleKg.get(li.batchId) ?? 0) + li.quantity);
      } else {
        articleUnits.set(li.batchId, (articleUnits.get(li.batchId) ?? 0) + li.quantity);
      }
      if (!articleLabel.has(li.batchId)) {
        articleLabel.set(li.batchId, batchLabel(batchById.get(li.batchId), li.batchId));
      }
      const product = productById.get(li.productId);
      costUsd += li.quantity * (product?.purchaseValueUsd ?? 0);
      totalSubtotal += li.lineSubtotalUsd;
      if (product && product.purchaseValueUsd > 0) coveredSubtotal += li.lineSubtotalUsd;
    }
  }
  const topClients = topN(byClient, 8);
  const topArticles = [...articleUsd.entries()]
    .map(([batchId, usd]) => ({
      label: articleLabel.get(batchId) ?? batchId,
      usd: round2(usd),
      kg: round3(articleKg.get(batchId) ?? 0),
      units: round2(articleUnits.get(batchId) ?? 0),
    }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 10);
  const grossMarginUsd = round2(salesSummary.baseUsd - costUsd);
  const cogs = {
    costUsd: round2(costUsd),
    grossMarginUsd,
    // 4 decimals: these are fractions rendered as percentages, so round2 here
    // would quantise every margin to whole points.
    marginPct: salesSummary.baseUsd > 0 ? pct4(grossMarginUsd / salesSummary.baseUsd) : 0,
    coverage: totalSubtotal > 0 ? pct4(coveredSubtotal / totalSubtotal) : 0,
  };

  // ---- Previous period, for variance. ----
  const prevSalesSummary = summarizeSales(prevSales);
  const prevCollections = summarizeCollections(prevPayments, prevRefunds);
  const prevExpensesSummary = summarizeExpenses(prevExpenses);
  const previous = {
    count: prevSalesSummary.count,
    grandTotalUsd: prevSalesSummary.grandTotalUsd,
    expensesTotalUsd: prevExpensesSummary.totalUsd,
    collectedUsd: prevCollections.collectedUsd,
  };

  // ---- Inventory movement — top Kg in/out by article, line-level (mixed signs). ----
  const kgIn = new Map<string, number>();
  const kgOut = new Map<string, number>();
  for (const m of movements) {
    for (const li of m.lineItems) {
      if (li.unitOfMeasure !== 'Kg') continue;
      const batchId = productById.get(li.productId)?.batchId;
      const label = batchLabel(batchId ? batchById.get(batchId) : undefined, li.productId);
      if (li.quantityChanged > 0) kgIn.set(label, (kgIn.get(label) ?? 0) + li.quantityChanged);
      else kgOut.set(label, (kgOut.get(label) ?? 0) + -li.quantityChanged);
    }
  }
  const inventory = { topOut: topN(kgOut, 8, round3), topIn: topN(kgIn, 8, round3) };

  // ---- Current stock snapshot ("hoy", not the period). ----
  let stockBatches = 0, stockKg = 0, stockUnits = 0, stockValueUsd = 0;
  for (const b of batches) {
    if (b.currentUnits <= 0) continue;
    stockBatches++;
    const batchProducts = productsByBatchId.get(b._id) ?? [];
    if (b.productType === 'ROLL') {
      for (const p of batchProducts) {
        if (!hasRollStock(p.currentWeightKg)) continue;
        stockKg += p.currentWeightKg;
        stockValueUsd += p.currentWeightKg * p.purchaseValueUsd;
      }
    } else {
      stockUnits += b.currentUnits;
      stockValueUsd += b.currentUnits * (batchProducts[0]?.purchaseValueUsd ?? 0);
    }
  }
  const stockNow = {
    batches: stockBatches,
    kg: round3(stockKg),
    units: round2(stockUnits),
    valueUsd: round2(stockValueUsd),
  };

  return {
    period,
    sales: salesSummary,
    collections: summarizeCollections(payments, refunds),
    expenses: summarizeExpenses(expenses),
    movements: summarizeMovements(movements),
    daily,
    seriesGranularity,
    avgTicketUsd,
    bestDay,
    topClients,
    topArticles,
    cogs,
    previous,
    inventory,
    stockNow,
  };
}

export interface PayrollSummary {
  count: number;
  totalUsd: number;
}

/** Separate fn — the island calls it only when isAdmin() (nómina DB is admin-only). */
export async function buildPayrollSummary(nominaDb: DB, period: ReportPeriod): Promise<PayrollSummary> {
  const pays = await scanLedger<PayrollPayDoc>(nominaDb, 'payrollpay:', periodScanOpts(period));
  let totalUsd = 0;
  for (const p of pays) totalUsd += p.totalUsd;
  return { count: pays.length, totalUsd: round2(totalUsd) };
}
