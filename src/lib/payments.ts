// Collections recorded after checkout. Takes `db` first; no browser imports.
//
// Sales are immutable, so a later collection cannot update the sale — it is its
// own append-only `payment:` document, and what a client owes TODAY is derived:
// the sale's own payments plus every payment doc pointing at it. Nothing in this
// module ever writes to a sale.
//
// NEVER reads SystemConfig — exchangeRateBCV is a parameter, locked per payment,
// exactly like checkout() and addExpense().

import {
  paymentIdOf, refundIdOf, assertAmount, FIELD_MAX,
  type PaymentDoc, type RefundDoc, type SaleDoc, type PaymentStatus,
} from './types';
import { round2 } from './format';
// usdPaid/statusForPaid live in queries.ts beside computePaymentStatus so the
// checkout status and the derived balance can never drift apart.
import { SETTLED_EPSILON, grandTotalUsd, statusForPaid, usdPaid, uuidv4 } from './queries';

type DB = PouchDB.Database;

export interface SaleBalance {
  /** Money received: at checkout plus every later collection. */
  paidUsd: number;
  /** ≥ 0 — what the client still owes the business. */
  owedUsd: number;
  /**
   * ≥ 0 — what the business still owes the client («vuelto»/saldo a favor):
   * money received beyond the grand total, minus change already handed back.
   * At most one of owedUsd/creditUsd is non-zero. Display sites gate on
   * `> SETTLED_EPSILON`, symmetric with statusForPaid's settled band.
   */
  creditUsd: number;
  status: PaymentStatus;
}

/**
 * What a sale is worth today. `payments` are the sale's collections, `refunds`
 * the change handed back — BOTH are required on purpose: an optional parameter
 * is how a read site silently goes refund-blind and shows phantom or invisible
 * debt (the exact half-migration the 2026-07-30 log warns about). Pass [] only
 * when the doc genuinely has none (e.g. the checkout success view).
 */
export function saleBalance(sale: SaleDoc, payments: PaymentDoc[], refunds: RefundDoc[]): SaleBalance {
  const atCheckout = usdPaid(sale.paidUsdCash, sale.paidUsdTransfer, sale.paidBs, sale.exchangeRateBCV);
  const collected = payments.reduce(
    (sum, p) => sum + usdPaid(p.paidUsdCash, p.paidUsdTransfer, p.paidBs, p.exchangeRateBCV),
    0,
  );
  // Each refund's Bs converts at the rate locked on THAT refund — the day the
  // change was handed over, not the sale's rate and not today's.
  const refunded = refunds.reduce(
    (sum, r) => sum + usdPaid(r.givenUsdCash, r.givenUsdTransfer, r.givenBs, r.exchangeRateBCV),
    0,
  );
  const paidUsd = round2(atCheckout + collected);
  // What the business still HOLDS for this sale, after change given back.
  const held = round2(paidUsd - refunded);
  // What is owed is the GRAND total — base + IVA + IGTF — not the pre-tax
  // figure the document stores. Every derived balance in the app comes through
  // here, which is why the switch happens once, at this line.
  const owed = grandTotalUsd(sale);
  return {
    paidUsd,
    owedUsd: round2(Math.max(0, owed - held)),
    creditUsd: round2(Math.max(0, held - owed)),
    status: statusForPaid(owed, held),
  };
}

export interface ClientBalance {
  /** Sum of every sale's owedUsd — what the client owes. */
  owedToBusinessUsd: number;
  /** Sum of every sale's creditUsd — what the business owes the client. */
  owedToClientUsd: number;
}

/**
 * Both directions of a client's balance, NOT netted: a client can owe on sale A
 * and be owed change on sale B, and netting would hide both facts.
 */
export function clientBalance(
  sales: SaleDoc[],
  paymentsFor: Map<string, PaymentDoc[]>,
  refundsFor: Map<string, RefundDoc[]>,
): ClientBalance {
  let owed = 0;
  let credit = 0;
  for (const sale of sales) {
    const b = saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []);
    owed += b.owedUsd;
    credit += b.creditUsd;
  }
  return { owedToBusinessUsd: round2(owed), owedToClientUsd: round2(credit) };
}

