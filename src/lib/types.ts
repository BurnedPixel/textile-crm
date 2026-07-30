// Domain document types for the PouchDB databases.
// _id design and domain rules: see CLAUDE.md (non-negotiable).

export type ProductType = 'ROLL' | 'COMBO' | 'PIECE';
export type UnitOfMeasure = 'Kg' | 'Units';
export type MovementType = 'IN' | 'OUT' | 'ADJUST';
export type PaymentStatus = 'PENDING' | 'PARTIAL' | 'PAID';
export type ConditionTag = 'FIRST' | 'SECONDS' | 'DEFECT';
export type EntityType = 'PERSON' | 'COMPANY';
export type EntryMethod = 'CASH' | 'TRANSFER';

/** productType determines the unit of measure — never mix Kg with Units. */
export const UNIT_FOR: Record<ProductType, UnitOfMeasure> = {
  ROLL: 'Kg',
  COMBO: 'Units',
  PIECE: 'Units',
};

interface Doc {
  _id: string;
  _rev?: string;
}

/** _id: batch:{color}:{nm}:{fabricType} — enforces batch identity at the DB level. */
export interface BatchDoc extends Doc {
  type: 'batch';
  color: string;
  nm: string;
  fabricType: string;
  productType: ProductType;
  initialUnitCount: number;
  /**
   * Cached counter — ROLL: rolls with weight remaining; COMBO/PIECE: units in stock.
   * The InventoryMovement ledger is the source of truth; this is recomputable.
   */
  currentUnits: number;
  location: string;
  createdAt: string;
}

/**
 * _id: product:{batchId}:{pieceId}.
 * ROLL batches: one doc per physical roll, tracked by weight.
 * COMBO/PIECE batches: exactly one pool doc (pieceId 'stock', weights 0) so that
 * movements and cart lines always reference a Product; quantity lives on Batch.currentUnits.
 */
export interface ProductDoc extends Doc {
  type: 'product';
  batchId: string;
  pieceId: string;
  initialWeightKg: number;
  /** Cached counter for ROLL products. Ledger is source of truth. */
  currentWeightKg: number;
  purchaseValueUsd: number;
  salePriceUsd: number;
  conditionTag: ConditionTag;
  createdAt: string;
  /**
   * The supplier's printed lot number, typed as-is by the operator (NOT normalized,
   * NOT part of any _id — the roll's identity stays batchId+pieceId). Optional:
   * stock received before this field existed has none and displays as "S/L".
   */
  lotNumber?: string;
  /** Pantone reference. One per lot — every roll of a lot shares it. */
  pantone?: string;
  /** Fibre composition, e.g. "95% algodón / 5% elastano". */
  fiberComposition?: string;
}

/** _id: client:{documentId normalized} — cédula/RIF is the natural key. */
export interface ClientDoc extends Doc {
  type: 'client';
  documentId: string;
  entityType: EntityType;
  name: string;
  address: string;
  phoneNumber: string;
  email: string;
  specialty: string[];
  /** Conflict resolution: newest updatedAt wins. */
  updatedAt: string;
}

/** Singleton, _id: config:system. Conflict resolution: newest lastUpdate wins. */
export interface SystemConfigDoc extends Doc {
  type: 'config';
  currentDailyRateBCV: number;
  lastUpdate: string;
}

/** _id: expense:{ISO date}:{uuid}. amountBs is DERIVED (amountUsd * exchangeRateBCV) — never stored. */
export interface ExpenseDoc extends Doc {
  type: 'expense';
  expenseId: string;
  date: string;
  category: string;
  description: string;
  isFixedExpense: boolean;
  entryMethod: EntryMethod;
  amountUsd: number;
  /** Locked at creation from SystemConfig. Never recompute old records. */
  exchangeRateBCV: number;
}

/** Immutable once written — unitPriceAtSale is locked at checkout. */
export interface CartLineItem {
  productId: string;
  batchId: string;
  /** Display snapshot, e.g. "Azul rey · NM 30 · Jersey · R2 · Lote 4471". */
  description: string;
  quantity: number;
  unitOfMeasure: UnitOfMeasure;
  unitPriceAtSale: number;
  lineSubtotalUsd: number;
}

/**
 * _id: sale:{createdAt ISO}:{transactionId}. Append-only, immutable.
 * totalBs is DERIVED (totalUsd * exchangeRateBCV) — never stored.
 */
