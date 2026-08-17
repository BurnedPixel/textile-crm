// Checkout — the money path. Direct stock deduction (v1, no ticket workflow).
// Takes `db` as first arg; NEVER reads SystemConfig (exchangeRateBCV is a parameter —
// immutability by design, grep-enforced). ONE bulkDocs writes everything atomically.

import {
  saleIdOf,
  movementIdOf,
  assertAmount,
  hasRollStock,
  UNIT_FOR,
  type BatchDoc,
  type ProductDoc,
  type SaleDoc,
  type InventoryMovementDoc,
  type MovementLineItem,
  type CartLineItem,
} from './types';
import { round2 } from './format';
import { computePaymentStatus, saleTaxes, uuidv4, IVA_RATE, IGTF_RATE } from './queries';
import { writeWithCounters, type CounterWrite } from './inventory';
import { recomputeBatchCounters } from './conflicts';

type DB = PouchDB.Database;

export interface CheckoutInput {
  transactionId: string;
  createdAt: string; // ISO — part of the sale _id (idempotency + time ordering).
  clientId: string | null;
  isOnTheBooks: boolean;
  exchangeRateBCV: number;
  creditTerms: string | null;
  operatorId: string;
  lines: CartLineItem[];
  payments: { paidUsdCash: number; paidUsdTransfer: number; paidBs: number };
}

export async function checkout(db: DB, input: CheckoutInput): Promise<SaleDoc> {
  const saleId = saleIdOf(input.createdAt, input.transactionId);

  // --- Idempotency: same transactionId+createdAt → return the existing sale, no re-deduction. ---
  const existing = await getExisting(db, saleId);
  if (existing) return existing;

  // --- Validate (Spanish errors). ---
  assertAmount(input.exchangeRateBCV, 'La tasa de cambio');
  if (!input.lines?.length) throw new Error('El carrito está vacío.');
  for (const payment of [input.payments.paidUsdCash, input.payments.paidUsdTransfer, input.payments.paidBs]) {
    assertAmount(payment, 'El monto pagado', { allowZero: true });
  }

  return attemptCheckout(db, input, saleId);
}

