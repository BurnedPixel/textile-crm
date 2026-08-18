// Read-only weekly/monthly reports over existing data — NO new doc types, NO
// new indexes (time-ordered ids make every read a cheap scanLedger range scan).
// `db` first arg, no db.ts import (node-testable, like every other logic module).
//
// Money math is never re-derived here: saleTaxes/usdPaid/round2 come from
// queries.ts, the one definition every other module already shares.

import { scanLedger, saleTaxes, usdPaid } from './queries';
import { round2, round3 } from './format';
import type {
  SaleDoc,
  PaymentDoc,
  RefundDoc,
  ExpenseDoc,
  InventoryMovementDoc,
  PayrollPayDoc,
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

export interface ReportData {
  period: ReportPeriod;
  sales: SalesSummary;
  collections: CollectionsSummary;
  expenses: ExpensesSummary;
  movements: MovementsSummary;
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

/** Every summary in the period, zeroed (never throws) when it is empty. */
export async function buildReport(db: DB, period: ReportPeriod): Promise<ReportData> {
  const opts = { startDate: period.start, endDate: period.end };
  const [sales, payments, refunds, expenses, movements] = await Promise.all([
    scanLedger<SaleDoc>(db, 'sale:', opts),
    scanLedger<PaymentDoc>(db, 'payment:', opts),
    scanLedger<RefundDoc>(db, 'refund:', opts),
    scanLedger<ExpenseDoc>(db, 'expense:', opts),
    scanLedger<InventoryMovementDoc>(db, 'movement:', opts),
  ]);
  return {
    period,
    sales: summarizeSales(sales),
    collections: summarizeCollections(payments, refunds),
    expenses: summarizeExpenses(expenses),
    movements: summarizeMovements(movements),
  };
}

export interface PayrollSummary {
  count: number;
  totalUsd: number;
}

/** Separate fn — the island calls it only when isAdmin() (nómina DB is admin-only). */
export async function buildPayrollSummary(nominaDb: DB, period: ReportPeriod): Promise<PayrollSummary> {
  const pays = await scanLedger<PayrollPayDoc>(nominaDb, 'payrollpay:', {
    startDate: period.start, endDate: period.end,
  });
  let totalUsd = 0;
  for (const p of pays) totalUsd += p.totalUsd;
  return { count: pays.length, totalUsd: round2(totalUsd) };
}
