/**
 * Load a parsed INFORME (docs/spread/informe.json) into a CouchDB/PouchDB
 * database THROUGH THE REAL LOGIC MODULES — saveClient, ingressStock, checkout.
 * Never a raw put: the import must exercise the same validation, the same
 * cached-counter updates and the same movement ledger production does.
 *
 *   node <bundle> --target=<url|memory> [--wipe] [--dry]
 *
 * --wipe deletes business documents first, PRESERVING rate: (real BCV history
 * written by the VPS service, which cannot be backfilled), config:system and
 * _design/*. The _users database is never touched — logins are separate.
 *
 * What the spreadsheet does not carry is invented deterministically, so a
 * re-run produces identical ids: client documents (cédula/RIF), lot numbers
 * where the description had none, pantone, fibre composition and cost prices.
 */
import PouchDB from 'pouchdb';
import memory from 'pouchdb-adapter-memory';
import { readFileSync } from 'node:fs';

import { saveClient } from '../src/lib/queries';
import { ingressStock } from '../src/lib/inventory';
import { checkout } from '../src/lib/checkout';
import { clientIdOf, type CartLineItem } from '../src/lib/types';
import { round2, fmtLot } from '../src/lib/format';

PouchDB.plugin(memory);

// ---- input ------------------------------------------------------------------

interface Line {
  raw: string; qty: number; unit: 'Kg' | 'Units'; price: number;
  color: string; nm: string; fabricType: string;
  productType: 'ROLL' | 'COMBO'; lot: string | null;
}
interface Sale {
  ref: string; day: string; date: string; client: string; rate: number;
  lines: Line[]; paidUsdCash: number; paidUsdTransfer: number; paidBs: number; obs: string;
}
interface Informe { source: string; week: string[]; sales: Sale[] }

// ---- deterministic invention ------------------------------------------------

/** FNV-1a — a stable small hash, so every re-run invents the same values. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const digits = (seed: string, n: number): string =>
  String(hash(seed)).padStart(n, '7').slice(0, n);

const COMPANY_HINTS = /\b(C\.?A\.?|S\.?A\.?|SRL|CONFECCIONES|CONFEC|UNIFORMES|TEXTIL|CREACIONES|INVERSIONES|DISTRIBUIDORA|COMERCIAL|GRUPO|CORP|INDUSTRIAS|MANUFACTURA|TALLER|BORDADOS|ALMACEN|COBRACA|AVANCE)\b/i;

/**
 * The report names clients but carries no document number, and documentId is
 * the natural key (`client:{norm(documentId)}`) — so one has to be invented.
 * Derived from the name, so the same client always lands on the same _id.
 */
function inventClient(name: string) {
  const isCompany = COMPANY_HINTS.test(name);
  const documentId = isCompany
    ? `J-${digits('rif' + name, 8)}-${digits('dv' + name, 1)}`
    : `V-${digits('ced' + name, 8)}`;
  return { documentId, entityType: isCompany ? ('COMPANY' as const) : ('PERSON' as const) };
}

/** Their real lots run in the 7000s (7252, 7650, 7736, 7744) — invent in range. */
const inventLot = (seed: string): string => String(7000 + (hash(seed) % 900));
const inventPantone = (color: string): string =>
  `${11 + (hash(color) % 8)}-${1000 + (hash('p' + color) % 8999)} TCX`;

function inventComposition(fabric: string): string {
  if (/dry fit/i.test(fabric)) return '100% poliéster';
  if (/ribb|cuellos|puños/i.test(fabric)) return '95% algodón / 5% elastano';
  if (/interlock/i.test(fabric)) return '100% algodón peinado';
  return '100% algodón';
}

// ---- helpers ----------------------------------------------------------------

const articleKey = (l: Line) => `${l.color}|${l.nm}|${l.fabricType}`;

