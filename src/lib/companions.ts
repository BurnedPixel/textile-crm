// Compañeros — clients who buy piqué normally buy the matching combos
// (cuello + puño) with it. Pure functions, no db: the seller sees a SUGGESTION
// and always has the last word.
//
// Why nothing here is a rule:
//  · The ratio is a suggestion, never enforced. The client named two different
//    figures for it in one answer (3 and 3.5 combos per kg), which is evidence
//    enough that a hard rule would be wrong for somebody.
//  · The pairing is resolved TOLERANTLY — the seller picks from the stocked
//    unit articles rather than the app matching on a name. INFORME 001 alone
//    spells one cloth PIQUE, PIQUET, PIQU and Chemise, so a naming rule would
//    have missed most of the sales it exists to catch.

import { norm, type BatchDoc, type ProductDoc } from './types';

/**
 * Combos suggested per kilo of piqué (client answer, casilla 8). Roughly a kilo
 * of piqué is three polo shirts and each shirt takes one cuello+puño set, so
 * the order of magnitude checks out.
 *
 * Some clients want 3.5. That makes it a per-client figure rather than a
 * constant, so it stays a global default until they confirm — the seller edits
 * the number in the meantime, which costs one keystroke and no schema.
 */
export const COMBOS_PER_KG_PIQUE = 3;

/**
 * Fabric names that mean piqué. «Chemise y piqué es lo mismo» (casilla 11), so
 * chemise is a spelling of piqué here, not a second cloth. Matched on a normed
 * prefix: norm() has already folded case and accents, and the observed
 * spellings are all prefixes of each other.
 */
const PIQUE_PREFIXES = ['piqu', 'chemis'];

export function isPique(fabricType: string): boolean {
  const f = norm(fabricType);
  return PIQUE_PREFIXES.some((p) => f.startsWith(p));
}

/**
 * How many combos to offer for a piqué line. Rounded UP — combos are countable
 * and a client buying 21.4 kg is not offered 64.2 of them.
 */
export function suggestedCombos(kg: number, ratio: number = COMBOS_PER_KG_PIQUE): number {
  if (!Number.isFinite(kg) || kg <= 0) return 0;
  return Math.ceil(kg * ratio);
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
