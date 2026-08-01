import { describe, it, expect } from 'vitest';
import { validateIngressForm, ingressFormIsValid, type IngressFormValues } from './inventory';

const rollForm = (over: Partial<IngressFormValues> = {}): IngressFormValues => ({
  color: 'Azul Rey', nm: '30', fabricType: 'Jersey', productType: 'ROLL',
  lotNumber: '4471',
  purchaseValueUsd: '8', salePriceUsd: '10',
  rolls: [{ weightKg: '28', purchaseValueUsd: '', salePriceUsd: '' }],
  units: '', unitPurchaseValueUsd: '', unitSalePriceUsd: '',
  ...over,
});

const unitForm = (over: Partial<IngressFormValues> = {}): IngressFormValues =>
  rollForm({ productType: 'COMBO', rolls: [], units: '40', unitPurchaseValueUsd: '1', unitSalePriceUsd: '2', ...over });

describe('validateIngressForm — nothing gets registered blank', () => {
  it('accepts a complete roll arrival', () => {
    expect(validateIngressForm(rollForm())).toEqual({});
    expect(ingressFormIsValid(validateIngressForm(rollForm()))).toBe(true);
  });

  it('REQUIRES the lot number — the whole point of this guard', () => {
    // Four rolls went onto the shelf reading S/L because this was optional.
    expect(validateIngressForm(rollForm({ lotNumber: '' })).lotNumber).toBe('Obligatorio.');
    expect(validateIngressForm(rollForm({ lotNumber: '   ' })).lotNumber).toBe('Obligatorio.');
  });

  it('requires the article identity, per field', () => {
    const e = validateIngressForm(rollForm({ color: '', nm: '  ', fabricType: '' }));
    expect(e.color).toBe('Obligatorio.');
    expect(e.nm).toBe('Obligatorio.');
    expect(e.fabricType).toBe('Obligatorio.');
  });

  it('caps every text field', () => {
    const e = validateIngressForm(rollForm({ lotNumber: 'x'.repeat(61), color: 'y'.repeat(61) }));
    expect(e.lotNumber).toMatch(/60 caracteres/);
    expect(e.color).toMatch(/60 caracteres/);
  });

  it('refuses an arrival with no roll carrying a weight', () => {
    expect(validateIngressForm(rollForm({ rolls: [] })).rolls).toMatch(/al menos un rollo/i);
    expect(validateIngressForm(rollForm({
      rolls: [{ weightKg: '  ', purchaseValueUsd: '', salePriceUsd: '' }],
    })).rolls).toMatch(/al menos un rollo/i);
  });

  it('rejects a weight that is not a number, pointing at the row', () => {
    const e = validateIngressForm(rollForm({
      rolls: [
        { weightKg: '28', purchaseValueUsd: '', salePriceUsd: '' },
        { weightKg: '12abc', purchaseValueUsd: '', salePriceUsd: '' },
        { weightKg: '0', purchaseValueUsd: '', salePriceUsd: '' },
      ],
    }));
    expect(e.rollWeights?.[0]).toBeUndefined();
    expect(e.rollWeights?.[1]).toBe('Debe ser un número.');   // parseFloat would have read 12
    expect(e.rollWeights?.[2]).toMatch(/mayor que cero/);
  });

  it('rejects Infinity, which passes a bare > 0', () => {
    const e = validateIngressForm(rollForm({
      rolls: [{ weightKg: '1e999', purchaseValueUsd: '', salePriceUsd: '' }],
    }));
    expect(e.rollWeights?.[0]).toBe('Debe ser un número.');
    expect(validateIngressForm(rollForm({ purchaseValueUsd: '1e999' })).purchaseValueUsd)
      .toBe('Debe ser un número.');
  });

  it('demands the batch default only when a row actually inherits it', () => {
    // Row leaves cost blank → the default has to exist.
    expect(validateIngressForm(rollForm({ purchaseValueUsd: '' })).purchaseValueUsd).toBe('Obligatorio.');
    // Every row states its own → the blank default is nobody's problem.
    expect(validateIngressForm(rollForm({
      purchaseValueUsd: '', salePriceUsd: '',
      rolls: [{ weightKg: '28', purchaseValueUsd: '7', salePriceUsd: '9' }],
    })).purchaseValueUsd).toBeUndefined();
  });

  it('rejects a negative price', () => {
    expect(validateIngressForm(rollForm({ salePriceUsd: '-1' })).salePriceUsd).toMatch(/negativo/);
  });

  it('lets a zero cost through — a sample can genuinely cost nothing', () => {
    expect(validateIngressForm(rollForm({ purchaseValueUsd: '0' })).purchaseValueUsd).toBeUndefined();
  });
});

describe('validateIngressForm — COMBO/PIECE', () => {
  it('accepts a complete unit arrival', () => {
    expect(validateIngressForm(unitForm())).toEqual({});
  });

  it('requires units, cost and price', () => {
    const e = validateIngressForm(unitForm({ units: '', unitPurchaseValueUsd: '', unitSalePriceUsd: '' }));
    expect(e.units).toBe('Obligatorio.');
    expect(e.unitPurchaseValueUsd).toBe('Obligatorio.');
    expect(e.unitSalePriceUsd).toBe('Obligatorio.');
  });

  it('insists units are a whole number above zero', () => {
    expect(validateIngressForm(unitForm({ units: '0' })).units).toMatch(/mayor que cero/);
    expect(validateIngressForm(unitForm({ units: '-4' })).units).toMatch(/mayor que cero/);
    expect(validateIngressForm(unitForm({ units: '4.5' })).units).toMatch(/entero/);
    expect(validateIngressForm(unitForm({ units: 'muchos' })).units).toBe('Debe ser un número.');
  });

  it('still requires the lot on a combo arrival', () => {
    expect(validateIngressForm(unitForm({ lotNumber: '' })).lotNumber).toBe('Obligatorio.');
  });

  it('does not complain about roll fields it is not using', () => {
    const e = validateIngressForm(unitForm({ purchaseValueUsd: '', salePriceUsd: '' }));
    expect(e.purchaseValueUsd).toBeUndefined();
    expect(e.rolls).toBeUndefined();
  });
});