/** Spread a day's sales across working hours so ordering is sensible. */
function saleTimestamp(date: string, index: number): string {
  const minutes = 8 * 60 + Math.min(index * 17, 9 * 60 - 1); // 08:00 onward
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00.000Z`;
}

const arg = (name: string, fallback = '') =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const flag = (name: string) => process.argv.includes(`--${name}`);

// ---- wipe -------------------------------------------------------------------

const PRESERVE = /^(_design\/|rate:|config:system$|_local\/)/;

async function wipe(db: PouchDB.Database): Promise<void> {
  const all = await db.allDocs();
  const doomed = all.rows.filter((r) => !PRESERVE.test(r.id));
  if (!doomed.length) {
    console.log('   nothing to delete');
    return;
  }
  const res = await db.bulkDocs(
    doomed.map((r) => ({ _id: r.id, _rev: r.value.rev, _deleted: true })) as never[],
  );
  const failed = res.filter((r) => 'error' in r);
  console.log(`   deleted ${doomed.length - failed.length}/${doomed.length} documents` +
    (failed.length ? ` (${failed.length} failed)` : ''));
  console.log(`   preserved ${all.rows.length - doomed.length} (rates, config, design docs)`);
}

// ---- main -------------------------------------------------------------------

async function main() {
  const target = arg('target', 'memory');
  const informe: Informe = JSON.parse(readFileSync(arg('file', 'docs/spread/informe.json'), 'utf8'));
  const remote: PouchDB.Database | null = target === 'memory'
    ? null
    : new PouchDB(target, { skip_setup: true } as never);

  // ALWAYS build into a local in-memory database, even when the destination is
  // the server. Driving the domain modules straight at a remote CouchDB means
  // ~600 sequential HTTPS round-trips — minutes of silence, and an interruption
  // leaves the database half-imported. Building locally takes about a second;
  // the result is then pushed in a few bulk requests, so the window in which
  // production is inconsistent is as short as it can be.
  const db: PouchDB.Database = new PouchDB(`import-${Date.now()}`, { adapter: 'memory' });

  console.log(`target: ${remote ? target.replace(/\/\/[^@]*@/, '//') : 'in-memory (dry run)'}`);
  console.log(`source: ${informe.source} — ${informe.sales.length} sales, week ${informe.week[0]}…${informe.week.at(-1)}`);
  console.log('building locally first, then pushing in bulk\n');

  // --- clients -------------------------------------------------------------
  console.log('\n2. clients');
  const names = [...new Set(informe.sales.map((s) => s.client).filter(Boolean))];
  const clientIdByName = new Map<string, string>();
  let ci = 0;
  for (const name of names) {
    process.stdout.write(`\r   ${++ci}/${names.length}`);
    const { documentId, entityType } = inventClient(name);
    // Titles the name so "GUILLERMO MUNEVAR" and "Guillermo Munevar" read alike.
    const tidy = name.replace(/\s+/g, ' ').trim();
    await saveClient(db, { documentId, entityType, name: tidy, specialty: [] });
    clientIdByName.set(name, clientIdOf(documentId));
  }
  console.log(`\r   ${names.length} clients (documents invented deterministically)`);

  // --- stock ---------------------------------------------------------------
  // One ingress per article, sized to cover everything sold that week plus a
  // remainder, so the app opens with live stock rather than an empty warehouse.
  console.log('\n3. inventory');
  const articles = new Map<string, { line: Line; kg: number; units: number; maxLine: number; prices: number[]; lots: string[] }>();
  for (const s of informe.sales) {
    for (const l of s.lines) {
      const k = articleKey(l);
      const a = articles.get(k) ?? { line: l, kg: 0, units: 0, maxLine: 0, prices: [], lots: [] };
      if (l.unit === 'Kg') { a.kg += l.qty; a.maxLine = Math.max(a.maxLine, l.qty); }
      else a.units += l.qty;
      a.prices.push(l.price);
      if (l.lot && !a.lots.includes(l.lot)) a.lots.push(l.lot);
      articles.set(k, a);
    }
  }

  // Roll ledger for the checkout phase: which roll can still serve a line.
  const rollsByArticle = new Map<string, { pieceId: string; remaining: number; lot: string }[]>();
  let rollCount = 0;

  let ai = 0;
  for (const [key, a] of articles) {
    process.stdout.write(`\r   ${++ai}/${articles.size}`);
    const { color, nm, fabricType, productType } = a.line;
    const salePrice = round2(a.prices.sort((x, y) => x - y)[Math.floor(a.prices.length / 2)]);
    const cost = round2(salePrice * 0.65);      // invented: no cost column in the report

    if (productType === 'ROLL') {
      // Rolls must be at least as heavy as the largest single line — a cart line
      // draws from ONE roll, so a 102 kg line cannot come off a 25 kg roll.
      const rollKg = Math.max(25, Math.ceil(a.maxLine * 1.1));
      const needed = Math.ceil((a.kg * 1.25) / rollKg) + 1;   // +25% so stock remains
      const rolls = Array.from({ length: needed }, (_, i) => ({
        pieceId: `R${i + 1}`,
        weightKg: rollKg,
        purchaseValueUsd: cost,
        salePriceUsd: salePrice,
        conditionTag: (/segunda/i.test(fabricType) ? 'SECONDS' : 'FIRST') as 'SECONDS' | 'FIRST',
      }));
      // A lot number per ingress; real ones from the description win.
      const lot = a.lots[0] ?? inventLot(key);
      await ingressStock(db, {
        color, nm, fabricType, productType: 'ROLL',
        location: 'Depósito A', operatorId: 'importacion',
        reason: `Inventario inicial — ${informe.source}`,
        lotNumber: lot,
        pantone: inventPantone(color),
        fiberComposition: inventComposition(fabricType),
        rolls,
      });
      rollsByArticle.set(key, rolls.map((r) => ({ pieceId: r.pieceId, remaining: r.weightKg, lot })));
      rollCount += rolls.length;
    } else {
      await ingressStock(db, {
        color, nm, fabricType, productType: 'COMBO',
        location: 'Depósito B', operatorId: 'importacion',
        reason: `Inventario inicial — ${informe.source}`,
        lotNumber: a.lots[0] ?? inventLot(key),
        pantone: inventPantone(color),
        fiberComposition: inventComposition(fabricType),
        units: Math.ceil(a.units * 1.25) + 10,
        unitPurchaseValueUsd: cost,
        unitSalePriceUsd: salePrice,
        unitConditionTag: 'FIRST',
      });
    }
  }
  console.log(`\r   ${articles.size} articles · ${rollCount} rolls · ${[...articles.values()].filter((a) => a.line.productType === 'COMBO').length} unit pools`);

  // --- sales ---------------------------------------------------------------
  console.log('\n4. sales');
  const ordered = [...informe.sales].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  let done = 0, failed = 0;
  const perDay = new Map<string, number>();

  for (const s of ordered) {
    process.stdout.write(`\r   ${done + failed + 1}/${ordered.length}`);
    const idx = perDay.get(s.date) ?? 0;
    perDay.set(s.date, idx + 1);

    const lines: CartLineItem[] = [];
    let ok = true;
    for (const l of s.lines) {
      const key = articleKey(l);
      const batchId = `batch:${slug(l.color)}:${slug(l.nm)}:${slug(l.fabricType)}`;
      if (l.unit === 'Kg') {
        const roll = (rollsByArticle.get(key) ?? []).find((r) => r.remaining >= l.qty);
        if (!roll) { ok = false; break; }
        roll.remaining = round2(roll.remaining - l.qty);
        lines.push({
          productId: `${batchId.replace('batch:', 'product:batch:')}:${slug(roll.pieceId)}`,
          batchId,
          // Identical to the template SaleTerminal freezes into a real sale —
          // the lot has to be in the description or this history can never be
          // told which lot it consumed (sale documents are immutable).
          description: `${l.color} · NM ${l.nm} · ${l.fabricType} · ${roll.pieceId} · ${fmtLot(roll.lot)}`,
          quantity: l.qty, unitOfMeasure: 'Kg',
          unitPriceAtSale: l.price, lineSubtotalUsd: round2(l.qty * l.price),
        });
      } else {
        lines.push({
          productId: `${batchId.replace('batch:', 'product:batch:')}:stock`,
          batchId,
          description: `${l.color} · NM ${l.nm} · ${l.fabricType}`,
          quantity: l.qty, unitOfMeasure: 'Units',
          unitPriceAtSale: l.price, lineSubtotalUsd: round2(l.qty * l.price),
        });
      }
    }
    if (!ok) { failed++; console.log(`   ! ${s.ref} ${s.client}: no roll large enough`); continue; }

    try {
      await checkout(db, {
        transactionId: s.ref,
        createdAt: saleTimestamp(s.date, idx),
        clientId: clientIdByName.get(s.client) ?? null,
        // The INFORME is the daily book and carries no factura or IVA column,
        // so these are recorded off the books rather than invented as invoiced.
        isOnTheBooks: false,
        exchangeRateBCV: s.rate,
        creditTerms: /pago al retirar/i.test(s.obs) ? 'Pago al retirar' : null,
        operatorId: 'importacion',
        lines,
        payments: {
          paidUsdCash: round2(s.paidUsdCash),
          paidUsdTransfer: round2(s.paidUsdTransfer),
          paidBs: round2(s.paidBs),
        },
      });
      done++;
    } catch (err) {
      failed++;
      console.log(`   ! ${s.ref} ${s.client}: ${(err as Error).message}`);
    }
  }
  console.log(`\r   ${done} sales written, ${failed} failed`);

  if (!remote) {
    await verify(db, informe);
    return;
  }

  // --- push --------------------------------------------------------------
  // Everything below is the only part that touches the server.
  console.log('\n5. pushing to the server');
  if (flag('wipe')) {
    process.stdout.write('   wiping business documents… ');
    await wipe(remote);
  }

  const local = await db.allDocs({ include_docs: true });
  // Strip _rev: these are fresh creations on the server. A create with no _rev
  // supersedes the tombstone left by the wipe, which a replicated rev-1 document
  // would NOT — the tombstone sits at a higher generation and would stay winner.
  const payload = local.rows
    .map((r) => r.doc as Record<string, unknown>)
    .filter(Boolean)
    .filter((d) => !String(d._id).startsWith('_'))
    .map(({ _rev, ...doc }) => doc);

  const CHUNK = 200;
  let pushed = 0, errors = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const res = await remote.bulkDocs(slice as never[]);
    const bad = res.filter((r) => 'error' in r);
    errors += bad.length;
    pushed += slice.length - bad.length;
    process.stdout.write(`\r   ${pushed}/${payload.length} documents`);
    if (bad.length) console.log('\n   ', JSON.stringify(bad.slice(0, 3)));
  }
  console.log(`\n   pushed ${pushed}, ${errors} errors`);

  await verify(remote, informe);
}

/**
 * Read back what was written and reconcile it against the spreadsheet. An
 * import that "ran without errors" but landed the wrong money is the failure
 * mode worth catching, so this compares totals rather than counting documents.
 */
async function verify(db: PouchDB.Database, informe: Informe): Promise<void> {
  console.log('\n5. verification');
  const all = await db.allDocs({ include_docs: true });
  const docs = all.rows.map((r) => r.doc as Record<string, unknown>).filter(Boolean);
  const byType = (t: string) => docs.filter((d) => (d as { type?: string }).type === t);

  const sales = byType('sale') as unknown as {
    totalUsd: number; paymentStatus: string; lineItems: unknown[]; clientId: string | null;
  }[];
  const expectedTotal = round2(
    informe.sales.reduce((s, x) => s + x.lines.reduce((t, l) => t + l.qty * l.price, 0), 0),
  );
  const gotTotal = round2(sales.reduce((s, x) => s + x.totalUsd, 0));
  const expectedLines = informe.sales.reduce((s, x) => s + x.lines.length, 0);
  const gotLines = sales.reduce((s, x) => s + x.lineItems.length, 0);

  const products = byType('product') as unknown as { currentWeightKg: number }[];
  const batches = byType('batch') as unknown as { currentUnits: number; productType: string }[];
  const stockKg = round2(products.reduce((s, p) => s + (p.currentWeightKg || 0), 0));
  const stockUnits = batches.filter((b) => b.productType !== 'ROLL')
    .reduce((s, b) => s + b.currentUnits, 0);

  const status = (s: string) => sales.filter((x) => x.paymentStatus === s).length;
  const check = (label: string, ok: boolean, detail: string) =>
    console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);

  check('sales written', sales.length === informe.sales.length, `${sales.length}/${informe.sales.length}`);
  check('line items', gotLines === expectedLines, `${gotLines}/${expectedLines}`);
  check('money matches the spreadsheet', Math.abs(gotTotal - expectedTotal) < 0.5,
    `$${gotTotal.toLocaleString()} vs $${expectedTotal.toLocaleString()}`);
  // A paid walk-in legitimately has no client ("Contado"); an unpaid one must
  // have a debtor — that is the guard checkout enforces, so assert THAT.
  const creditNoClient = sales.filter((s) => s.paymentStatus !== 'PAID' && !s.clientId);
  check('every credit sale has a debtor', creditNoClient.length === 0, `${creditNoClient.length} unpaid without client`);
  check('stock remains after the week', stockKg > 0 && stockUnits > 0,
    `${stockKg.toLocaleString()} kg · ${stockUnits.toLocaleString()} ud`);
  const rates = byType('rate').length;
  console.log(`   ${rates > 0 ? '✓' : '·'} BCV rate history: ${rates} rate docs${rates ? ' preserved' : ' (none — empty target)'}`);

  const walkIns = sales.filter((s) => !s.clientId).length;
  console.log(`   clients ${byType('client').length} · batches ${batches.length} · products ${products.length} · movements ${byType('movement').length} · walk-ins ${walkIns}`);
  console.log(`   cobros: PAID ${status('PAID')} · PARTIAL ${status('PARTIAL')} · PENDING ${status('PENDING')}`);
  const info = await db.info();
  console.log(`   ${info.doc_count} documents total`);
}

/** Mirrors norm() in types.ts for building the ids checkout expects. */
function slug(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[:/]/g, '-').replace(/\s+/g, '-');
}

main().catch((err) => { console.error(err); process.exit(1); });
