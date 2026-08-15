// Inventory ingress + adjustment. Takes `db` first; no browser imports.
// Every stock change produces an InventoryMovement (mandatory audit ledger,
// CLAUDE.md). Batch _id is deterministic (batchIdOf) so two offline operators
// receiving the same color+nm+fabricType converge on one doc instead of duplicating.

import {
  batchIdOf,
  productIdOf,
  movementIdOf,
  assertAmount,
  hasRollStock,
  FIELD_MAX,
  UNIT_FOR,
  type ProductType,
  type ConditionTag,
  type BatchDoc,
  type ProductDoc,
  type InventoryMovementDoc,
  type MovementLineItem,
} from './types';
import { round2 } from './format';
import { uuidv4 } from './queries';

type DB = PouchDB.Database;

// The single pool product id suffix for COMBO/PIECE batches (quantity lives on the batch).
const POOL_PIECE_ID = 'stock';

export interface RollIngress {
  pieceId: string;
  weightKg: number;
  purchaseValueUsd: number;
  salePriceUsd: number;
  conditionTag?: ConditionTag;
}

export interface IngressInput {
  color: string;
  nm: string;
  fabricType: string;
  productType: ProductType;
  location?: string;
  /** Batch-level colour-chart code. Blank on a top-up keeps whatever the batch has. */
  colorCode?: string;
  operatorId: string;
  reason?: string;
  // Applies to every product of THIS submission (one lot arrives at a time).
  lotNumber?: string;
  pantone?: string;
  fiberComposition?: string;
  // ROLL: one entry per physical roll.
  rolls?: RollIngress[];
  // COMBO/PIECE: a unit count plus pool pricing.
  units?: number;
  unitPurchaseValueUsd?: number;
  unitSalePriceUsd?: number;
  unitConditionTag?: ConditionTag;
}

type ProductMeta = Partial<Pick<ProductDoc, 'lotNumber' | 'pantone' | 'fiberComposition'>>;

/**
 * Optional per-submission metadata. A new non-empty value wins; otherwise the value
 * already on the doc is carried forward. Both product builders below rebuild the doc
 * from an explicit field list with no spread, so a field NOT named here is erased by
 * the next ingress onto the same roll.
 */
function carriedMeta(input: IngressInput, cur: ProductDoc | null): ProductMeta {
  const meta: ProductMeta = {};
  for (const key of ['lotNumber', 'pantone', 'fiberComposition'] as const) {
    const value = input[key]?.trim() || cur?.[key];
    if (value) meta[key] = value;
  }
  return meta;
}

