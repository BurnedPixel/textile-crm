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
  paymentIdOf, assertAmount, FIELD_MAX,
  type PaymentDoc, type SaleDoc, type PaymentStatus,
} from './types';
import { round2 } from './format';
// usdPaid/statusForPaid live in queries.ts beside computePaymentStatus so the
// checkout status and the derived balance can never drift apart.
import { SETTLED_EPSILON, grandTotalUsd, statusForPaid, usdPaid, uuidv4 } from './queries';

type DB = PouchDB.Database;

export interface SaleBalance {
  paidUsd: number;
  owedUsd: number;
  status: PaymentStatus;
}

/**
 * What a sale is worth today. `payments` is that sale's collections — pass none
 * and this reduces to the at-checkout figures the sale already carries.
 */
export function saleBalance(sale: SaleDoc, payments: PaymentDoc[] = []): SaleBalance {
  const atCheckout = usdPaid(sale.paidUsdCash, sale.paidUsdTransfer, sale.paidBs, sale.exchangeRateBCV);
  const collected = payments.reduce(
    (sum, p) => sum + usdPaid(p.paidUsdCash, p.paidUsdTransfer, p.paidBs, p.exchangeRateBCV),
    0,
  );
  const paidUsd = round2(atCheckout + collected);
  // What is owed is the GRAND total — base + IVA + IGTF — not the pre-tax
  // figure the document stores. Every derived balance in the app comes through
  // here, which is why the switch happens once, at this line.
  const owed = grandTotalUsd(sale);
  return {
    paidUsd,
    owedUsd: round2(Math.max(0, owed - paidUsd)),
    status: statusForPaid(owed, paidUsd),
  };
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

/** Group payments by the sale they settle — one pass, for list screens. */
export function paymentsBySale(payments: PaymentDoc[]): Map<string, PaymentDoc[]> {
  const bySale = new Map<string, PaymentDoc[]>();
  for (const p of payments) {
    const list = bySale.get(p.saleId);
    if (list) list.push(p);
    else bySale.set(p.saleId, [p]);
  }
  return bySale;
}

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

  // Overpayment is a typo, not a business case — an extra digit would otherwise
  // read as "pagada" and leave the difference unaccounted for anywhere.
  const { owedUsd } = saleBalance(sale, await getPayments(db, { saleId: input.saleId }));
  if (amountUsd > owedUsd + SETTLED_EPSILON) {
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

async function getSale(db: DB, saleId: string): Promise<SaleDoc | null> {
  try {
    return (await db.get(saleId)) as SaleDoc;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}
