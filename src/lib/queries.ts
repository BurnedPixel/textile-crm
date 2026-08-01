// Read/query layer. Every function takes `db` as the FIRST argument (testable in
// node with the memory adapter — never imports db.ts). All list reads use cheap
// allDocs range scans (startkey/endkey prefix) — NO Mango indexes, per CLAUDE.md.

import {
  SYSTEM_CONFIG_ID,
  FISCAL_CONFIG_ID,
  FIELD_MAX,
  assertAmount,
  clientIdOf,
  expenseIdOf,
  validateDocumentId,
  validateEmail,
  validateName,
  validatePhone,
  type SystemConfigDoc,
  type FiscalConfigDoc,
  type BatchDoc,
  type ProductDoc,
  type ClientDoc,
  type SaleDoc,
  type ExpenseDoc,
  type InventoryMovementDoc,
  type PaymentStatus,
  type EntityType,
} from './types';
import { round2 } from './format';

type DB = PouchDB.Database;

// CouchDB range-scan sentinel: highest possible suffix so [prefix, prefix+HIGH]
// captures every id under `prefix`.
const HIGH = '￰';

async function getById<T>(db: DB, id: string): Promise<T | null> {
  try {
    return (await db.get(id)) as T;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}

/** Scan all docs whose _id starts with `prefix`. */
async function scanPrefix<T>(
  db: DB,
  prefix: string,
  opts: { descending?: boolean; limit?: number } = {},
): Promise<T[]> {
  const { descending = false, limit } = opts;
  const res = await db.allDocs<T>({
    include_docs: true,
    // When descending, startkey/endkey swap roles.
    startkey: descending ? prefix + HIGH : prefix,
    endkey: descending ? prefix : prefix + HIGH,
    descending,
    ...(limit != null ? { limit } : {}),
  });
  return res.rows.map((r) => r.doc as T).filter(Boolean);
}

// ---- SystemConfig ----

export async function getConfig(db: DB): Promise<SystemConfigDoc | null> {
  return getById<SystemConfigDoc>(db, SYSTEM_CONFIG_ID);
}

// ---- Fiscal identity (its OWN document — see FiscalConfigDoc) ----

export async function getFiscalConfig(db: DB): Promise<FiscalConfigDoc | null> {
  return getById<FiscalConfigDoc>(db, FISCAL_CONFIG_ID);
}

export interface FiscalConfigInput {
  businessName: string;
  taxId: string;
  address: string;
}

/** Upsert the fiscal header printed on the nota de entrega. */
export async function saveFiscalConfig(
  db: DB,
  input: FiscalConfigInput,
): Promise<FiscalConfigDoc> {
  const businessName = input.businessName.trim();
  const taxId = input.taxId.trim();
  if (!businessName) throw new Error('La razón social es obligatoria.');
  if (businessName.length > FIELD_MAX.name) {
    throw new Error(`La razón social no puede superar ${FIELD_MAX.name} caracteres.`);
  }
  const problem = validateDocumentId(taxId);
  if (problem) throw new Error(problem);
  if ((input.address ?? '').length > FIELD_MAX.address) {
    throw new Error(`La dirección fiscal no puede superar ${FIELD_MAX.address} caracteres.`);
  }
  const existing = await getFiscalConfig(db);
  const doc: FiscalConfigDoc = {
    _id: FISCAL_CONFIG_ID,
    ...(existing?._rev ? { _rev: existing._rev } : {}),
    type: 'config',
    businessName,
    taxId,
    address: input.address?.trim() ?? '',
    lastUpdate: new Date().toISOString(),
  };
  await db.put(doc);
  return doc;
}

/** Upsert the singleton rate. Newest lastUpdate wins on conflict (see conflicts.ts). */
export async function saveDailyRate(db: DB, rate: number): Promise<SystemConfigDoc> {
  assertAmount(rate, 'La tasa del día');
  const existing = await getConfig(db);
  const doc: SystemConfigDoc = {
    _id: SYSTEM_CONFIG_ID,
    ...(existing?._rev ? { _rev: existing._rev } : {}),
    type: 'config',
    currentDailyRateBCV: round2(rate),
    lastUpdate: new Date().toISOString(),
  };
  await db.put(doc);
  return doc;
}

// ---- Batches / Products ----

export async function getBatches(db: DB): Promise<BatchDoc[]> {
  return scanPrefix<BatchDoc>(db, 'batch:');
}

/** Products of one batch. product ids are product:{batchId}:{pieceId}. */
export async function getBatchProducts(db: DB, batchId: string): Promise<ProductDoc[]> {
  return scanPrefix<ProductDoc>(db, `product:${batchId}:`);
}

/**
 * Batches with stock > 0, each paired with its products. Powers the cascading
 * Color → NM → Fabric selector and dashboards. O(batches + products), no joins
 * against the movement ledger (counters are cached — CLAUDE.md).
 */
export async function getStockedBatches(
  db: DB,
): Promise<Array<{ batch: BatchDoc; products: ProductDoc[] }>> {
  const [batches, allProducts] = await Promise.all([
    getBatches(db),
    scanPrefix<ProductDoc>(db, 'product:'),
  ]);
  const byBatch = new Map<string, ProductDoc[]>();
  for (const p of allProducts) {
    const arr = byBatch.get(p.batchId) ?? [];
    arr.push(p);
    byBatch.set(p.batchId, arr);
  }
  return batches
    .filter((b) => b.currentUnits > 0)
    .map((batch) => ({ batch, products: byBatch.get(batch._id) ?? [] }));
}

/**
 * Every product paired with its article — including rolls with nothing left on
 * them, which `getStockedBatches` filters out. Powers the lot search, where a
 * sold-out roll is often exactly the one being looked for.
 *
 * ponytail: two full prefix scans and a join in memory, like getStockedBatches.
 * Fine at factory scale (hundreds of rolls); if it ever isn't, the answer is a
 * per-lot index, not a Mango selector.
 */
export async function getProductsWithBatch(
  db: DB,
): Promise<Array<{ batch: BatchDoc; product: ProductDoc }>> {
  const [batches, products] = await Promise.all([
    getBatches(db),
    scanPrefix<ProductDoc>(db, 'product:'),
  ]);
  const byId = new Map(batches.map((b) => [b._id, b]));
  return products
    .map((product) => ({ batch: byId.get(product.batchId), product }))
    .filter((row): row is { batch: BatchDoc; product: ProductDoc } => Boolean(row.batch));
}

// ---- Clients ----

export async function getClients(db: DB): Promise<ClientDoc[]> {
  return scanPrefix<ClientDoc>(db, 'client:');
}

export interface ClientInput {
  documentId: string;
  entityType?: EntityType;
  name: string;
  address?: string;
  phoneNumber?: string;
  email?: string;
  specialty?: string[];
}

/**
 * Upsert by natural key (documentId). Newest updatedAt wins on conflict.
 * `createOnly` rejects if a client with that id already exists — the guard is
 * atomic with the fresh read below, so a UI pre-check against a stale live-query
 * snapshot can't let a create silently overwrite an existing client.
 */
export async function saveClient(
  db: DB,
  input: ClientInput,
  opts: { createOnly?: boolean } = {},
): Promise<ClientDoc> {
  // The forms call these too, for field-level errors — but THIS is the contract.
  for (const problem of [
    validateDocumentId(input.documentId ?? ''),
    validateName(input.name ?? ''),
    validatePhone(input.phoneNumber ?? ''),
    validateEmail(input.email ?? ''),
  ]) {
    if (problem) throw new Error(problem);
  }
  if ((input.address ?? '').length > FIELD_MAX.address) {
    throw new Error(`La dirección no puede superar ${FIELD_MAX.address} caracteres.`);
  }
  if (input.specialty?.some((s) => s.length > FIELD_MAX.specialty)) {
    throw new Error(`Cada especialidad no puede superar ${FIELD_MAX.specialty} caracteres.`);
  }
  const _id = clientIdOf(input.documentId);
  const existing = await getById<ClientDoc>(db, _id);
  if (opts.createOnly && existing) throw new Error('Ya existe un cliente con ese documento.');
  const doc: ClientDoc = {
    _id,
    ...(existing?._rev ? { _rev: existing._rev } : {}),
    type: 'client',
    documentId: input.documentId.trim(),
    entityType: input.entityType ?? existing?.entityType ?? 'PERSON',
    name: input.name.trim(),
    address: input.address ?? existing?.address ?? '',
    phoneNumber: input.phoneNumber ?? existing?.phoneNumber ?? '',
    email: input.email ?? existing?.email ?? '',
    // Capped: an unbounded array on a doc that syncs to every device is a
    // payload the client controls.
    specialty: (input.specialty ?? existing?.specialty ?? []).slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
  await db.put(doc);
  return doc;
}

// ---- Append-only ledgers (time-ordered ids → range scans) ----

export interface ListOpts {
  startDate?: string;
  endDate?: string;
  limit?: number;
  descending?: boolean;
}

/**
 * Scan a time-ordered ledger prefix (sale:/expense:/movement:) between dates.
 * ids embed the ISO date right after the prefix, so date bounds are pure id math.
 */
async function scanLedger<T>(db: DB, prefix: string, opts: ListOpts = {}): Promise<T[]> {
  const { startDate, endDate, limit, descending = true } = opts;
  const low = prefix + (startDate ?? '');
  const high = prefix + (endDate ?? '') + HIGH;
  const res = await db.allDocs<T>({
    include_docs: true,
    startkey: descending ? high : low,
    endkey: descending ? low : high,
    descending,
    ...(limit != null ? { limit } : {}),
  });
  return res.rows.map((r) => r.doc as T).filter(Boolean);
}

export async function getSales(db: DB, opts?: ListOpts): Promise<SaleDoc[]> {
  return scanLedger<SaleDoc>(db, 'sale:', opts);
}

export async function getExpenses(db: DB, opts?: ListOpts): Promise<ExpenseDoc[]> {
  return scanLedger<ExpenseDoc>(db, 'expense:', opts);
}

export async function getMovements(db: DB, opts?: ListOpts): Promise<InventoryMovementDoc[]> {
  return scanLedger<InventoryMovementDoc>(db, 'movement:', opts);
}

// ---- Expenses (write) ----

export interface ExpenseInput {
  date?: string;
  category: string;
  description: string;
  isFixedExpense?: boolean;
  entryMethod: 'CASH' | 'TRANSFER';
  amountUsd: number;
  /** Locked at creation by the caller — reading SystemConfig is the caller's job. */
  exchangeRateBCV: number;
}

export async function addExpense(db: DB, input: ExpenseInput): Promise<ExpenseDoc> {
  assertAmount(input.amountUsd, 'El monto del gasto');
  assertAmount(input.exchangeRateBCV, 'La tasa de cambio');
  if (!input.category?.trim()) throw new Error('La categoría del gasto es obligatoria.');
  if (input.category.length > FIELD_MAX.category) {
    throw new Error(`La categoría no puede superar ${FIELD_MAX.category} caracteres.`);
  }
  if ((input.description ?? '').length > FIELD_MAX.description) {
    throw new Error(`La descripción no puede superar ${FIELD_MAX.description} caracteres.`);
  }
  const date = input.date ?? new Date().toISOString();
  const uuid = uuidv4();
  const doc: ExpenseDoc = {
    _id: expenseIdOf(date, uuid),
    type: 'expense',
    expenseId: uuid,
    date,
    category: input.category,
    description: input.description,
    isFixedExpense: input.isFixedExpense ?? false,
    entryMethod: input.entryMethod,
    amountUsd: round2(input.amountUsd),
    exchangeRateBCV: input.exchangeRateBCV,
  };
  await db.put(doc);
  return doc;
}

// ---- Tax (pure, exported for UI + checkout + payments.ts) ----
//
// ONE definition of the money rules, beside the payment thresholds below, so
// the two cannot drift. Every consumer — the terminal, the payment panel, the
// nota de entrega, the receivable screens, and eventually the fiscal printer —
// reads the SAME numbers rather than re-deriving them.

/** IVA is always 16%, no exemptions and no reduced cases (client, casilla 16). */
export const IVA_RATE = 0.16;

/** IGTF on divisas — cash AND USD transfers alike (client, casilla 13). */
export const IGTF_RATE = 0.03;

export interface SaleTaxes {
  /** Σ line subtotals — pre-tax, and what SaleDoc.totalUsd stores. */
  baseUsd: number;
  ivaUsd: number;
  igtfUsd: number;
  /** What the client actually owes. */
  grandTotalUsd: number;
}

/** Everything the tax arithmetic needs; a whole SaleDoc satisfies it. */
export interface TaxableSale {
  totalUsd: number;
  ivaRate?: number;
  igtfRate?: number;
  paidUsdCash: number;
  paidUsdTransfer: number;
}

/**
 * The tax breakdown of a sale — a pure function of the document, so a print
 * view, a screen and a future fiscal-printer payload all build from the same
 * figures instead of re-deriving them (two derivations of one tax figure is how
 * they drift).
 *
 * ⚠️ TWO THINGS THE ACCOUNTANT STILL HAS TO CONFIRM (docs/plan.md §3, casilla 14).
 * The client's own answer names two different bases, and sales are immutable, so
 * a wrong one cannot be corrected afterwards — only annotated.
 *
 *   1. The IGTF base EXCLUDES IVA here, per their written observation
 *      («sobre la base imponible, no incluyendo el IVA»). Venezuelan practice
 *      normally applies IGTF to the amount actually tendered, IVA included.
 *   2. The divisa share is measured against what is owed BEFORE IGTF
 *      (base + IVA). Measuring it against the grand total, as the checkbox
 *      wording suggests, makes the definition circular — IGTF would depend on a
 *      total that depends on IGTF — and only resolves through a quadratic that
 *      no one could explain to a tax inspector.
 *
 * Also deliberate: the divisa share is read from the payments made AT CHECKOUT.
 * A later `payment:` collection in divisas incurs its own IGTF in the real
 * world, and this does not model that — the sale is immutable, so its tax
 * figures are fixed at the moment it was written.
 */
export function saleTaxes(sale: TaxableSale): SaleTaxes {
  const baseUsd = round2(sale.totalUsd);
  // Absent rates read as 0 — every sale written before tax existed keeps a
  // grand total equal to its net total, which is what its history says.
  const ivaUsd = round2(baseUsd * (sale.ivaRate ?? 0));
  const owedBeforeIgtf = round2(baseUsd + ivaUsd);
  const divisaUsd = sale.paidUsdCash + sale.paidUsdTransfer;
  const divisaShare = owedBeforeIgtf > 0 ? Math.min(1, divisaUsd / owedBeforeIgtf) : 0;
  const igtfUsd = round2(baseUsd * divisaShare * (sale.igtfRate ?? 0));
  return { baseUsd, ivaUsd, igtfUsd, grandTotalUsd: round2(baseUsd + ivaUsd + igtfUsd) };
}

/** What the client owes, tax included. The ONE total every money read site uses. */
export function grandTotalUsd(sale: TaxableSale): number {
  return saleTaxes(sale).grandTotalUsd;
}

// ---- Payment status (pure, exported for UI + checkout + payments.ts) ----

/** Within a cent of the total counts as settled — float drift, not a debt. */
export const SETTLED_EPSILON = 0.01;
/** Above this, money genuinely changed hands (so: PARTIAL, not PENDING). */
const RECEIVED_EPSILON = 0.009;

/**
 * The three payment channels as one USD figure. Bs converts at the rate locked
 * on the record that holds it — a sale's Bs at the sale's rate, a later
 * collection's Bs at the rate the day it was collected.
 */
export function usdPaid(
  paidUsdCash: number,
  paidUsdTransfer: number,
  paidBs: number,
  exchangeRateBCV: number,
): number {
  return paidUsdCash + paidUsdTransfer + (exchangeRateBCV > 0 ? paidBs / exchangeRateBCV : 0);
}

/** The ONE definition of the thresholds — checkout and every read site share it. */
export function statusForPaid(totalUsd: number, paidTotalUsd: number): PaymentStatus {
  if (paidTotalUsd >= totalUsd - SETTLED_EPSILON) return 'PAID';
  if (paidTotalUsd > RECEIVED_EPSILON) return 'PARTIAL';
  return 'PENDING';
}

/**
 * Split-payment status AT CHECKOUT. To ask what a sale is owed *today* — after
 * later `payment:` collections — use `saleBalance()` in `payments.ts`, not this.
 */
export function computePaymentStatus(
  totalUsd: number,
  paidUsdCash: number,
  paidUsdTransfer: number,
  paidBs: number,
  exchangeRateBCV: number,
): PaymentStatus {
  return statusForPaid(totalUsd, usdPaid(paidUsdCash, paidUsdTransfer, paidBs, exchangeRateBCV));
}

// Shared uuid helper — crypto.randomUUID exists in browsers and node >=16.7.
export function uuidv4(): string {
  return globalThis.crypto.randomUUID();
}
