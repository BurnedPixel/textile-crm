// Display formatting — es-VE locale, dual currency. Display only: derived Bs
// amounts are computed here and NEVER stored (see CLAUDE.md).
//
// Also the ONE home for the Spanish label of every domain enum. These used to be
// re-declared per island and had already drifted ("Pagada" / "Pagado" / "Pago
// parcial" for one status). Code is English, the user sees Spanish — so the
// translation belongs in exactly one place.

import { hasRollStock } from './types';
import type { ConditionTag, PaymentStatus, ProductType } from './types';

/** Structural match for the Badge component's `tone` prop (no import — ui imports lib, not back). */
type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const usdFmt = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
});
const numFmt = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFmt = new Intl.DateTimeFormat('es-VE', { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short', timeStyle: 'short' });

/** Money math helper — round to cents. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Derived, display-only. Never write the result to a document. */
export const toBs = (usd: number, exchangeRateBCV: number): number => round2(usd * exchangeRateBCV);

export const fmtUsd = (n: number): string => usdFmt.format(n);
export const fmtBs = (n: number): string => `Bs ${numFmt.format(n)}`;
export const fmtKg = (n: number): string => `${numFmt.format(n)} kg`;
export const fmtUnits = (n: number): string => `${n} ud`;
/**
 * Lot label for a roll. Stock received before lot numbers existed has none and
 * reads "S/L" (sin lote) — an explicit "not recorded", not a blank.
 */
export const fmtLot = (lotNumber?: string): string =>
  lotNumber?.trim() ? `Lote ${lotNumber.trim()}` : 'S/L';

/**
 * A roll that came back from a client carries the pieceId of the roll it was cut
 * from plus a `-D{tag}` marker (see `returnPieceId` in inventory.ts). The
 * operator only needs to read "this is R3, returned" — the tag exists so two
 * offline devices cannot write the same document, not to be looked at.
 */
const RETURN_PIECE_RE = /-D[0-9A-Z]+$/i;

export const isReturnPiece = (pieceId: string): boolean => RETURN_PIECE_RE.test(pieceId);

export const fmtPiece = (pieceId: string): string =>
  isReturnPiece(pieceId) ? `${pieceId.replace(RETURN_PIECE_RE, '')} · devolución` : pieceId;

/**
 * The lot numbers an artículo is currently holding. A lot is per ROLL, so one
 * artículo can hold several at once — or none, for stock received before lot
 * numbers existed, which reads "S/L".
 *
 * Only the products that ARE stock count: an empty roll is not fabric on the
 * shelf, and listing its lot would offer the operator something to sell that
 * is not there. COMBO/PIECE keep their single pool product, whose count lives
 * on the batch rather than on the product.
 */
export function fmtLots(
  productType: ProductType,
  products: Array<{ currentWeightKg: number; lotNumber?: string }>,
): string {
  const inStock = productType === 'ROLL'
    ? products.filter((p) => hasRollStock(p.currentWeightKg))
    : products;
  const lots = [...new Set(
    inStock.map((p) => p.lotNumber?.trim()).filter((l): l is string => Boolean(l)),
  )].sort();
  if (lots.length === 0) return 'S/L';
  if (lots.length <= 2) return lots.join(' · ');
  // Three or more would wrap a table cell; the rest are one click away.
  return `${lots[0]} · ${lots[1]} +${lots.length - 2}`;
}

/** `fmtLots` with the word in front, for prose rather than a labelled column. */
export function fmtLotsLabel(
  productType: ProductType,
  products: Array<{ currentWeightKg: number; lotNumber?: string }>,
): string {
  const lots = fmtLots(productType, products);
  if (lots === 'S/L') return 'S/L';
  return `${lots.includes('·') ? 'Lotes' : 'Lote'} ${lots}`;
}

export const fmtDate = (iso: string): string => dateFmt.format(new Date(iso));
export const fmtDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso));

// ---- Domain enums → Spanish. One definition each. ----

/** Agrees with «la venta»: pagada, not pagado. */
export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  PAID: 'Pagada',
  PARTIAL: 'Parcial',
  PENDING: 'Pendiente',
};

export const PAYMENT_TONE: Record<PaymentStatus, Tone> = {
  PAID: 'ok',
  PARTIAL: 'warn',
  PENDING: 'danger',
};

/** Full words — for a form's Select. */
export const CONDITION_LABEL: Record<ConditionTag, string> = {
  FIRST: 'Primera',
  SECONDS: 'Segunda',
  DEFECT: 'Fallado',
};

/** Abbreviated — for a badge in a dense list, where the full word will not fit. */
export const CONDITION_SHORT: Record<ConditionTag, string> = {
  FIRST: '1ª',
  SECONDS: '2da',
  DEFECT: 'Def.',
};

export const CONDITION_TONE: Record<ConditionTag, Tone> = {
  FIRST: 'ok',
  SECONDS: 'warn',
  DEFECT: 'danger',
};

/** Thickness label — the field holds NM (cotton/PC) or Dtex (textured poly) counts alike (client, R2-4). */
export const NM_LABEL = 'NM/Dtex';

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  ROLL: 'Rollo',
  COMBO: 'Combo',
  PIECE: 'Pieza',
};