async function getExisting(db: DB, saleId: string): Promise<SaleDoc | null> {
  try {
    return (await db.get(saleId)) as SaleDoc;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}

async function attemptCheckout(
  db: DB,
  input: CheckoutInput,
  saleId: string,
): Promise<SaleDoc> {
  // Load fresh batch + product docs referenced by the cart.
  const batchIds = [...new Set(input.lines.map((l) => l.batchId))];
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const [batches, products] = await Promise.all([
    fetchMap<BatchDoc>(db, batchIds),
    fetchMap<ProductDoc>(db, productIds),
  ]);

  // Staged deltas, NOT absolute counter values: what this sale takes off each
  // roll / batch. The docs are built from them later, against whichever rev the
  // write actually lands on.
  const rollDeductKg = new Map<string, number>();
  const rollBatchOf = new Map<string, string>();
  const unitDeductByBatch = new Map<string, number>();
  const movementLines: MovementLineItem[] = [];
  const saleLines: CartLineItem[] = [];
  let totalUsd = 0;

  for (const line of input.lines) {
    const batch = batches.get(line.batchId);
    if (!batch) throw new Error(`Artículo no encontrado: ${line.batchId}`);

    // Finite as well as positive: parseFloat('1e999') is Infinity, passes `> 0`,
    // and would be frozen into an immutable sale total that nothing can correct.
    assertAmount(line.quantity, `La cantidad de ${line.description}`);
    // The price is allowed to be zero at this boundary (the terminal requires
    // > 0; a policy-free companion line in a later phase would not) but never
    // negative and never non-finite — either poisons the total silently.
    assertAmount(line.unitPriceAtSale, `El precio de ${line.description}`, { allowZero: true });

    // Check unit-of-measure BEFORE the product lookup: a Units line on a ROLL
    // batch points at a non-existent pool product, and "wrong unit" is the real error.
    const expectedUnit = UNIT_FOR[batch.productType];
    if (line.unitOfMeasure !== expectedUnit) {
      throw new Error(
        `Unidad incorrecta para ${line.description}: se esperaba ${expectedUnit}.`,
      );
    }

    const product = products.get(line.productId);
    if (!product) throw new Error(`Producto no encontrado: ${line.productId}`);

    if (batch.productType === 'ROLL') {
      // ROLL: deduct Kg from the specific roll's currentWeightKg.
      const staged = rollDeductKg.get(product._id) ?? 0;
      const available = round2(product.currentWeightKg - staged);
      if (available < line.quantity) {
        throw new Error(`Stock insuficiente en ${line.description}: quedan ${available} kg.`);
      }
      rollDeductKg.set(product._id, round2(staged + line.quantity));
      rollBatchOf.set(product._id, batch._id);
    } else {
      // COMBO/PIECE: deduct whole units from batch.currentUnits (single pool product).
      // Units are countable: half a combo cannot be sold, and a fractional
      // quantity would freeze onto the immutable sale AND the ledger as a
      // -2.5 Units movement, mixing the two units of measure permanently.
      if (!Number.isInteger(line.quantity)) {
        throw new Error('Las unidades deben ser un número entero.');
      }
      const staged = unitDeductByBatch.get(batch._id) ?? 0;
      const available = batch.currentUnits - staged;
      if (available < line.quantity) {
        throw new Error(`Stock insuficiente en ${line.description}: quedan ${available} ud.`);
      }
      unitDeductByBatch.set(batch._id, staged + line.quantity);
    }

    // Recompute money — trust nothing the cart sent.
    const lineSubtotalUsd = round2(line.quantity * line.unitPriceAtSale);
    totalUsd = round2(totalUsd + lineSubtotalUsd);

    saleLines.push({ ...line, lineSubtotalUsd });
    movementLines.push({
      productId: line.productId,
      quantityChanged: -line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      conditionTag: product.conditionTag,
    });
  }

  const { paidUsdCash, paidUsdTransfer, paidBs } = input.payments;

  // «En libros» and «con factura» are the same thing (client, casilla 12), so
  // one flag carries both taxes. The RATES are stored and the amounts derived —
  // storing ivaUsd/igtfUsd would be a derived field on an immutable document,
  // which both validation layers exist to reject.
  const ivaRate = input.isOnTheBooks ? IVA_RATE : 0;
  const igtfRate = input.isOnTheBooks ? IGTF_RATE : 0;
  // Status is decided against what the client actually owes, tax included.
  // Against the pre-tax figure, a payment covering the net but not the IVA
  // freezes as PAID and the tax portion never appears in receivables anywhere.
  const { grandTotalUsd } = saleTaxes({
    totalUsd, ivaRate, igtfRate, paidUsdCash, paidUsdTransfer,
  });
  const paymentStatus = computePaymentStatus(
    grandTotalUsd,
    paidUsdCash,
    paidUsdTransfer,
    paidBs,
    input.exchangeRateBCV,
  );

  if (paymentStatus !== 'PAID' && !input.clientId) {
    throw new Error('Las ventas a crédito requieren un cliente seleccionado.');
  }

  const sale: SaleDoc = {
    _id: saleId,
    type: 'sale',
    transactionId: input.transactionId,
    clientId: input.clientId,
    date: input.createdAt,
    isOnTheBooks: input.isOnTheBooks,
    exchangeRateBCV: input.exchangeRateBCV,
    totalUsd,
    paidUsdCash,
    paidUsdTransfer,
    paidBs,
    paymentStatus,
    creditTerms: input.creditTerms,
    lineItems: saleLines,
    ivaRate,
    igtfRate,
  };

  const movement: InventoryMovementDoc = {
    _id: movementIdOf(input.createdAt, uuidv4()),
    type: 'movement',
    movementId: `${input.transactionId}:out`,
    date: input.createdAt,
    movementType: 'OUT',
    referenceId: input.transactionId,
    reason: 'Venta',
    operatorId: input.operatorId,
    lineItems: movementLines,
  };

  // ONE bulkDocs — sale + movement + touched counters. bulkDocs is per-document
  // and NOT transactional: the sale and the movement have unique ids and always
  // land, while a counter can 409 against a concurrent write. That loser used to
  // be dropped forever (the retry re-found the sale it had just written and
  // returned it), with no conflicting rev left for the watcher to heal — so the
  // deduction is re-applied here, on a FRESH read, delta by delta.
  const emptiedRolls = new Map<string, boolean>();
  const counters: CounterWrite[] = [];

  for (const [productId, deductKg] of rollDeductKg) {
    counters.push({
      id: productId,
      initial: products.get(productId) ?? null,
      build: (fresh) => {
        const cur = (fresh as ProductDoc | null) ?? products.get(productId)!;
        const next = Math.max(0, round2(cur.currentWeightKg - deductKg)); // clamp float dust
        // The empty transition is read off the SAME rev this write lands on.
        // Deciding it once, from the first read, is how a stale transition ends
        // up on the batch counter after a rebuild.
        emptiedRolls.set(productId, hasRollStock(cur.currentWeightKg) && !hasRollStock(next));
        return { ...cur, currentWeightKg: next };
      },
    });
  }

  for (const batchId of batchIds) {
    const rollIds = [...rollBatchOf].filter(([, id]) => id === batchId).map(([pid]) => pid);
    let applied = 0;
    let target = 0;
    counters.push({
      id: batchId,
      initial: batches.get(batchId) ?? null,
      dependsOn: rollIds,
      build: (fresh) => {
        const cur = (fresh as BatchDoc | null) ?? batches.get(batchId)!;
        // Units sold outright, plus one per roll this sale actually emptied.
        target =
          (unitDeductByBatch.get(batchId) ?? 0) +
          rollIds.filter((id) => emptiedRolls.get(id)).length;
        const outstanding = target - applied;
        return outstanding
          ? { ...cur, currentUnits: Math.max(0, cur.currentUnits - outstanding) }
          : null;
      },
      landed: () => {
        applied = target;
      },
    });
  }

  const unresolved = await writeWithCounters(db, [sale, movement], counters);
  if (unresolved.length) {
    // The sale and its movement ARE committed, so the ledger already holds the
    // truth and only the cache is stale — and re-running checkout would
    // short-circuit on transactionId without deducting anything. Rebuild the
    // cache from the ledger instead of throwing an error nobody can act on.
    console.warn(`[checkout] counters not applied: ${unresolved.join(', ')}`);
    for (const batchId of batchIds) {
      await recomputeBatchCounters(db, batchId).catch(() => undefined);
    }
  }

  return sale;
}

async function fetchMap<T extends { _id: string }>(db: DB, ids: string[]): Promise<Map<string, T>> {
  if (!ids.length) return new Map();
  const res = await db.allDocs<T>({ keys: ids, include_docs: true });
  const map = new Map<string, T>();
  for (const row of res.rows) {
    const doc = (row as { doc?: T }).doc;
    if (doc) map.set(doc._id, doc);
  }
  return map;
}