async function getById<T>(db: DB, id: string): Promise<T | null> {
  try {
    return (await db.get(id)) as T;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}

type CounterDoc = BatchDoc | ProductDoc;

// A counter mutation: its id, the doc built from the initial read, and a pure
// `rebuild` that re-applies the same delta onto a freshly-read rev. On a 409
// (concurrent local write to the same counter) rebuild lands the delta on top
// instead of dropping it.
type CounterWrite = { id: string; doc: CounterDoc; rebuild: (fresh: CounterDoc | null) => CounterDoc };

/**
 * Write a movement + its counter mutations in ONE bulkDocs. Movements have unique
 * ids and never conflict; only the cached counters do. On a 409 we re-read the
 * conflicted counters, re-apply their deltas with fresh revs, and retry once —
 * so a concurrent tab can't silently drop a counter update (checkout.ts does the
 * same). The already-succeeded movement is NOT re-written (that would double the ledger).
 */
async function writeMovementAndCounters(
  db: DB,
  movement: InventoryMovementDoc,
  counters: CounterWrite[],
): Promise<void> {
  const results = await db.bulkDocs([movement, ...counters.map((c) => c.doc)]);
  const conflicted = counters.filter((_, i) => {
    const r = results[i + 1]; // +1: movement is index 0
    return 'error' in r && (r as PouchDB.Core.Error).status === 409;
  });
  if (conflicted.length === 0) return;

  const retry = await Promise.all(
    conflicted.map(async (c) => c.rebuild(await getById<CounterDoc>(db, c.id))),
  );
  const retryResults = await db.bulkDocs(retry);
  if (retryResults.some((r) => 'error' in r && (r as PouchDB.Core.Error).status === 409)) {
    throw new Error('Conflicto de inventario persistente. Reintente la operación.');
  }
}

/**
 * Receive stock. Creates the batch if missing, else bumps its counters. Writes
 * batch + product(s) + IN movement in ONE bulkDocs.
 */
export async function ingressStock(db: DB, input: IngressInput): Promise<InventoryMovementDoc> {
  const isRoll = input.productType === 'ROLL';
  // color/nm/fabricType become the batch _id — an unbounded value there is an
  // unbounded document key, so they are capped before anything else happens.
  for (const [label, value] of [
    ['El color', input.color],
    ['El NM', input.nm],
    ['El tipo de tela', input.fabricType],
  ] as const) {
    if (!value?.trim()) throw new Error(`${label} es obligatorio.`);
    if (value.length > FIELD_MAX.text) {
      throw new Error(`${label} no puede superar ${FIELD_MAX.text} caracteres.`);
    }
  }
  for (const [label, value] of [
    ['El nº de lote', input.lotNumber],
    ['El pantone', input.pantone],
    ['La composición', input.fiberComposition],
    ['La ubicación', input.location],
  ] as const) {
    if (value && value.length > FIELD_MAX.text) {
      throw new Error(`${label} no puede superar ${FIELD_MAX.text} caracteres.`);
    }
  }
  if (input.colorCode && input.colorCode.trim().length > FIELD_MAX.colorCode) {
    throw new Error(`El código de color no puede superar ${FIELD_MAX.colorCode} caracteres.`);
  }
  const now = new Date().toISOString();
  const unitOfMeasure = UNIT_FOR[input.productType];
  const batchId = batchIdOf(input.color, input.nm, input.fabricType);

  const existingBatch = await getById<BatchDoc>(db, batchId);
  if (existingBatch && existingBatch.productType !== input.productType) {
    throw new Error(
      `El artículo ya existe como ${existingBatch.productType}; no se puede mezclar con ${input.productType}.`,
    );
  }

  const counters: CounterWrite[] = [];
  const movementLines: MovementLineItem[] = [];
  // Two different tallies that used to share one variable:
  //   addedUnits      → currentUnits, the CACHE of "rolls with stock right now".
  //   createdProducts → initialUnitCount, "rolls ever received", monotonic.
  // They diverge the moment a sold-out roll is refilled: the roll doc already
  // exists (so nothing is "created") but checkout decremented currentUnits when
  // it hit empty, so the batch is one short until this ingress puts it back.
  let addedUnits = 0;
  let createdProducts = 0;

  if (isRoll) {
    if (!input.rolls?.length) throw new Error('Debe indicar al menos un rollo.');
    // Weight this call has already staged per roll, so two rows carrying the SAME
    // pieceId count one transition between them instead of one each (their writes
    // collide on the same _id and the loser re-applies its delta on a fresh rev).
    const stagedWeight = new Map<string, number>();
    for (const roll of input.rolls) {
      // Finite, not just positive — an Infinity weight would be added into a
      // cached counter AND an append-only movement, with no way to take it back.
      assertAmount(roll.weightKg, 'El peso del rollo');
      assertAmount(roll.purchaseValueUsd, 'El costo del rollo', { allowZero: true });
      assertAmount(roll.salePriceUsd, 'El precio del rollo', { allowZero: true });
      const productId = productIdOf(batchId, roll.pieceId);
      const existing = await getById<ProductDoc>(db, productId);
      const conditionTag = roll.conditionTag ?? existing?.conditionTag ?? 'FIRST';
      // Pure builder: adds this roll's weight ON TOP of whatever the current doc
      // holds, so re-running it against a fresh rev re-applies the same delta.
      const buildRoll = (cur: CounterDoc | null): ProductDoc => {
        const c = cur as ProductDoc | null;
        return {
          _id: productId,
          ...(c?._rev ? { _rev: c._rev } : {}),
          type: 'product',
          batchId,
          pieceId: roll.pieceId,
          initialWeightKg: c?.initialWeightKg ?? round2(roll.weightKg),
          currentWeightKg: round2((c?.currentWeightKg ?? 0) + roll.weightKg),
          purchaseValueUsd: round2(roll.purchaseValueUsd),
          salePriceUsd: round2(roll.salePriceUsd),
          conditionTag,
          createdAt: c?.createdAt ?? now,
          ...carriedMeta(input, c),
        };
      };
      counters.push({ id: productId, doc: buildRoll(existing), rebuild: buildRoll });
      // The batch's roll count is "rolls holding stock", so it moves on an
      // empty→non-empty TRANSITION — not on "the document did not exist".
      // Refilling a sold-out roll creates no document but does put a roll back
      // on the shelf; topping up a roll that still has fabric on it does neither.
      const prevWeight = stagedWeight.get(productId) ?? existing?.currentWeightKg ?? 0;
      const nextWeight = round2(prevWeight + roll.weightKg);
      if (!hasRollStock(prevWeight) && hasRollStock(nextWeight)) addedUnits += 1;
      if (!existing && !stagedWeight.has(productId)) createdProducts += 1;
      stagedWeight.set(productId, nextWeight);
      movementLines.push({
        productId,
        quantityChanged: roll.weightKg,
        unitOfMeasure,
        conditionTag,
      });
    }
  } else {
    // COMBO/PIECE — single pool product, quantity tracked on batch.currentUnits.
    const units = input.units ?? 0;
    assertAmount(units, 'Las unidades');
    if (!Number.isInteger(units)) throw new Error('Las unidades deben ser un número entero.');
    assertAmount(input.unitPurchaseValueUsd ?? 0, 'El costo unitario', { allowZero: true });
    assertAmount(input.unitSalePriceUsd ?? 0, 'El precio unitario', { allowZero: true });
    const productId = productIdOf(batchId, POOL_PIECE_ID);
    const existing = await getById<ProductDoc>(db, productId);
    const conditionTag = input.unitConditionTag ?? existing?.conditionTag ?? 'FIRST';
    const buildPool = (cur: CounterDoc | null): ProductDoc => {
      const c = cur as ProductDoc | null;
      return {
        _id: productId,
        ...(c?._rev ? { _rev: c._rev } : {}),
        type: 'product',
        batchId,
        pieceId: POOL_PIECE_ID,
        initialWeightKg: 0,
        currentWeightKg: 0,
        purchaseValueUsd: round2(input.unitPurchaseValueUsd ?? c?.purchaseValueUsd ?? 0),
        salePriceUsd: round2(input.unitSalePriceUsd ?? c?.salePriceUsd ?? 0),
        conditionTag,
        createdAt: c?.createdAt ?? now,
        ...carriedMeta(input, c),
      };
    };
    counters.push({ id: productId, doc: buildPool(existing), rebuild: buildPool });
    addedUnits = units;
    createdProducts = units; // COMBO/PIECE: the counter IS the unit count
    movementLines.push({
      productId,
      quantityChanged: units,
      unitOfMeasure,
      conditionTag,
    });
  }

  // Batch counter: adds `addedUnits` on top of the current count (delta re-applies
  // cleanly on a fresh rev). location/productType are set once, not accumulated.
  const buildBatch = (cur: CounterDoc | null): BatchDoc => {
    const c = cur as BatchDoc | null;
    // Named on purpose: this builder rebuilds the doc from an explicit field
    // list with no spread, so a colour code not carried here is erased by the
    // next top-up (the carriedMeta rule, batch-level). Absent ≠ blank: a caller
    // that omits the field carries the stored code forward, while an explicit
    // empty string CLEARS it — otherwise a mistyped code could never be
    // removed, since another ingress is the only batch-level write path.
    const colorCode =
      input.colorCode === undefined ? c?.colorCode : input.colorCode.trim() || undefined;
    return {
      _id: batchId,
      ...(c?._rev ? { _rev: c._rev } : {}),
      type: 'batch',
      color: input.color.trim(),
      nm: input.nm.trim(),
      fabricType: input.fabricType.trim(),
      productType: input.productType,
      initialUnitCount: (c?.initialUnitCount ?? 0) + createdProducts,
      currentUnits: (c?.currentUnits ?? 0) + addedUnits,
      location: input.location ?? c?.location ?? '',
      createdAt: c?.createdAt ?? now,
      ...(colorCode ? { colorCode } : {}),
    };
  };
  counters.push({ id: batchId, doc: buildBatch(existingBatch), rebuild: buildBatch });

  const movement: InventoryMovementDoc = {
    _id: movementIdOf(now, uuidv4()),
    type: 'movement',
    movementId: `ingress:${batchId}:${now}`,
    date: now,
    movementType: 'IN',
    referenceId: batchId,
    reason: input.reason ?? 'Ingreso de inventario',
    operatorId: input.operatorId,
    lineItems: movementLines,
  };

  await writeMovementAndCounters(db, movement, counters);
  return movement;
}

// ---- Devoluciones (returns) and cambios por garantía (exchanges) ----

/** Movement reasons. One definition — the UI labels and the tests read these. */
export const RETURN_REASON = 'Devolución';
export const EXCHANGE_REASON = 'Cambio por garantía';

export interface ExchangeLeg {
  /** An existing roll with enough weight to cover the replacement. */
  productId: string;
  weightKg: number;
}

export interface ReturnInput {
  /**
   * One uuid per submission. It is BOTH the idempotency key (it seeds the
   * movement _id) and the returned roll's id suffix. A double tap on a flaky
   * connection therefore re-reads the same movement instead of crediting stock
   * twice — and two offline devices returning pieces of the same roll generate
   * different suffixes, so their documents never converge into one fat roll.
   */
  returnId: string;
  /** ISO. Part of the movement _id, so it must be stable across a retry. */
  date: string;
  /** The roll that was sold and is coming back. Must be an existing ROLL product. */
  productId: string;
  weightKg: number;
  /** Defaults to DEFECT ("Fallado") — it warns, it never blocks the resale. */
  conditionTag?: ConditionTag;
  operatorId: string;
  /** The original sale's transactionId when the operator has it. */
  referenceId?: string;
  /** The roll going back out, deducted inside the SAME movement. */
  replacement?: ExchangeLeg;
}

/**
 * The pieceId of a roll that came back: the original's, plus a `-D{tag}` marker
 * derived from the submission's uuid. NOT a sequential -D1/-D2 — a counter is
 * recomputed identically by every offline device, and two devices returning
 * different pieces of the same roll would then write the same _id and merge into
 * one document holding the sum of both weights.
 */
export function returnPieceId(originalPieceId: string, returnId: string): string {
  const tag = returnId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
  return `${originalPieceId}-D${tag}`;
}

/**
 * Record a client return, optionally exchanging it for another roll. Writes ONE
 * movement carrying both legs (returned +, replacement −) plus the touched
 * counters, in a single atomic bulkDocs.
 *
 * Two movements cannot express this: a same-batch exchange has both legs
 * touching the same batch document, and duplicate ids inside one bulk write are
 * rejected. MovementLineItem.quantityChanged is already signed, so one document
 * covers both directions.
 */
export async function returnStock(db: DB, input: ReturnInput): Promise<InventoryMovementDoc> {
  const movementId = movementIdOf(input.date, input.returnId);

  // Idempotency, exactly like checkout(): the same submission re-run returns the
  // movement already written, with no second credit to stock.
  const already = await getById<InventoryMovementDoc>(db, movementId);
  if (already) return already;

  assertAmount(input.weightKg, 'El peso devuelto');
  // Weights are stored rounded to the cent of a kilo, so anything under half a
  // gram lands as 0.000 kg: a roll document holding nothing, and the returned
  // fabric lost. Reject it rather than write a roll that is empty on arrival.
  if (!hasRollStock(round2(input.weightKg))) {
    throw new Error('El peso devuelto es demasiado pequeño para registrarse.');
  }

  const original = await getById<ProductDoc>(db, input.productId);
  if (!original) throw new Error(`Rollo no encontrado: ${input.productId}`);
  const batch = await getById<BatchDoc>(db, original.batchId);
  if (!batch) throw new Error(`Artículo no encontrado: ${original.batchId}`);
  if (batch.productType !== 'ROLL') {
    throw new Error('Solo se pueden devolver rollos; los combos y piezas se reingresan como stock.');
  }

  const now = input.date;
  const conditionTag = input.conditionTag ?? 'DEFECT';
  const counters: CounterWrite[] = [];
  // Per batch: the roll-count delta and the "rolls ever received" delta. Kept in
  // one map because an exchange inside a single batch must produce ONE counter
  // write holding the net of both legs.
  const batchDelta = new Map<string, { units: number; created: number }>();
  const bump = (batchId: string, units: number, created: number) => {
    const cur = batchDelta.get(batchId) ?? { units: 0, created: 0 };
    batchDelta.set(batchId, { units: cur.units + units, created: cur.created + created });
  };

  // --- Leg 1: the returned fabric comes back as its own roll. ---
  const newPieceId = returnPieceId(original.pieceId, input.returnId);
  const returnedId = productIdOf(batch._id, newPieceId);
  const existingReturn = await getById<ProductDoc>(db, returnedId);
  // Prices carry from the roll it came off. Writing 0 here (a "sin costo"
  // return) would zero the sale price of every kilo left on that roll.
  const buildReturned = (cur: CounterDoc | null): ProductDoc => {
    const c = cur as ProductDoc | null;
    return {
      _id: returnedId,
      ...(c?._rev ? { _rev: c._rev } : {}),
      type: 'product',
      batchId: batch._id,
      pieceId: newPieceId,
      initialWeightKg: c?.initialWeightKg ?? round2(input.weightKg),
      currentWeightKg: round2((c?.currentWeightKg ?? 0) + input.weightKg),
      purchaseValueUsd: original.purchaseValueUsd,
      salePriceUsd: original.salePriceUsd,
      conditionTag,
      createdAt: c?.createdAt ?? now,
      ...(original.lotNumber ? { lotNumber: original.lotNumber } : {}),
      ...(original.pantone ? { pantone: original.pantone } : {}),
      ...(original.fiberComposition ? { fiberComposition: original.fiberComposition } : {}),
    };
  };
  counters.push({ id: returnedId, doc: buildReturned(existingReturn), rebuild: buildReturned });
  // BOTH sides of the transition, exactly as ingressStock tests it. Checking
  // only "was it empty before" counts a roll onto the shelf that the recompute
  // from the ledger would not count — and the cache and the ledger then disagree
  // permanently, because nothing recomputes until a conflict happens to fire.
  const prevReturnKg = existingReturn?.currentWeightKg ?? 0;
  const nextReturnKg = round2(prevReturnKg + input.weightKg);
  if (!hasRollStock(prevReturnKg) && hasRollStock(nextReturnKg)) bump(batch._id, 1, 0);
  if (!existingReturn) bump(batch._id, 0, 1);

  const movementLines: MovementLineItem[] = [
    { productId: returnedId, quantityChanged: input.weightKg, unitOfMeasure: 'Kg', conditionTag },
  ];

  // --- Leg 2 (optional): the replacement roll goes out. ---
  let replacementProduct: ProductDoc | null = null;
  if (input.replacement) {
    assertAmount(input.replacement.weightKg, 'El peso del rollo de reposición');
    replacementProduct = await getById<ProductDoc>(db, input.replacement.productId);
    if (!replacementProduct) {
      throw new Error(`Rollo de reposición no encontrado: ${input.replacement.productId}`);
    }
    const replacementBatch =
      replacementProduct.batchId === batch._id
        ? batch
        : await getById<BatchDoc>(db, replacementProduct.batchId);
    if (!replacementBatch) {
      throw new Error(`Artículo no encontrado: ${replacementProduct.batchId}`);
    }
    if (replacementBatch.productType !== 'ROLL') {
      throw new Error('El rollo de reposición debe pertenecer a un artículo de rollos.');
    }
    if (replacementProduct.currentWeightKg < input.replacement.weightKg) {
      throw new Error(
        `Stock insuficiente en ${replacementProduct.pieceId}: quedan ${replacementProduct.currentWeightKg} kg.`,
      );
    }
    const takenKg = input.replacement.weightKg;
    const out = replacementProduct;
    const buildReplacement = (cur: CounterDoc | null): ProductDoc => {
      const c = (cur as ProductDoc | null) ?? out;
      const next = round2(c.currentWeightKg - takenKg);
      if (next < 0) throw new Error(`Stock insuficiente en ${c.pieceId}.`);
      return { ...c, currentWeightKg: next };
    };
    const reduced = buildReplacement(replacementProduct);
    counters.push({
      id: replacementProduct._id,
      doc: reduced,
      rebuild: buildReplacement,
    });
    // Emptying the replacement takes it off the batch's roll count — the same
    // rule checkout applies when a sale finishes a roll.
    if (hasRollStock(replacementProduct.currentWeightKg) && !hasRollStock(reduced.currentWeightKg)) {
      bump(replacementBatch._id, -1, 0);
    }
    movementLines.push({
      productId: replacementProduct._id,
      quantityChanged: -takenKg,
      unitOfMeasure: 'Kg',
      conditionTag: replacementProduct.conditionTag,
    });
  }

  // --- Batch counters: one write per batch, holding the net of both legs. ---
  for (const [batchId, delta] of batchDelta) {
    if (!delta.units && !delta.created) continue;
    const current = batchId === batch._id ? batch : await getById<BatchDoc>(db, batchId);
    if (!current) continue;
    const buildBatch = (cur: CounterDoc | null): BatchDoc => {
      const c = (cur as BatchDoc | null) ?? current;
      return {
        ...c,
        initialUnitCount: Math.max(0, c.initialUnitCount + delta.created),
        currentUnits: Math.max(0, c.currentUnits + delta.units),
      };
    };
    counters.push({ id: batchId, doc: buildBatch(current), rebuild: buildBatch });
  }

  const movement: InventoryMovementDoc = {
    _id: movementId,
    type: 'movement',
    movementId: `return:${returnedId}:${now}`,
    date: now,
    movementType: 'IN',
    referenceId: input.referenceId?.trim() || original._id,
    reason: input.replacement ? EXCHANGE_REASON : RETURN_REASON,
    operatorId: input.operatorId,
    lineItems: movementLines,
  };

  await writeMovementAndCounters(db, movement, counters);
  return movement;
}

// ---- What the ingress FORM refuses to submit ----
//
// These are per-field rules for what an operator may type today. They are NOT
// inside ingressStock, and that is deliberate: stock received before lot
// numbers existed, and every row of the INFORME import, legitimately have no
// lot. The document model has to keep representing them. What must not happen
// is a NEW arrival being registered without one — which is how four rolls ended
// up reading S/L on the shelf.
//
// ingressStock keeps its own hard guards (finite amounts, length caps, unit of
// measure); this adds "and none of it may be blank", with the message attached
// to the field that is wrong instead of a banner at the bottom of the page.

/** Per-field messages, keyed by the form field. Empty object = good to write. */
export interface IngressFormErrors {
  color?: string;
  nm?: string;
  fabricType?: string;
  colorCode?: string;
  lotNumber?: string;
  purchaseValueUsd?: string;
  salePriceUsd?: string;
  units?: string;
  unitPurchaseValueUsd?: string;
  unitSalePriceUsd?: string;
  /** Keyed by roll row index. */
  rollWeights?: Record<number, string>;
  /** Nothing worth registering at all. */
  rolls?: string;
}

export interface IngressFormValues {
  color: string;
  nm: string;
  fabricType: string;
  productType: ProductType;
  /** Optional — an article may have no chart code. */
  colorCode?: string;
  lotNumber: string;
  /** Batch-level defaults, used when a row leaves its own cost/price blank. */
  purchaseValueUsd: string;
  salePriceUsd: string;
  rolls: Array<{ weightKg: string; purchaseValueUsd: string; salePriceUsd: string }>;
  units: string;
  unitPurchaseValueUsd: string;
  unitSalePriceUsd: string;
}

/**
 * Strict numeric parse. `parseFloat` is not good enough here: it reads "12abc"
 * as 12 and "1e999" as Infinity, and either would sail through a bare `> 0`.
 */
function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const REQUIRED = 'Obligatorio.';
const NOT_A_NUMBER = 'Debe ser un número.';
const TOO_LONG = `No puede superar ${FIELD_MAX.text} caracteres.`;

export function validateIngressForm(v: IngressFormValues): IngressFormErrors {
  const errors: IngressFormErrors = {};

  for (const key of ['color', 'nm', 'fabricType', 'lotNumber'] as const) {
    const value = v[key].trim();
    if (!value) errors[key] = REQUIRED;
    else if (value.length > FIELD_MAX.text) errors[key] = TOO_LONG;
  }

  // Optional, but capped short — it is a chart code, not a description.
  if ((v.colorCode ?? '').trim().length > FIELD_MAX.colorCode) {
    errors.colorCode = `No puede superar ${FIELD_MAX.colorCode} caracteres.`;
  }

  if (v.productType === 'ROLL') {
    // The last row is usually the empty one the Enter key just created.
    const filled = v.rolls
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.weightKg.trim() !== '');

    if (filled.length === 0) {
      errors.rolls = 'Agrega al menos un rollo con peso.';
    }

    const rollWeights: Record<number, string> = {};
    for (const { row, index } of filled) {
      const weight = parseNumber(row.weightKg);
      if (weight === null) rollWeights[index] = NOT_A_NUMBER;
      else if (weight <= 0) rollWeights[index] = 'El peso debe ser mayor que cero.';
    }
    if (Object.keys(rollWeights).length) errors.rollWeights = rollWeights;

    // A row may leave cost/price blank and inherit the batch default — but then
    // the default itself has to be there.
    const defaultCost = parseNumber(v.purchaseValueUsd);
    const defaultPrice = parseNumber(v.salePriceUsd);
    for (const [field, fallback, raw] of [
      ['purchaseValueUsd', defaultCost, v.purchaseValueUsd],
      ['salePriceUsd', defaultPrice, v.salePriceUsd],
    ] as const) {
      const someRowInherits = filled.some(({ row }) => row[field].trim() === '');
      if (raw.trim() === '') {
        if (someRowInherits && filled.length) errors[field] = REQUIRED;
      } else if (fallback === null) errors[field] = NOT_A_NUMBER;
      else if (fallback < 0) errors[field] = 'No puede ser negativo.';
    }
  } else {
    const units = parseNumber(v.units);
    if (v.units.trim() === '') errors.units = REQUIRED;
    else if (units === null) errors.units = NOT_A_NUMBER;
    else if (units <= 0) errors.units = 'Debe ser mayor que cero.';
    else if (!Number.isInteger(units)) errors.units = 'Debe ser un número entero.';

    for (const field of ['unitPurchaseValueUsd', 'unitSalePriceUsd'] as const) {
      const raw = v[field];
      const value = parseNumber(raw);
      if (raw.trim() === '') errors[field] = REQUIRED;
      else if (value === null) errors[field] = NOT_A_NUMBER;
      else if (value < 0) errors[field] = 'No puede ser negativo.';
    }
  }

  return errors;
}