/** Every payment, oldest first (ids are time-ordered). */
export async function getPayments(db: DB, opts: { saleId?: string } = {}): Promise<PaymentDoc[]> {
  const res = await db.allDocs<PaymentDoc>({
    include_docs: true,
    startkey: 'payment:',
    endkey: 'payment:￰',
  });
  const all = res.rows.map((r) => r.doc as PaymentDoc).filter(Boolean);
  return opts.saleId ? all.filter((p) => p.saleId === opts.saleId) : all;
}

/** Every refund («vuelto entregado»), oldest first (ids are time-ordered). */
export async function getRefunds(db: DB, opts: { saleId?: string } = {}): Promise<RefundDoc[]> {
  const res = await db.allDocs<RefundDoc>({
    include_docs: true,
    startkey: 'refund:',
    endkey: 'refund:￰',
  });
  const all = res.rows.map((r) => r.doc as RefundDoc).filter(Boolean);
  return opts.saleId ? all.filter((r) => r.saleId === opts.saleId) : all;
}

/** Group docs by the sale they belong to — one pass, for list screens. */
function bySaleId<T extends { saleId: string }>(docs: T[]): Map<string, T[]> {
  const bySale = new Map<string, T[]>();
  for (const d of docs) {
    const list = bySale.get(d.saleId);
    if (list) list.push(d);
    else bySale.set(d.saleId, [d]);
  }
  return bySale;
}

export const paymentsBySale = (payments: PaymentDoc[]): Map<string, PaymentDoc[]> => bySaleId(payments);
export const refundsBySale = (refunds: RefundDoc[]): Map<string, RefundDoc[]> => bySaleId(refunds);

export interface RecordPaymentInput {
  saleId: string;
  /** Read ONCE from SystemConfig by the caller, then locked onto this payment. */
  exchangeRateBCV: number;
  paidUsdCash: number;
  paidUsdTransfer: number;
  paidBs: number;
  note?: string;
  operatorId: string;
  /** ISO; defaults to now. Part of the _id, so it is also the idempotency key. */
  date?: string;
  /**
   * Operator confirmed there is no change to give right now: the excess becomes
   * a saldo a favor (creditUsd) instead of being rejected as a typo. Never
   * stored — the document just records what was actually handed over.
   */
  allowOverpayment?: boolean;
}

/**
 * Record a collection against a sale. Validates at the boundary (Spanish errors)
 * — the UI's checks are convenience, this is the contract.
 */
export async function recordPayment(db: DB, input: RecordPaymentInput): Promise<PaymentDoc> {
  const { paidUsdCash, paidUsdTransfer, paidBs } = input;
  assertAmount(input.exchangeRateBCV, 'La tasa de cambio');
  for (const amount of [paidUsdCash, paidUsdTransfer, paidBs]) {
    assertAmount(amount, 'El monto del cobro', { allowZero: true });
  }
  if ((input.note ?? '').length > FIELD_MAX.note) {
    throw new Error(`La referencia no puede superar ${FIELD_MAX.note} caracteres.`);
  }

  const amountUsd = usdPaid(paidUsdCash, paidUsdTransfer, paidBs, input.exchangeRateBCV);
  if (!(amountUsd > 0)) throw new Error('El cobro debe ser mayor que cero.');

  const sale = await getSale(db, input.saleId);
  if (!sale) throw new Error(`Venta no encontrada: ${input.saleId}`);

  // Overpayment is USUALLY a typo — an extra digit would otherwise read as
  // "pagada" and leave the difference unaccounted for anywhere. When the
  // operator explicitly confirms it (client pays a $20 debt with a $100 bill,
  // no change available), the excess derives as creditUsd instead.
  const { owedUsd } = saleBalance(
    sale,
    await getPayments(db, { saleId: input.saleId }),
    await getRefunds(db, { saleId: input.saleId }),
  );
  if (!input.allowOverpayment && amountUsd > owedUsd + SETTLED_EPSILON) {
    throw new Error(
      `El cobro (${round2(amountUsd)} $) excede el saldo pendiente de la venta (${owedUsd} $).`,
    );
  }

  const date = input.date ?? new Date().toISOString();
  const payment: PaymentDoc = {
    _id: paymentIdOf(date, uuidv4()),
    type: 'payment',
    paymentId: `${input.saleId}:cobro:${date}`,
    saleId: input.saleId,
    date,
    exchangeRateBCV: input.exchangeRateBCV,
    paidUsdCash: round2(paidUsdCash),
    paidUsdTransfer: round2(paidUsdTransfer),
    paidBs: round2(paidBs),
    note: input.note?.trim() ?? '',
    operatorId: input.operatorId,
  };
  await db.put(payment);
  return payment;
}

