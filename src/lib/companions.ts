// Compañeros — clients who buy piqué normally buy the matching combos
// (cuello + puño) with it, and clients who buy jersey or fleece normally buy
// ribb (by weight) with it. Pure functions, no db: the seller sees a
// SUGGESTION and always has the last word.
//
// Why nothing here is a rule:
//  · The ratios are suggestions, never enforced. The seller edits the number
//    at zero schema cost.
//  · The pairing is resolved TOLERANTLY — the seller picks from the stocked
//    unit articles / rolls rather than the app matching on a name. INFORME 001
//    alone spells one cloth PIQUE, PIQUET, PIQU and Chemise, so a naming rule
//    would have missed most of the sales it exists to catch.

import { norm, hasRollStock, type BatchDoc, type ProductDoc } from './types';
import { round2 } from './format';

/**
 * Combos suggested per kilo of piqué. Client's written standard (2026-08-15):
 * 3.5 combos per kg, settling the earlier 3-vs-3.5 ambiguity. Still a
 * SUGGESTION the seller edits, never a rule.
 */
export const COMBOS_PER_KG_PIQUE = 3.5;

/** Ribb suggested per kilo of jersey. "Jersey-Ribb 5% de ribb por kg de jersey" (client, 2026-08-15). */
export const RIBB_PER_KG_JERSEY = 0.05;

/** Ribb suggested per kilo of fleece. "Fleece-Ribb 12% de ribb por kg de fleece" (client, 2026-08-15). */
export const RIBB_PER_KG_FLEECE = 0.12;

const matchesPrefix = (fabricType: string, prefixes: string[]): boolean => {
  const f = norm(fabricType);
  return prefixes.some((p) => f.startsWith(p));
};

/**
 * Fabric names that mean piqué. «Chemise y piqué es lo mismo» (casilla 11), so
 * chemise is a spelling of piqué here, not a second cloth. Matched on a normed
 * prefix: norm() has already folded case and accents, and the observed
 * spellings are all prefixes of each other.
 */
const PIQUE_PREFIXES = ['piqu', 'chemis'];

export function isPique(fabricType: string): boolean {
  return matchesPrefix(fabricType, PIQUE_PREFIXES);
}

/** Fabric names that mean ribb — covers Rib, Ribb, Rib 1x1 as observed in real data. */
const RIBB_PREFIXES = ['rib'];

export function isRibb(fabricType: string): boolean {
  return matchesPrefix(fabricType, RIBB_PREFIXES);
}

export interface CompanionRule {
  companion: 'combos' | 'ribb';
  ratio: number;
  label: string;
}

/**
 * The compañero pairing (if any) for a sold fabric: piqué → combos, jersey/
 * fleece → ribb by weight. Ribb itself and anything else pairs with nothing.
 */
export function companionRuleFor(fabricType: string): CompanionRule | null {
  if (isPique(fabricType)) {
    return { companion: 'combos', ratio: COMBOS_PER_KG_PIQUE, label: 'piqué' };
  }
  if (matchesPrefix(fabricType, ['jersey'])) {
    return { companion: 'ribb', ratio: RIBB_PER_KG_JERSEY, label: 'jersey' };
  }
  if (matchesPrefix(fabricType, ['fleece'])) {
    return { companion: 'ribb', ratio: RIBB_PER_KG_FLEECE, label: 'fleece' };
  }
  return null;
}

/**
 * How many combos to offer for a piqué line. Rounded UP — combos are countable
 * and a client buying 21.4 kg is not offered 64.2 of them.
 */
export function suggestedCombos(kg: number, ratio: number = COMBOS_PER_KG_PIQUE): number {
  if (!Number.isFinite(kg) || kg <= 0) return 0;
  return Math.ceil(kg * ratio);
}

/**
 * How many kilos of ribb to offer for a jersey/fleece line. Ribb is fabric
 * sold by weight, so this rounds to 2 decimals — the same as every other
 * weight display in the app; an unrounded 1.3675 would show as "1,37 kg"
 * while billing something else.
 */
export function suggestedKg(kg: number, ratio: number): number {
  if (!Number.isFinite(kg) || kg <= 0) return 0;
  return round2(kg * ratio);
}

export interface StockedEntry {
  batch: BatchDoc;
  products: ProductDoc[];
}

/**
 * The articles offered as compañeros for a piqué line of `color`: everything
 * counted in units (COMBO/PIECE) that has stock, narrowed to the same colour
 * when any of them match.
 *
 * The colour filter is a narrowing, never a filter that can empty the list —
 * whatever the shop's combos turn out to be called or coloured, the seller is
 * always offered real stock and the checkbox cannot ship dead.
 */
export function companionCandidates(stocked: StockedEntry[], color: string): StockedEntry[] {
  const inUnits = stocked.filter(
    (e) => e.batch.productType !== 'ROLL' && e.batch.currentUnits > 0,
  );
  const sameColor = inUnits.filter((e) => norm(e.batch.color) === norm(color));
  return sameColor.length > 0 ? sameColor : inUnits;
}

export interface RibbRoll {
  batch: BatchDoc;
  roll: ProductDoc;
}

/**
 * The ribb rolls offered as compañeros for a jersey/fleece line of `color`,
 * narrowed to the same colour when any match — same tolerant-narrowing shape
 * as companionCandidates. `exclude` drops rolls the caller cannot add anyway
 * (already in the cart).
 *
 * Rolls are flattened and filtered for usable stock BEFORE the colour
 * narrowing: stock here lives one level deeper than the colour (per roll, not
 * per batch), so narrowing first would let a same-colour batch whose rolls are
 * all empty or all in the cart kill the fallback and report "no hay ribb"
 * while usable ribb of another colour sits in stock.
 *
 * Unlike companionCandidates there is deliberately NO fallback to non-ribb
 * rolls — the only other rolls in stock are jerseys/fleeces themselves, and
 * offering the sold fabric as its own companion is nonsense. Empty result
 * means the UI says "no hay ribb" and the sale proceeds (a warning, never a
 * block).
 */
export function ribbRollCandidates(
  stocked: StockedEntry[],
  color: string,
  exclude: ReadonlySet<string> = new Set(),
): RibbRoll[] {
  const rolls = stocked
    .filter((e) => e.batch.productType === 'ROLL' && isRibb(e.batch.fabricType))
    .flatMap((e) =>
      e.products
        .filter((p) => hasRollStock(p.currentWeightKg) && !exclude.has(p._id))
        .map((p) => ({ batch: e.batch, roll: p })),
    );
  const sameColor = rolls.filter((r) => norm(r.batch.color) === norm(color));
  return sameColor.length > 0 ? sameColor : rolls;
}
