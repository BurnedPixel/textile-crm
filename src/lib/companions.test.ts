import { describe, it, expect } from 'vitest';
import {
  COMBOS_PER_KG_PIQUE, isPique, isRibb, companionRuleFor, suggestedCombos, suggestedKg,
  companionCandidates, ribbRollCandidates, type StockedEntry,
} from './companions';
import { batchIdOf, type BatchDoc, type ProductDoc } from './types';

function entry(color: string, fabricType: string, productType: BatchDoc['productType'], units: number): StockedEntry {
  const _id = batchIdOf(color, '30', fabricType);
  const batch: BatchDoc = {
    _id, type: 'batch', color, nm: '30', fabricType, productType,
    initialUnitCount: units, currentUnits: units, location: '', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const products: ProductDoc[] = [{
    _id: `product:${_id}:stock`, type: 'product', batchId: _id, pieceId: 'stock',
    initialWeightKg: 0, currentWeightKg: 0, purchaseValueUsd: 1, salePriceUsd: 2,
    conditionTag: 'FIRST', createdAt: '2026-01-01T00:00:00.000Z',
  }];
  return { batch, products };
}

/**
 * A ROLL entry with several rolls at given weights, for ribb-candidate tests.
 * `nm` and `lots` (parallel to `weights`, one lot per roll) default to values
 * that keep the pre-cascade tests unaffected.
 */
function rollEntry(
  color: string, fabricType: string, weights: number[], nm = '30', lots: (string | undefined)[] = [],
): StockedEntry {
  const _id = batchIdOf(color, nm, fabricType);
  const batch: BatchDoc = {
    _id, type: 'batch', color, nm, fabricType, productType: 'ROLL',
    initialUnitCount: weights.length, currentUnits: weights.length, location: '', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const products: ProductDoc[] = weights.map((w, i) => ({
    _id: `product:${_id}:R${i + 1}`, type: 'product', batchId: _id, pieceId: `R${i + 1}`,
    initialWeightKg: w, currentWeightKg: w, purchaseValueUsd: 1, salePriceUsd: 2,
    conditionTag: 'FIRST', createdAt: '2026-01-01T00:00:00.000Z', lotNumber: lots[i],
  }));
  return { batch, products };
}

/** The sold roll's context, for ribbRollCandidates cascade tests. */
function sold(color: string, nm = '30', lotNumber?: string) {
  return { color, nm, lotNumber };
}

describe('isPique — chemise is a spelling of piqué, not a second cloth', () => {
  it('matches every spelling that appears in the real data', () => {
    for (const name of ['Piqué', 'PIQUE', 'PIQUET', 'PIQU', 'piqué', 'Chemise', 'CHEMIS']) {
      expect(isPique(name)).toBe(true);
    }
  });

  it('does not match other fabrics', () => {
    for (const name of ['Jersey', 'Rib', 'Interlock', 'Franela', 'Combo']) {
      expect(isPique(name)).toBe(false);
    }
  });
});

describe('suggestedCombos — a suggestion, rounded up', () => {
  it('suggests 77 combos for a 22 kg piqué line, per the 2026-08-15 standard', () => {
    expect(suggestedCombos(22)).toBe(77);
    expect(COMBOS_PER_KG_PIQUE).toBe(3.5);
  });

  it('rounds up — combos are countable', () => {
    expect(suggestedCombos(21.4)).toBe(75); // 74.9 combos is not a thing
    expect(suggestedCombos(0.1)).toBe(1);
  });

  it('honours a different ratio without one being stored anywhere', () => {
    expect(suggestedCombos(22, 3)).toBe(66);
  });

  it('suggests nothing for a nonsense weight', () => {
    expect(suggestedCombos(0)).toBe(0);
    expect(suggestedCombos(-5)).toBe(0);
    expect(suggestedCombos(Number.POSITIVE_INFINITY)).toBe(0);
    expect(suggestedCombos(NaN)).toBe(0);
  });
});

describe('isRibb', () => {
  it('matches every spelling observed in real data', () => {
    for (const name of ['Rib', 'Ribb', 'RIB 1X1', 'rib']) {
      expect(isRibb(name)).toBe(true);
    }
  });

  it('does not match other fabrics', () => {
    for (const name of ['Jersey', 'Interlock', 'Combo', 'Franela']) {
      expect(isRibb(name)).toBe(false);
    }
  });
});

describe('companionRuleFor — the pairing per fabric, per the 2026-08-15 standard', () => {
  it('pairs piqué with combos at 3.5 per kg', () => {
    for (const name of ['Piqué', 'Chemise']) {
      expect(companionRuleFor(name)).toEqual({ companion: 'combos', ratio: 3.5, label: 'piqué' });
    }
  });

  it('pairs jersey with ribb at 5% per kg', () => {
    for (const name of ['Jersey', 'JERSEY']) {
      expect(companionRuleFor(name)).toEqual({ companion: 'ribb', ratio: 0.05, label: 'jersey' });
    }
  });

  it('pairs fleece with ribb at 12% per kg', () => {
    expect(companionRuleFor('Fleece')).toEqual({ companion: 'ribb', ratio: 0.12, label: 'fleece' });
  });

  it('pairs nothing else, including ribb itself', () => {
    for (const name of ['Rib', 'Interlock', 'Combo']) {
      expect(companionRuleFor(name)).toBeNull();
    }
  });
});

describe('suggestedKg — ribb by weight, rounded to 2 decimals', () => {
  it('computes the ribb weight for a given ratio', () => {
    expect(suggestedKg(22, 0.05)).toBe(1.1);
    expect(suggestedKg(18, 0.12)).toBe(2.16);
    expect(suggestedKg(21.4, 0.05)).toBe(1.07);
  });

  it('suggests nothing for a nonsense weight', () => {
    expect(suggestedKg(0, 0.05)).toBe(0);
    expect(suggestedKg(-5, 0.05)).toBe(0);
    expect(suggestedKg(Number.POSITIVE_INFINITY, 0.05)).toBe(0);
    expect(suggestedKg(NaN, 0.05)).toBe(0);
  });
});

describe('companionCandidates — tolerant, and never empty when stock exists', () => {
  const stocked = [
    entry('Azul Rey', 'Jersey', 'ROLL', 5),
    entry('Azul Rey', 'Combo', 'COMBO', 40),
    entry('Negro', 'Combo', 'COMBO', 12),
    entry('Blanco', 'Franela', 'PIECE', 8),
    entry('Verde', 'Combo', 'COMBO', 0), // out of stock
  ];

  it('narrows to the colour of the piqué line when any unit article matches', () => {
    const found = companionCandidates(stocked, 'Azul Rey');
    expect(found.map((e) => e.batch.fabricType)).toEqual(['Combo']);
    expect(found[0].batch.color).toBe('Azul Rey');
  });

  it('falls back to every stocked unit article when the colour matches none', () => {
    const found = companionCandidates(stocked, 'Rojo Vino');
    expect(found.map((e) => e.batch.color).sort()).toEqual(['Azul Rey', 'Blanco', 'Negro']);
  });

  it('never offers a roll, and never offers something out of stock', () => {
    for (const found of [companionCandidates(stocked, 'Azul Rey'), companionCandidates(stocked, 'Rojo')]) {
      expect(found.every((e) => e.batch.productType !== 'ROLL')).toBe(true);
      expect(found.every((e) => e.batch.currentUnits > 0)).toBe(true);
    }
  });

  it('matches the colour accent- and case-insensitively', () => {
    const alt = [entry('ROJO VINO', 'Combo', 'COMBO', 9), ...stocked];
    expect(companionCandidates(alt, 'Rojo Vino').map((e) => e.batch.color)).toEqual(['ROJO VINO']);
  });

  it('offers nothing at all when there is no unit stock', () => {
    expect(companionCandidates([entry('Azul', 'Jersey', 'ROLL', 3)], 'Azul')).toEqual([]);
  });
});

describe('ribbRollCandidates — tolerant, never falling back to non-ribb rolls', () => {
  const stocked = [
    rollEntry('Azul Rey', 'Jersey', [10, 15]),
    rollEntry('Azul Rey', 'Ribb', [5, 0.0005]), // second roll is empty
    rollEntry('Negro', 'Ribb', [8]),
    rollEntry('Blanco', 'Fleece', [12]),
  ];

  it('narrows to the sold colour+NM when that colour has ribb', () => {
    const found = ribbRollCandidates(stocked, sold('Azul Rey'));
    expect(found.map((r) => r.roll.pieceId)).toEqual(['R1']);
    expect(found.every((r) => r.batch.color === 'Azul Rey')).toBe(true);
  });

  it('falls back to every stocked ribb roll when the colour matches none', () => {
    const found = ribbRollCandidates(stocked, sold('Rojo Vino'));
    expect(found.map((r) => r.batch.color).sort()).toEqual(['Azul Rey', 'Negro']);
  });

  it('excludes empty rolls', () => {
    const found = ribbRollCandidates(stocked, sold('Azul Rey'));
    expect(found.length).toBeGreaterThan(0); // .every() passes vacuously on []
    expect(found.every((r) => r.roll.currentWeightKg > 0.001)).toBe(true);
  });

  it('never offers a non-ribb ROLL batch', () => {
    for (const found of [ribbRollCandidates(stocked, sold('Azul Rey')), ribbRollCandidates(stocked, sold('Rojo'))]) {
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((r) => r.batch.fabricType === 'Ribb')).toBe(true);
    }
  });

  it('falls back when the sold colour has ribb but none of it is usable', () => {
    // Rolls are filtered BEFORE the cascade — a same-colour batch whose rolls
    // are all empty must not kill the fallback.
    const s = [rollEntry('Azul Rey', 'Ribb', [0.0005]), rollEntry('Negro', 'Ribb', [8])];
    expect(ribbRollCandidates(s, sold('Azul Rey')).map((r) => r.batch.color)).toEqual(['Negro']);
  });

  it('falls back when every same-colour roll is excluded (already in the cart)', () => {
    const azul = ribbRollCandidates(stocked, sold('Azul Rey'));
    const inCart = new Set(azul.map((r) => r.roll._id));
    const found = ribbRollCandidates(stocked, sold('Azul Rey'), inCart);
    expect(found.map((r) => r.batch.color)).toEqual(['Negro']);
  });

  it('is empty when nothing ribb is stocked', () => {
    expect(ribbRollCandidates([rollEntry('Azul', 'Jersey', [5])], sold('Azul'))).toEqual([]);
  });

  it('matches the colour accent- and case-insensitively', () => {
    const alt = [rollEntry('ROJO VINO', 'Ribb', [4]), ...stocked];
    expect(ribbRollCandidates(alt, sold('Rojo Vino')).map((r) => r.batch.color)).toEqual(['ROJO VINO']);
  });

  describe('lot/NM cascade (R2-3, 2026-08-15)', () => {
    it('the lot tier refines colour+NM — a same-lot roll of another colour never displaces it', () => {
      // «Lote» is the supplier's printed number, no identity: the same number
      // recurs across colours. Lot alone must not hand an Azul Rey jersey a
      // Negro ribb.
      const s = [
        rollEntry('Negro', 'Ribb', [8], '24', ['220']),
        rollEntry('Azul Rey', 'Ribb', [5], '30', ['8890']),
      ];
      const found = ribbRollCandidates(s, sold('Azul Rey', '30', '220'));
      expect(found.map((r) => r.batch.color)).toEqual(['Azul Rey']);
    });

    it('within the same colour+NM, the sold lot is the default pick', () => {
      const s = [rollEntry('Azul Rey', 'Ribb', [5, 4], '30', ['9001', '4471'])];
      const found = ribbRollCandidates(s, sold('Azul Rey', '30', '4471'));
      expect(found.map((r) => r.roll.lotNumber)).toEqual(['4471']);
    });

    it('lot match is trim-exact', () => {
      const s = [rollEntry('Negro', 'Ribb', [8], '30', [' 4471 '])];
      expect(ribbRollCandidates(s, sold('Negro', '30', '4471')).map((r) => r.roll.pieceId)).toEqual(['R1']);
    });

    it('skips the lot tier when the sold roll has no lot — colour+NM applies instead', () => {
      const s = [
        rollEntry('Azul Rey', 'Ribb', [5], '30', ['4471']),
        rollEntry('Azul Rey', 'Ribb', [3], '40', [undefined]),
      ];
      const found = ribbRollCandidates(s, sold('Azul Rey', '30'));
      expect(found.map((r) => r.batch.nm)).toEqual(['30']);
    });

    it('same colour+NM beats same colour with a different NM', () => {
      const s = [
        rollEntry('Azul Rey', 'Ribb', [5], '30', [undefined]),
        rollEntry('Azul Rey', 'Ribb', [3], '40', [undefined]),
      ];
      const found = ribbRollCandidates(s, sold('Azul Rey', '30'));
      expect(found.map((r) => r.batch.nm)).toEqual(['30']);
    });
  });
});