/** True when nothing is wrong — `Object.keys` on a nested record is easy to get wrong. */
export function ingressFormIsValid(errors: IngressFormErrors): boolean {
  return Object.keys(errors).length === 0;
}

// ---- Correcting a roll's details (never its weight) ----

export interface RollDetailsInput {
  productId: string;
  lotNumber?: string;
  pantone?: string;
  fiberComposition?: string;
  purchaseValueUsd?: number;
  salePriceUsd?: number;
  conditionTag?: ConditionTag;
}

/**
 * Correct what is written ON a roll — the lot number the operator mistyped, the
 * pantone nobody recorded, a price that changed. Only fields actually present in
 * the input are touched; `''` clears an optional one.
 *
 * Deliberately CANNOT change the weight. Stock moves only through the ledger
 * (`adjustStock`), which is what makes the cached counters recomputable — a
 * direct weight write here would be invisible to `recomputeBatchCounters` and
 * would be silently undone by the next conflict.
 *
 * This is also the one thing the lot number's design bought: it is a plain field
 * on the roll, not part of any _id, so correcting a typo is an ordinary write
 * with no migration and no dangling reference in the frozen sale history.
 */
export async function updateRollDetails(
  db: DB,
  input: RollDetailsInput,
): Promise<ProductDoc> {
  const product = await getById<ProductDoc>(db, input.productId);
  if (!product) throw new Error(`Rollo no encontrado: ${input.productId}`);

  for (const [label, value] of [
    ['El nº de lote', input.lotNumber],
    ['El pantone', input.pantone],
    ['La composición', input.fiberComposition],
  ] as const) {
    if (value && value.length > FIELD_MAX.text) {
      throw new Error(`${label} no puede superar ${FIELD_MAX.text} caracteres.`);
    }
  }
  if (input.purchaseValueUsd !== undefined) {
    assertAmount(input.purchaseValueUsd, 'El costo', { allowZero: true });
  }
  if (input.salePriceUsd !== undefined) {
    assertAmount(input.salePriceUsd, 'El precio de venta', { allowZero: true });
  }

  // Spread, not a rebuild: here the intent is to PRESERVE everything not named,
  // the opposite of the ingress builders.
  const next: ProductDoc = { ...product };
  for (const key of ['lotNumber', 'pantone', 'fiberComposition'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key]; // cleared — the roll goes back to reading "S/L"
  }
  if (input.purchaseValueUsd !== undefined) next.purchaseValueUsd = round2(input.purchaseValueUsd);
  if (input.salePriceUsd !== undefined) next.salePriceUsd = round2(input.salePriceUsd);
  if (input.conditionTag !== undefined) next.conditionTag = input.conditionTag;

  await db.put(next);
  return next;
}

