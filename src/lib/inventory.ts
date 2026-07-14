// Inventory ingress + adjustment. Takes `db` first; no browser imports.
// Every stock change produces an InventoryMovement (mandatory audit ledger,
// CLAUDE.md). Batch _id is deterministic (batchIdOf) so two offline operators
// receiving the same color+nm+fabricType converge on one doc instead of duplicating.

import {
  batchIdOf,
  productIdOf,
  movementIdOf,
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
  operatorId: string;
  reason?: string;
  // ROLL: one entry per physical roll.
  rolls?: RollIngress[];
  // COMBO/PIECE: a unit count plus pool pricing.
  units?: number;
  unitPurchaseValueUsd?: number;
  unitSalePriceUsd?: number;
  unitConditionTag?: ConditionTag;
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
  const now = new Date().toISOString();
  const unitOfMeasure = UNIT_FOR[input.productType];
  const batchId = batchIdOf(input.color, input.nm, input.fabricType);

  const existingBatch = await getById<BatchDoc>(db, batchId);
  if (existingBatch && existingBatch.productType !== input.productType) {
    throw new Error(
      `El lote ya existe como ${existingBatch.productType}; no se puede mezclar con ${input.productType}.`,
    );
  }

  const counters: CounterWrite[] = [];
  const movementLines: MovementLineItem[] = [];
  let addedUnits = 0;

  if (isRoll) {
    if (!input.rolls?.length) throw new Error('Debe indicar al menos un rollo.');
    for (const roll of input.rolls) {
      if (!(roll.weightKg > 0)) throw new Error('El peso del rollo debe ser mayor que cero.');
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
        };
      };
      counters.push({ id: productId, doc: buildRoll(existing), rebuild: buildRoll });
      // A newly-created roll adds 1 to the batch's roll count; refilling an
      // existing roll doc does not (it was already counted).
      if (!existing) addedUnits += 1;
      movementLines.push({
        productId,
        quantityChanged: roll.weightKg,
        unitOfMeasure,
        conditionTag,
      });
    }
  } else {
    // COMBO/PIECE — single pool product, quantity tracked on batch.currentUnits.
    if (!(input.units && input.units > 0)) throw new Error('Las unidades deben ser mayores que cero.');
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
      };
    };
    counters.push({ id: productId, doc: buildPool(existing), rebuild: buildPool });
    addedUnits = input.units;
    movementLines.push({
      productId,
      quantityChanged: input.units,
      unitOfMeasure,
      conditionTag,
    });
  }

  // Batch counter: adds `addedUnits` on top of the current count (delta re-applies
  // cleanly on a fresh rev). location/productType are set once, not accumulated.
  const buildBatch = (cur: CounterDoc | null): BatchDoc => {
    const c = cur as BatchDoc | null;
    return {
      _id: batchId,
      ...(c?._rev ? { _rev: c._rev } : {}),
      type: 'batch',
      color: input.color.trim(),
      nm: input.nm.trim(),
      fabricType: input.fabricType.trim(),
      productType: input.productType,
      initialUnitCount: (c?.initialUnitCount ?? 0) + addedUnits,
      currentUnits: (c?.currentUnits ?? 0) + addedUnits,
      location: input.location ?? c?.location ?? '',
      createdAt: c?.createdAt ?? now,
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
  if (!input.quantityChanged) throw new Error('El ajuste no puede ser cero.');
  const batch = await getById<BatchDoc>(db, input.batchId);
  if (!batch) throw new Error(`Lote no encontrado: ${input.batchId}`);
  const product = await getById<ProductDoc>(db, input.productId);
  if (!product) throw new Error(`Producto no encontrado: ${input.productId}`);

  const now = new Date().toISOString();
  const unitOfMeasure = UNIT_FOR[batch.productType];
  const conditionTag = input.conditionTag ?? product.conditionTag;

  // The one touched counter: product weight for ROLL, batch units otherwise. The
  // builder re-applies the delta (and its non-negative guard) onto a fresh rev.
  let counter: CounterWrite;
  if (batch.productType === 'ROLL') {
    const buildProduct = (cur: CounterDoc | null): ProductDoc => {
      const c = (cur as ProductDoc | null) ?? product;
      const next = round2(c.currentWeightKg + input.quantityChanged);
      if (next < 0) throw new Error('El ajuste dejaría el peso en negativo.');
      return { ...c, currentWeightKg: next };
    };
    counter = { id: input.productId, doc: buildProduct(product), rebuild: buildProduct };
  } else {
    const buildBatch = (cur: CounterDoc | null): BatchDoc => {
      const c = (cur as BatchDoc | null) ?? batch;
      const next = c.currentUnits + input.quantityChanged;
      if (next < 0) throw new Error('El ajuste dejaría las unidades en negativo.');
      return { ...c, currentUnits: next };
    };
    counter = { id: input.batchId, doc: buildBatch(batch), rebuild: buildBatch };
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

  await writeMovementAndCounters(db, movement, [counter]);
  return movement;
}
