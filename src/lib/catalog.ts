// The closed catalogue (client, 2026-08-15): every colour comes off the
// physical colour chart, every fabric and yarn count off their own tables, and
// the sale price off the printed price list. All three live as config: docs so
// the client can be sent an updated chart or list without a redeploy — the app
// reads them, it does not own them.
//
// The restriction is a rule about what an operator may TYPE today (enforced by
// validateIngressForm), never about what a document may contain — imported
// history and legacy batches keep whatever colours they have, same as lots.

import { norm, type Doc } from './types';

type DB = PouchDB.Database;

export interface ChartColor {
  code: string;
  name: string;
}

/** config:colorchart — the 100-colour physical chart, transcribed. */
export interface ColorChartDoc extends Doc {
  type: 'config';
  colors: ChartColor[];
  lastUpdate: string;
}

export interface CatalogFabric {
  name: string;
  productType: 'ROLL' | 'COMBO' | 'PIECE';
  /** Yarn counts this cloth is knitted in. Empty = no data, any count allowed. */
  counts: string[];
}

/** config:catalog — the closed fabric/count catalogue. */
export interface CatalogDoc extends Doc {
  type: 'config';
  fabrics: CatalogFabric[];
  lastUpdate: string;
}

export interface BandPrices {
  divisasUsd: number;
  bsAtBcvUsd: number;
}

export interface PriceRow {
  band: string;
  comp6535?: BandPrices;
  algodon100?: BandPrices;
  importado?: BandPrices;
}

/** config:pricelist:tiendas — the printed June-2026 store price list. */
export interface PriceListDoc extends Doc {
  type: 'config';
  groups: Array<{ group: string; unit?: string; prices: PriceRow[] }>;
  lastUpdate: string;
}

const get = async <T>(db: DB, id: string): Promise<T | null> => {
  try {
    return (await db.get(id)) as T;
  } catch {
    return null;
  }
};

export const getColorChart = (db: DB) => get<ColorChartDoc>(db, 'config:colorchart');
export const getCatalog = (db: DB) => get<CatalogDoc>(db, 'config:catalog');
export const getPriceList = (db: DB) => get<PriceListDoc>(db, 'config:pricelist:tiendas');

/** The chart entry a typed colour resolves to — accent/case-insensitive. */
export function chartColorByName(chart: ColorChartDoc | null, name: string): ChartColor | null {
  if (!chart || !name.trim()) return null;
  return chart.colors.find((c) => norm(c.name) === norm(name)) ?? null;
}

export function catalogFabricByName(catalog: CatalogDoc | null, name: string): CatalogFabric | null {
  if (!catalog || !name.trim()) return null;
  return catalog.fabrics.find((f) => norm(f.name) === norm(name)) ?? null;
}

/**
 * Price-list tone band for a chart code. The chart runs 100 blanco ·
 * 2xx pasteles · 3xx medios · 4xx oscuros, and the list prices in three bands.
 * Melange (421) carries a dark-band code but the list groups it with the mids.
 */
export function bandForCode(code: string | undefined): string | null {
  const c = (code ?? '').trim();
  if (!/^\d{3}$/.test(c)) return null;
  if (c === '421') return 'MEDIOS Y MELANGE';
  if (c[0] === '1' || c[0] === '2') return 'BLANCO Y PASTELES';
  if (c[0] === '3') return 'MEDIOS Y MELANGE';
  if (c[0] === '4') return 'OSCUROS';
  return null;
}

/**
 * Which price-list group covers a fabric at a count. Matched tolerantly on
 * normed prefixes (the PIQUE/PIQUET/PIQU lesson); jersey and ribb split by NM
 * because the list prices 30/1 apart from 24/1·20/1. Ribb resolves to
 * «RIBB 24/1 SOLO» — the list's price for ribb bought on its own; the combined
 * JERSEY-RIBB price is a sale-time concern, not an ingress default.
 */
export function priceGroupFor(fabricType: string, nm: string): string | null {
  const f = norm(fabricType);
  const n = norm(nm);
  const is = (...prefixes: string[]) => prefixes.some((p) => f.startsWith(p));
  if (is('jersey')) return n === '30-1' ? 'JERSEY-RIBB 30/1' : 'JERSEY-RIBB 24/1 Y 20/1';
  if (is('rib')) return 'RIBB 24/1 SOLO';
  if (is('piqu', 'chemis')) return 'PIQUET 24/1 Y 20/1';
  if (is('combo', 'cuello', 'puno')) return 'CUELLOS Y PUÑOS';
  if (is('fleece')) return 'FLEECE 24/1';
  if (is('interlock')) return 'INTERLOCK RIBB 30/1';
  // norm() folds whitespace and «/» to dashes, so multi-word prefixes are
  // written in normed form: 'dry-fit' matches «Dry fit», «DRY-FIT», «dry/fit».
  if (is('sabina', 'atletica', 'muselina')) return 'SABINA-ATLETICA-MUSELINA';
  if (is('unipolo', 'superpolo', 'galleta')) return 'UNIPOLO PIQUET POLI';
  if (is('poly-lycra', 'polylicra', 'poliester-licra', 'licra', 'lycra')) return 'POLIESTER LICRA 75/1';
  if (is('dry-fit', 'dryfit')) return 'DRY-FIT';
  return null;
}

/**
 * The list price to prefill at ingress: group by fabric+NM, band by the chart
 * code, 65/35 composition first (the list's main column), divisas price. Null
 * whenever any link is missing — a prefill must never invent a number.
 */
export function suggestedSalePriceUsd(
  priceList: PriceListDoc | null,
  fabricType: string,
  nm: string,
  colorCode: string | undefined,
): number | null {
  if (!priceList) return null;
  const groupName = priceGroupFor(fabricType, nm);
  const band = bandForCode(colorCode);
  if (!groupName || !band) return null;
  const group = priceList.groups.find((g) => g.group === groupName);
  const row = group?.prices.find((p) => p.band === band);
  const price = row?.comp6535?.divisasUsd ?? row?.algodon100?.divisasUsd;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}
