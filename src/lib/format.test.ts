import { describe, it, expect } from 'vitest';
import { fmtLots, fmtLotsLabel } from './format';


describe('fmtLots — the lots an artículo is holding', () => {
  const roll = (currentWeightKg: number, lotNumber?: string) => ({ currentWeightKg, lotNumber });

  it('names the single lot when every roll came from one', () => {
    expect(fmtLots('ROLL', [roll(20, '4471'), roll(18, '4471')])).toBe('4471');
    expect(fmtLotsLabel('ROLL', [roll(20, '4471')])).toBe('Lote 4471');
  });

  it('lists two lots, and summarises beyond that so a cell cannot wrap', () => {
    expect(fmtLots('ROLL', [roll(20, '4482'), roll(18, '4471')])).toBe('4471 · 4482');
    expect(fmtLotsLabel('ROLL', [roll(20, '4482'), roll(18, '4471')])).toBe('Lotes 4471 · 4482');
    expect(fmtLots('ROLL', [roll(1, 'A'), roll(1, 'B'), roll(1, 'C'), roll(1, 'D')])).toBe('A · B +2');
  });

  it('ignores rolls with nothing left — an empty roll is not stock', () => {
    // Offering the lot of a sold-out roll invites the seller to promise fabric
    // that is not on the shelf.
    expect(fmtLots('ROLL', [roll(0, '4471'), roll(20, '4482')])).toBe('4482');
    expect(fmtLots('ROLL', [roll(0, '4471')])).toBe('S/L');
  });

  it('reads S/L when the stock predates lot numbers', () => {
    expect(fmtLots('ROLL', [roll(20), roll(18)])).toBe('S/L');
    expect(fmtLotsLabel('ROLL', [roll(20)])).toBe('S/L');
    expect(fmtLots('ROLL', [])).toBe('S/L');
  });

  it('keeps the pool product for COMBO/PIECE, whose count lives on the batch', () => {
    // The pool doc always has weight 0; filtering it by weight would lose the lot.
    expect(fmtLots('COMBO', [roll(0, '7252')])).toBe('7252');
    expect(fmtLots('PIECE', [roll(0, '7252')])).toBe('7252');
  });

  it('does not repeat a lot shared by several rolls', () => {
    expect(fmtLots('ROLL', [roll(5, '4471'), roll(5, '4471'), roll(5, '4471')])).toBe('4471');
  });

  it('ignores a blank lot string', () => {
    expect(fmtLots('ROLL', [roll(5, '   '), roll(5, '4471')])).toBe('4471');
  });
});
