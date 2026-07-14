// Display formatting — es-VE locale, dual currency. Display only: derived Bs
// amounts are computed here and NEVER stored (see CLAUDE.md).

import type { UnitOfMeasure } from './types';

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
export const fmtQty = (n: number, unit: UnitOfMeasure): string =>
  unit === 'Kg' ? fmtKg(n) : fmtUnits(n);
export const fmtDate = (iso: string): string => dateFmt.format(new Date(iso));
export const fmtDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso));
