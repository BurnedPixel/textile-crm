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

// ---- Local-date <-> ISO-date helpers (no UTC shift — period boundaries are
// local calendar days, per the design doc). ----

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromIsoDate(iso: string): Date {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(y, m - 1, day);
}

/** A fraction kept to 2 decimals OF ITS PERCENTAGE (0.357142 -> 0.3571). */
const pct4 = (v: number): number => Math.round(v * 10000) / 10000;

/** A doc's UTC instant as the LOCAL calendar day it happened on. */
const localDay = (iso: string): string => toIsoDate(new Date(iso));

export interface ReportPeriod {
  kind: 'WEEK' | 'MONTH';
  /** Inclusive local ISO date (YYYY-MM-DD). */
  start: string;
  /** Inclusive local ISO date (YYYY-MM-DD). */
  end: string;
  label: string;
}

function weekLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `Semana del ${start.getDate()} al ${end.getDate()} de ${MONTH_NAMES[end.getMonth()]} de ${end.getFullYear()}`;
  }
  const startYear = start.getFullYear() !== end.getFullYear() ? ` de ${start.getFullYear()}` : '';
  return `Semana del ${start.getDate()} de ${MONTH_NAMES[start.getMonth()]}${startYear} al ${end.getDate()} de ${MONTH_NAMES[end.getMonth()]} de ${end.getFullYear()}`;
}

/** Monday..Sunday, local time. */
export function weekPeriod(d: Date): ReportPeriod {
  const day = d.getDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { kind: 'WEEK', start: toIsoDate(start), end: toIsoDate(end), label: weekLabel(start, end) };
}

export function monthPeriod(d: Date): ReportPeriod {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); // day 0 of next month = last day of this one
  const label = `${MONTH_NAMES[start.getMonth()][0].toUpperCase()}${MONTH_NAMES[start.getMonth()].slice(1)} ${start.getFullYear()}`;
  return { kind: 'MONTH', start: toIsoDate(start), end: toIsoDate(end), label };
}

/** ±N periods — a week shifts by 7 days, a month by N calendar months. */
export function shiftPeriod(p: ReportPeriod, delta: number): ReportPeriod {
  const start = fromIsoDate(p.start);
  if (p.kind === 'WEEK') {
    return weekPeriod(new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta * 7));
  }
  return monthPeriod(new Date(start.getFullYear(), start.getMonth() + delta, 1));
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
  const end = fromIsoDate(period.end);
  end.setHours(23, 59, 59, 999);
  return { startDate: fromIsoDate(period.start).toISOString(), endDate: end.toISOString() };
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
  // Local day keys — the same calendar the period bounds use, so every scanned
  // doc lands in one of the buckets.
  const daily = dailySalesSeries(sales, payments, refunds, days, period.end, localDay);
  let bestDay: { date: string; totalUsd: number } | null = null;
  for (const d of daily) {
    if (d.facturadoUsd > 0 && (!bestDay || d.facturadoUsd > bestDay.totalUsd)) {
      bestDay = { date: d.date, totalUsd: d.facturadoUsd };
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
