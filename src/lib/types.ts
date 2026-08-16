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

/**
 * A roll at or below this weight counts as consumed: it stops being one of the
 * batch's `currentUnits`. Guards the float dust left by repeated subtraction.
 *
 * ONE definition on purpose — checkout (a roll hitting empty), ingress (a roll
 * coming back off empty), the conflict recompute and every "rolls with stock"
 * list all have to agree, or the cached counter and the ledger drift apart with
 * nothing looking wrong on screen.
 */
export const ROLL_EMPTY_KG = 0.001;

/** A roll still holding sellable weight — the counted-in-`currentUnits` rule. */
export const hasRollStock = (currentWeightKg: number): boolean =>
  currentWeightKg > ROLL_EMPTY_KG;

export interface Doc {
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
  /**
   * The client's colour-chart code (100s pastel / 200s mid / 300s dark), typed
   * as-is by the operator. Batch-level, like colour itself. Optional and NOT
   * normalized, and never part of any _id — batch identity stays
   * color+nm+fabricType, so re-coding a colour is an ordinary write with no
   * migration (the same thing lotNumber's design bought on the roll).
   */
  colorCode?: string;
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
  /**
   * Tax RATES, locked at checkout. The amounts are derived — `ivaUsd`,
   * `igtfUsd` and `grandTotalUsd` must never be stored, exactly like `totalBs`.
   * Keeping the rates means a sale from any date can still be re-explained, and
   * a rate change never rewrites history.
   *
   * Absent on every sale written before this existed, which is why both are
   * optional and read as 0: otherwise the whole back catalogue would grow a
   * 16% phantom debt the day this shipped, on documents that are immutable.
   */
  ivaRate?: number;
  igtfRate?: number;
}

/**
 * _id: config:fiscal. The company's fiscal identity, printed on the nota de
 * entrega. Mutable config, not a ledger entry.
 *
 * Its own document ON PURPOSE: `saveDailyRate` rebuilds `config:system` from an
 * explicit field list, so a fiscal header parked there is deleted by the next
 * 07:00 rate write — silently, and only visible the next time someone prints.
 */