export interface SaleDoc extends Doc {
  type: 'sale';
  transactionId: string;
  clientId: string | null;
  date: string;
  isOnTheBooks: boolean;
  /** Locked at creation. Never recompute old records. */
  exchangeRateBCV: number;
  totalUsd: number;
  paidUsdCash: number;
  paidUsdTransfer: number;
  paidBs: number;
  /**
   * Status AT CHECKOUT, frozen with the rest of the document. NEVER read it to
   * decide what is owed today — later collections are `payment:` docs and the
   * sale cannot be updated. Use `saleBalance()` in `payments.ts`.
   */
  paymentStatus: PaymentStatus;
  creditTerms: string | null;
  lineItems: CartLineItem[];
}

/**
 * _id: payment:{ISO date}:{uuid}. A collection recorded AFTER checkout.
 * Append-only and immutable, like sale/expense/movement — sales can never be
 * edited, so the current balance is the sale's own payments plus these.
 *
 * Bs is stored, not derived: it is money actually handed over, converted at the
 * rate locked on THIS payment (a collection weeks later happens at a different
 * BCV rate than the sale). Named `paidBs` to match SaleDoc — `amountBs` is a
 * forbidden derived name and both validation layers would reject the document.
 */
export interface PaymentDoc extends Doc {
  type: 'payment';
  paymentId: string;
  /** → SaleDoc._id. */
  saleId: string;
  date: string;
  /** Locked at creation. Never recompute old records. */
  exchangeRateBCV: number;
  paidUsdCash: number;
  paidUsdTransfer: number;
  paidBs: number;
  /** Operator's reference — transfer number, receipt, "abono parcial". */
  note: string;
  operatorId: string;
}

export interface MovementLineItem {
  productId: string;
  /** Signed: negative for OUT, positive for IN. */
  quantityChanged: number;
  unitOfMeasure: UnitOfMeasure;
  conditionTag: ConditionTag;
}

/** _id: movement:{ISO date}:{uuid}. Append-only audit ledger — mandatory for every stock change. */
export interface InventoryMovementDoc extends Doc {
  type: 'movement';
  movementId: string;
  date: string;
  movementType: MovementType;
  /** Sale transactionId, ingress reference, etc. */
  referenceId: string;
  reason: string;
  operatorId: string;
  lineItems: MovementLineItem[];
}

/**
 * _id: rate:{YYYY-MM-DD, Caracas day}. Daily official BCV rates, written by the
 * VPS service (vps/bcv-rates.py). One doc per day.
 *
 * NOTE: nothing in the app reads these yet — the service also refreshes
 * `config:system.currentDailyRateBCV`, which is what the UI uses. This interface
 * is kept as the typed contract for documents that DO exist in the production
 * database, so a future rate-history view starts from the real shape.
 */
export interface RateDoc extends Doc {
  type: 'rate';
  date: string;
  bsPerUsd: number;
  bsPerEur: number;
  /** BCV's "Fecha Valor" — the date the published rate is valid for. */
  valueDate: string | null;
  source: string;
  fetchedAt: string;
}

/** Lives ONLY in cartDb (never synced). _id: cart:current. */
export interface CartDoc extends Doc {
  type: 'cart';
  transactionId: string;
  createdAt: string;
  clientId: string | null;
  isOnTheBooks: boolean;
  lines: CartLineItem[];
  updatedAt: string;
}

export interface SessionUser {
  name: string;
  roles: string[];
}

// ---- _id builders (deterministic ids ARE the uniqueness constraints) ----

/**
 * Lowercase, trim, strip diacritics, spaces → dashes. Keeps ids stable across
 * operators. Also strips the _id delimiter ':' (and '/'): a color named
 * "azul:rey" must not reshape `batch:{color}:{nm}:{fabricType}` — two distinct
 * batches could otherwise collide into one document (id-injection).
 */
export const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[:/]/g, '-')
    .replace(/\s+/g, '-');

export const batchIdOf = (color: string, nm: string, fabricType: string): string =>
  `batch:${norm(color)}:${norm(nm)}:${norm(fabricType)}`;

export const productIdOf = (batchId: string, pieceId: string): string =>
  `product:${batchId}:${norm(pieceId)}`;

export const clientIdOf = (documentId: string): string => `client:${norm(documentId)}`;

export const saleIdOf = (createdAt: string, transactionId: string): string =>
  `sale:${createdAt}:${transactionId}`;

export const movementIdOf = (date: string, uuid: string): string => `movement:${date}:${uuid}`;

export const expenseIdOf = (date: string, uuid: string): string => `expense:${date}:${uuid}`;

export const paymentIdOf = (date: string, uuid: string): string => `payment:${date}:${uuid}`;

export const SYSTEM_CONFIG_ID = 'config:system';
export const CART_ID = 'cart:current';