export interface AdjustInput {
  batchId: string;
  productId: string;
  /** Signed delta: negative = shrink, positive = grow. */
  quantityChanged: number;
  operatorId: string;
  reason: string;
  conditionTag?: ConditionTag;
}

/**
 * Manual correction (loss, recount, damage). Writes an ADJUST movement + the
 * touched counter in ONE bulkDocs.
 */
export async function adjustStock(db: DB, input: AdjustInput): Promise<InventoryMovementDoc> {
  // Signed (a shrink is negative), so only the magnitude can be range-checked.
  if (!Number.isFinite(input.quantityChanged)) throw new Error('El ajuste no es un número válido.');
  if (!input.quantityChanged) throw new Error('El ajuste no puede ser cero.');
  if (Math.abs(input.quantityChanged) > 1e12) throw new Error('El ajuste es demasiado grande.');
  const batch = await getById<BatchDoc>(db, input.batchId);
  if (!batch) throw new Error(`Artículo no encontrado: ${input.batchId}`);
  const product = await getById<ProductDoc>(db, input.productId);
  if (!product) throw new Error(`Producto no encontrado: ${input.productId}`);

  const now = new Date().toISOString();
  const unitOfMeasure = UNIT_FOR[batch.productType];
  const conditionTag = input.conditionTag ?? product.conditionTag;

  // The touched counters: product weight for ROLL (plus the batch's roll count if
  // this adjustment empties or un-empties the roll), batch units otherwise. Each
  // builder re-applies its delta (and its non-negative guard) onto a fresh rev.
  const counters: CounterWrite[] = [];
  if (batch.productType === 'ROLL') {
    const buildProduct = (cur: CounterDoc | null): ProductDoc => {
      const c = (cur as ProductDoc | null) ?? product;
      const next = round2(c.currentWeightKg + input.quantityChanged);
      if (next < 0) throw new Error('El ajuste dejaría el peso en negativo.');
      return { ...c, currentWeightKg: next };
    };
    const adjusted = buildProduct(product); // also validates the non-negative rule
    counters.push({ id: input.productId, doc: adjusted, rebuild: buildProduct });

    // Same empty↔non-empty transition rule ingress and checkout use — an adjust
    // to zero, or off zero, otherwise leaves the batch's roll count permanently
    // wrong (this path never touched it at all before).
    const rollDelta =
      (hasRollStock(adjusted.currentWeightKg) ? 1 : 0) -
      (hasRollStock(product.currentWeightKg) ? 1 : 0);
    if (rollDelta !== 0) {
      const buildBatch = (cur: CounterDoc | null): BatchDoc => {
        const c = (cur as BatchDoc | null) ?? batch;
        return { ...c, currentUnits: Math.max(0, c.currentUnits + rollDelta) };
      };
      counters.push({ id: input.batchId, doc: buildBatch(batch), rebuild: buildBatch });
    }
  } else {
    const buildBatch = (cur: CounterDoc | null): BatchDoc => {
      const c = (cur as BatchDoc | null) ?? batch;
      const next = c.currentUnits + input.quantityChanged;
      if (next < 0) throw new Error('El ajuste dejaría las unidades en negativo.');
      return { ...c, currentUnits: next };
    };
    counters.push({ id: input.batchId, doc: buildBatch(batch), rebuild: buildBatch });
  }

  const movement: InventoryMovementDoc = {
    _id: movementIdOf(now, uuidv4()),
    type: 'movement',
    movementId: `adjust:${input.productId}:${now}`,
    date: now,
    movementType: 'ADJUST',
    referenceId: input.productId,
    reason: input.reason,
    operatorId: input.operatorId,
    lineItems: [
      {
        productId: input.productId,
        quantityChanged: input.quantityChanged,
        unitOfMeasure,
        conditionTag,
      },
    ],
  };

  await writeMovementAndCounters(db, movement, counters);
  return movement;
}