export interface FiscalConfigDoc extends Doc {
  type: 'config';
  /** Razón social. */
  businessName: string;
  /** RIF. */
  taxId: string;
  /** Dirección fiscal. */
  address: string;
  lastUpdate: string;
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

/**
 * _id: refund:{ISO date}:{uuid}. Change handed BACK to the client («vuelto»),
 * settling a saldo a favor created by an overpayment. Append-only and immutable,
 * like sale/payment/expense/movement. Amounts are POSITIVE — the direction is
 * the doc TYPE, never a negative number, so assertAmount keeps rejecting
 * negatives everywhere. Bs is stored (money actually handed over) at the rate
 * locked HERE — the day the change was given — which is why it is `givenBs`
 * and never the forbidden derived `amountBs`.
 */
export interface RefundDoc extends Doc {
  type: 'refund';
  /** → SaleDoc._id. The credit is per-sale; that is what makes it derivable. */
  saleId: string;
  date: string;
  /** Locked at creation. Never recompute old records. */
  exchangeRateBCV: number;
  givenUsdCash: number;
  givenUsdTransfer: number;
  givenBs: number;
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

export const refundIdOf = (date: string, uuid: string): string => `refund:${date}:${uuid}`;

export const SYSTEM_CONFIG_ID = 'config:system';
export const FISCAL_CONFIG_ID = 'config:fiscal';
export const CART_ID = 'cart:current';

// ---- Field validation (shared by the logic modules AND the forms) ----
//
// Each returns a Spanish message or null. The logic modules enforce them at the
// boundary (that is the contract); the forms call the same functions to show the
// error next to the field instead of after a failed save. One definition, so the
// two client forms cannot disagree about what a valid phone number is.

/** Caps: a paste of a whole document must never reach a document field. */
export const FIELD_MAX = {
  documentId: 20,
  name: 120,
  address: 200,
  phoneNumber: 25,
  email: 120,
  specialty: 40,
  note: 200,
  description: 200,
  category: 60,
  text: 60,
  /** A colour-chart code is three digits in practice; 12 leaves room for "215-A". */
  colorCode: 12,
} as const;

const tooLong = (label: string, max: number) => `${label} no puede superar ${max} caracteres.`;

/**
 * Cédula or RIF. Venezuelan documents are a letter prefix — V (venezolano),
 * E (extranjero), J (jurídico/RIF), G (gobierno), P (pasaporte) — plus digits,
 * with RIF carrying a check digit: V-12345678, E-84123456, J-40123456-7.
 * Separators and dots are cosmetic and ignored; case is folded to upper.
 *
 * The prefix is REQUIRED (user rule 2026-08-16): the id is the client's
 * natural key, so every new client is typed in one canonical shape. Existing
 * docs are never re-validated against this — saveClient enforces it on CREATE
 * only, because the stored id builds the `_id` and must stay untouched.
 */
export function normalizeDocumentId(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[\s.]/g, '');
  const m = compact.match(/^([VEJGP])-?(\d{5,9})(?:-?(\d))?$/);
  if (!m) return null;
  return m[3] !== undefined ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

export function validateDocumentId(value: string): string | null {
  const v = value.trim();
  if (!v) return 'La cédula o RIF es obligatoria.';
  if (v.length > FIELD_MAX.documentId) return tooLong('La cédula o RIF', FIELD_MAX.documentId);
  if (!normalizeDocumentId(v)) {
    return 'Cédula o RIF inválido — letra V/E/J/G/P y números. Ej.: V-12345678, E-84123456 o J-40123456-7.';
  }
  return null;
}

/**
 * A name has to contain at least one letter. Digits are allowed alongside them —
 * "Textiles 2000 C.A." is a real company — but "12345" or "---" is not a name.
 */
export function validateName(value: string): string | null {
  const v = value.trim();
  if (!v) return 'El nombre es obligatorio.';
  if (v.length < 2) return 'El nombre es demasiado corto.';
  if (v.length > FIELD_MAX.name) return tooLong('El nombre', FIELD_MAX.name);
  if (!/\p{L}/u.test(v)) return 'El nombre debe contener letras.';
  return null;
}

/**
 * Optional. Digits only once separators are stripped, with an optional leading
 * `+`: 0412-1234567, +58 412 1234567, (0243) 765-4321. 7 digits covers a local
 * landline; 15 is the E.164 maximum, so anything longer is a typo.
 */
/**
 * Canonical phone: `+<country code><digits>` (user rule 2026-08-16 — numbers
 * must carry their country code; the forms autofill «+58 »). Legacy local
 * shapes still normalize instead of rejecting — 0412-1234567 and a bare
 * 4121234567 become +58412…, so touching an old client canonicalizes its
 * number rather than blocking the save. Returns '' for empty input or an
 * untouched «+58» autofill, null for what cannot be a phone.
 */
export function normalizePhone(value: string): string | null {
  const v = value.trim();
  if (!v) return '';
  const compact = v.replace(/[\s().-]/g, '');
  if (compact === '+') return '';
  if (compact.startsWith('+')) {
    const d = compact.slice(1);
    if (!/^\d+$/.test(d)) return null;
    if (d === '58') return ''; // the autofill, nothing typed after it
    if (d.length < 10 || d.length > 15) return null;
    return `+${d}`;
  }
  if (!/^\d+$/.test(compact)) return null;
  // Legacy local: the trunk 0 is not part of the international number.
  let e164 = compact.startsWith('0') ? `58${compact.slice(1)}` : compact;
  if (e164.length === 10 && !e164.startsWith('58')) e164 = `58${e164}`;
  if (e164.length < 10 || e164.length > 15) return null;
  return `+${e164}`;
}

export function validatePhone(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > FIELD_MAX.phoneNumber) return tooLong('El teléfono', FIELD_MAX.phoneNumber);
  if (normalizePhone(v) === null) {
    return 'Teléfono inválido — incluye el código de país. Ej.: +58 412-1234567.';
  }
  return null;
}

/** Optional. Deliberately loose — the only authority on an address is delivery. */
export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > FIELD_MAX.email) return tooLong('El correo', FIELD_MAX.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'El correo electrónico no es válido.';
  return null;
}

/**
 * A money/quantity amount that will be written to an immutable document.
 * Rejects Infinity as well as NaN: `parseFloat('1e999')` is Infinity, `> 0` is
 * true for it, and one Infinity in a cached counter or a sale total is permanent
 * — the ledger that would correct it is append-only.
 */
export function assertAmount(value: number, label: string, opts: { allowZero?: boolean } = {}): void {
  if (!Number.isFinite(value)) throw new Error(`${label} no es un número válido.`);
  if (opts.allowZero) {
    if (value < 0) throw new Error(`${label} no puede ser negativo.`);
  } else if (!(value > 0)) {
    throw new Error(`${label} debe ser mayor que cero.`);
  }
  // 1e12 is far past any real weight, price or bolívar total, and well inside
  // the range where float arithmetic still holds cents.
  if (Math.abs(value) > 1e12) throw new Error(`${label} es demasiado grande.`);
}