export interface RecordRefundInput {
  saleId: string;
  /** Read ONCE from SystemConfig by the caller, then locked onto this refund. */
  exchangeRateBCV: number;
  givenUsdCash: number;
  givenUsdTransfer: number;
  givenBs: number;
  note?: string;
  operatorId: string;
  /** ISO; defaults to now. */
  date?: string;
  /**
   * Idempotency: the DIALOG mints this uuid once when it opens (with `date`),
   * making the _id deterministic across retries — a double-submit finds the
   * existing doc and returns it, never a second $20 on paper. Same mechanism
   * as checkout's transactionId. Omitted (scripts): a fresh uuid per call.
   */
  refundUid?: string;
}

/**
 * Record change handed BACK to the client («vuelto entregado»), settling a
 * saldo a favor. Its own append-only doc type — a payment and a refund move
 * money in opposite directions, and the direction lives in the TYPE, never in
 * a negative amount, so assertAmount keeps rejecting negatives everywhere.
 *
 * NOT for devoluciones de tela: fabric returns move stock through returnStock
 * and have no money leg. This settles overpayment credit only — the cap below
 * enforces exactly that.
 */
export async function recordRefund(db: DB, input: RecordRefundInput): Promise<RefundDoc> {
  const { givenUsdCash, givenUsdTransfer, givenBs } = input;
  assertAmount(input.exchangeRateBCV, 'La tasa de cambio');
  for (const amount of [givenUsdCash, givenUsdTransfer, givenBs]) {
    assertAmount(amount, 'El monto del vuelto', { allowZero: true });
  }
  if ((input.note ?? '').length > FIELD_MAX.note) {
    throw new Error(`La referencia no puede superar ${FIELD_MAX.note} caracteres.`);
  }

  const amountUsd = usdPaid(givenUsdCash, givenUsdTransfer, givenBs, input.exchangeRateBCV);
  if (!(amountUsd > 0)) throw new Error('El vuelto debe ser mayor que cero.');

  const date = input.date ?? new Date().toISOString();
  const _id = refundIdOf(date, input.refundUid ?? uuidv4());
  const existing = await getById<RefundDoc>(db, _id);
  if (existing) return existing;

  const sale = await getSale(db, input.saleId);
  if (!sale) throw new Error(`Venta no encontrada: ${input.saleId}`);

  // Never hand back more than the business holds for this sale. No escape
  // hatch here — there is no business case for over-refunding.
  const { creditUsd } = saleBalance(
    sale,
    await getPayments(db, { saleId: input.saleId }),
    await getRefunds(db, { saleId: input.saleId }),
  );
  if (amountUsd > creditUsd + SETTLED_EPSILON) {
    throw new Error(
      `El vuelto (${round2(amountUsd)} $) excede el saldo a favor del cliente (${creditUsd} $).`,
    );
  }

  const refund: RefundDoc = {
    _id,
    type: 'refund',
    saleId: input.saleId,
    date,
    exchangeRateBCV: input.exchangeRateBCV,
    givenUsdCash: round2(givenUsdCash),
    givenUsdTransfer: round2(givenUsdTransfer),
    givenBs: round2(givenBs),
    note: input.note?.trim() ?? '',
    operatorId: input.operatorId,
  };
  await db.put(refund);
  return refund;
}

async function getById<T>(db: DB, id: string): Promise<T | null> {
  try {
    return (await db.get(id)) as T;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}

async function getSale(db: DB, saleId: string): Promise<SaleDoc | null> {
  try {
    return (await db.get(saleId)) as SaleDoc;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}
