import { describe, it, expect } from 'vitest';
import { periodLabel } from './nomina-format';

describe('periodLabel', () => {
  it('formats a monthly periodKey with the Spanish month name', () => {
    expect(periodLabel('2026-08')).toBe('Agosto 2026');
    expect(periodLabel('2026-01')).toBe('Enero 2026');
  });

  it('formats a weekly periodKey as-is, prefixed', () => {
    expect(periodLabel('2026-W34')).toBe('Semana 2026-W34');
  });

  it('falls back to the raw key for anything unrecognized', () => {
    expect(periodLabel('garbage')).toBe('garbage');
  });
});
