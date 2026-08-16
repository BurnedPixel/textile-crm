import { describe, it, expect } from 'vitest';
import {
  chartColorByName, catalogFabricByName, bandForCode, priceGroupFor, suggestedSalePriceUsd,
  type ColorChartDoc, type CatalogDoc, type PriceListDoc,
} from './catalog';
import { validateIngressForm, type IngressFormValues } from './inventory';

const chart: ColorChartDoc = {
  _id: 'config:colorchart', type: 'config', lastUpdate: '2026-08-15T00:00:00.000Z',
  colors: [
    { code: '100', name: 'Blanco' },
    { code: '215', name: 'Melon' },
    { code: '405', name: 'Azul rey' },
    { code: '421', name: 'Melange' },
    { code: '424', name: 'Negro' },
  ],
};

const catalog: CatalogDoc = {
  _id: 'config:catalog', type: 'config', lastUpdate: '2026-08-15T00:00:00.000Z',
  fabrics: [
    { name: 'Jersey', productType: 'ROLL', counts: ['20/1', '24/1', '30/1'] },
    { name: 'Combo', productType: 'COMBO', counts: ['20/1', '24/1'] },
    { name: 'Muselina', productType: 'ROLL', counts: [] },
  ],
};

const priceList: PriceListDoc = {
  _id: 'config:pricelist:tiendas', type: 'config', lastUpdate: '2026-08-15T00:00:00.000Z',
  groups: [
    { group: 'JERSEY-RIBB 24/1 Y 20/1', prices: [
      { band: 'BLANCO Y PASTELES', comp6535: { divisasUsd: 7.3, bsAtBcvUsd: 11.5 } },
      { band: 'OSCUROS', comp6535: { divisasUsd: 9.0, bsAtBcvUsd: 14.5 } },
    ] },
    { group: 'JERSEY-RIBB 30/1', prices: [
      { band: 'OSCUROS', comp6535: { divisasUsd: 9.0, bsAtBcvUsd: 14.5 } },
    ] },
    { group: 'CUELLOS Y PUÑOS', prices: [
      { band: 'MEDIOS Y MELANGE', comp6535: { divisasUsd: 1.0, bsAtBcvUsd: 1.25 } },
    ] },
    { group: 'SABINA-ATLETICA-MUSELINA', prices: [
      { band: 'BLANCO Y PASTELES', comp6535: { divisasUsd: 6.7, bsAtBcvUsd: 10.5 } },
      // MEDIOS row deliberately absent — the printed list leaves it blank.
    ] },
  ],
};

describe('chart and catalogue lookups — accent/case-insensitive', () => {
  it('resolves chart colours however they are typed', () => {
    expect(chartColorByName(chart, 'azul rey')?.code).toBe('405');
    expect(chartColorByName(chart, 'MELÓN')?.code).toBe('215');
    expect(chartColorByName(chart, 'Coral')).toBeNull();
    expect(chartColorByName(null, 'Blanco')).toBeNull();
  });

  it('resolves catalogue fabrics', () => {
    expect(catalogFabricByName(catalog, 'JERSEY')?.counts).toContain('30/1');
    expect(catalogFabricByName(catalog, 'Franela')).toBeNull();
  });
});

describe('bandForCode — the chart bands the price list keys on', () => {
  it('maps 100/2xx to blancos y pasteles, 3xx to medios, 4xx to oscuros', () => {
    expect(bandForCode('100')).toBe('BLANCO Y PASTELES');
    expect(bandForCode('215')).toBe('BLANCO Y PASTELES');
    expect(bandForCode('307')).toBe('MEDIOS Y MELANGE');
    expect(bandForCode('424')).toBe('OSCUROS');
  });

  it('prices melange (421) with the mids despite its dark-band code', () => {
    expect(bandForCode('421')).toBe('MEDIOS Y MELANGE');
  });

  it('rejects anything that is not a three-digit chart code', () => {
    for (const bad of [undefined, '', '42', '4211', '5xx', '999']) {
      expect(bandForCode(bad)).toBeNull();
    }
  });
});

describe('priceGroupFor — tolerant fabric→group mapping', () => {
  it('splits jersey by count', () => {
    expect(priceGroupFor('Jersey', '20/1')).toBe('JERSEY-RIBB 24/1 Y 20/1');
    expect(priceGroupFor('JERSEY', '30/1')).toBe('JERSEY-RIBB 30/1');
  });

  it('covers the observed spellings', () => {
    expect(priceGroupFor('PIQUET', '24/1')).toBe('PIQUET 24/1 Y 20/1');
    expect(priceGroupFor('Chemise', '20/1')).toBe('PIQUET 24/1 Y 20/1');
    expect(priceGroupFor('Rib 1x1', '24/1')).toBe('RIBB 24/1 SOLO');
    expect(priceGroupFor('Cuellos y puños', '20/1')).toBe('CUELLOS Y PUÑOS');
    expect(priceGroupFor('Dry fit', '100/1')).toBe('DRY-FIT');
    expect(priceGroupFor('Poly Lycra', '75/1')).toBe('POLIESTER LICRA 75/1');
    expect(priceGroupFor('Muselina', '75/1')).toBe('SABINA-ATLETICA-MUSELINA');
  });

  it('maps nothing it does not know', () => {
    expect(priceGroupFor('Franela', '20/1')).toBeNull();
  });
});

