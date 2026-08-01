import { describe, it, expect } from 'vitest';
import {
  COMBOS_PER_KG_PIQUE, isPique, suggestedCombos, companionCandidates, type StockedEntry,
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
  it('suggests 66 combos for a 22 kg piqué line', () => {
    expect(suggestedCombos(22)).toBe(66);
    expect(COMBOS_PER_KG_PIQUE).toBe(3);
  });

  it('rounds up — combos are countable', () => {
    expect(suggestedCombos(21.4)).toBe(65); // 64.2 combos is not a thing
    expect(suggestedCombos(0.1)).toBe(1);
  });

  it('honours a different ratio without one being stored anywhere', () => {
    expect(suggestedCombos(22, 3.5)).toBe(77);
  });

  it('suggests nothing for a nonsense weight', () => {
    expect(suggestedCombos(0)).toBe(0);
    expect(suggestedCombos(-5)).toBe(0);
    expect(suggestedCombos(Number.POSITIVE_INFINITY)).toBe(0);
    expect(suggestedCombos(NaN)).toBe(0);
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
