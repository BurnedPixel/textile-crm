// Read/query layer. Every function takes `db` as the FIRST argument (testable in
// node with the memory adapter — never imports db.ts). All list reads use cheap
// allDocs range scans (startkey/endkey prefix) — NO Mango indexes, per CLAUDE.md.

import {
  SYSTEM_CONFIG_ID,
  FIELD_MAX,
  assertAmount,
  clientIdOf,
  expenseIdOf,
  validateDocumentId,
  validateEmail,
  validateName,
  validatePhone,
  type SystemConfigDoc,
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