describe('suggestedSalePriceUsd — a prefill never invents a number', () => {
  it('resolves group × band × composition to the divisas price', () => {
    expect(suggestedSalePriceUsd(priceList, 'Jersey', '20/1', '100')).toBe(7.3);
    expect(suggestedSalePriceUsd(priceList, 'Jersey', '30/1', '424')).toBe(9.0);
    expect(suggestedSalePriceUsd(priceList, 'Combo', '20/1', '421')).toBe(1.0);
  });

  it('returns null when any link is missing', () => {
    expect(suggestedSalePriceUsd(null, 'Jersey', '20/1', '100')).toBeNull();
    expect(suggestedSalePriceUsd(priceList, 'Jersey', '20/1', undefined)).toBeNull(); // no code
    expect(suggestedSalePriceUsd(priceList, 'Franela', '20/1', '100')).toBeNull();    // no group
    expect(suggestedSalePriceUsd(priceList, 'Muselina', '75/1', '307')).toBeNull();   // band row absent
  });
});

describe('validateIngressForm with the closed catalogue', () => {
  const base: IngressFormValues = {
    color: 'Azul rey', nm: '20/1', fabricType: 'Jersey', productType: 'ROLL',
    colorCode: '405', lotNumber: '7892',
    purchaseValueUsd: '5', salePriceUsd: '8',
    rolls: [{ weightKg: '10', purchaseValueUsd: '', salePriceUsd: '' }],
    units: '', unitPurchaseValueUsd: '', unitSalePriceUsd: '',
  };
  const ctx = { chartColors: chart.colors.map((c) => c.name), fabrics: catalog.fabrics };

  it('accepts a chart colour and catalogued fabric/count, however typed', () => {
    const e = validateIngressForm({ ...base, color: 'AZUL REY', fabricType: 'jersey' }, ctx);
    expect(e.color).toBeUndefined();
    expect(e.fabricType).toBeUndefined();
    expect(e.nm).toBeUndefined();
  });

  it('rejects an off-chart colour with a Spanish message', () => {
    expect(validateIngressForm({ ...base, color: 'Rojo Vino' }, ctx).color)
      .toMatch(/carta de colores/);
  });

  it('rejects an off-catalogue fabric and an off-count NM', () => {
    expect(validateIngressForm({ ...base, fabricType: 'Franela' }, ctx).fabricType)
      .toMatch(/catálogo/);
    expect(validateIngressForm({ ...base, nm: '40/1' }, ctx).nm).toMatch(/20\/1/);
  });

  it('leaves the count free when the catalogue has no data for that fabric', () => {
    const e = validateIngressForm({ ...base, fabricType: 'Muselina', nm: '75/1' }, ctx);
    expect(e.nm).toBeUndefined();
  });

  it('restricts nothing when the reference docs are not loaded', () => {
    const e = validateIngressForm({ ...base, color: 'Rojo Vino', fabricType: 'Franela' });
    expect(e.color).toBeUndefined();
    expect(e.fabricType).toBeUndefined();
  });

  const BLENDS = ['65% poliéster / 35% algodón', '48% poliéster / 52% algodón', '100% algodón'];

  it('accepts the standard blends and an empty composition', () => {
    for (const blend of [...BLENDS, '', undefined]) {
      const e = validateIngressForm({ ...base, fiberComposition: blend }, { ...ctx, compositions: BLENDS });
      expect(e.fiberComposition).toBeUndefined();
    }
  });

  it('rejects a non-standard blend, but only when the catalogue is loaded', () => {
    const off = { ...base, fiberComposition: '95% algodón / 5% elastano' };
    expect(validateIngressForm(off, { ...ctx, compositions: BLENDS }).fiberComposition)
      .toMatch(/mezclas estándar/);
    expect(validateIngressForm(off, ctx).fiberComposition).toBeUndefined();
    // The form appends an existing article's stored legacy blend to the list —
    // exactly what its Select offers — and that must pass.
    expect(validateIngressForm(off, { ...ctx, compositions: [...BLENDS, '95% algodón / 5% elastano'] })
      .fiberComposition).toBeUndefined();
  });
});
