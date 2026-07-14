// Checkout — the money path. Direct stock deduction (v1, no ticket workflow).
// Takes `db` as first arg; NEVER reads SystemConfig (exchangeRateBCV is a parameter —
// immutability by design, grep-enforced). ONE bulkDocs writes everything atomically.

import {
  saleIdOf,
  movementIdOf,
  UNIT_FOR,
  type BatchDoc,
  type ProductDoc,
  type SaleDoc,
  type InventoryMovementDoc,
  type MovementLineItem,
  type CartLineItem,
} from './types';
import { round2 } from './format';
import { computePaymentStatus, uuidv4 } from './queries';

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

// A roll whose remaining weight falls to/under this counts as consumed (decrements
// the batch's roll count). Guards float dust from repeated subtraction.
const ROLL_EMPTY_KG = 0.001;

export async function checkout(db: DB, input: CheckoutInput): Promise<SaleDoc> {
  const saleId = saleIdOf(input.createdAt, input.transactionId);

  // --- Idempotency: same transactionId+createdAt → return the existing sale, no re-deduction. ---
  const existing = await getExisting(db, saleId);
  if (existing) return existing;

  // --- Validate (Spanish errors). ---
  if (!(input.exchangeRateBCV > 0)) throw new Error('La tasa de cambio debe ser mayor que cero.');
  if (!input.lines?.length) throw new Error('El carrito está vacío.');

  return attemptCheckout(db, input, saleId, /*isRetry*/ false);
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
  isRetry: boolean,
): Promise<SaleDoc> {
  // Load fresh batch + product docs referenced by the cart.
  const batchIds = [...new Set(input.lines.map((l) => l.batchId))];
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const [batches, products] = await Promise.all([
    fetchMap<BatchDoc>(db, batchIds),
    fetchMap<ProductDoc>(db, productIds),
  ]);

  // Mutable working copies of counters (we only write the ones we touch).
  const touchedProducts = new Map<string, ProductDoc>();
  const touchedBatches = new Map<string, BatchDoc>();
  const movementLines: MovementLineItem[] = [];
  const saleLines: CartLineItem[] = [];
  let totalUsd = 0;

  for (const line of input.lines) {
    const batch = batches.get(line.batchId);
    if (!batch) throw new Error(`Lote no encontrado: ${line.batchId}`);

    if (!(line.quantity > 0)) throw new Error(`Cantidad inválida para ${line.description}.`);

    // Check unit-of-measure BEFORE the product lookup: a Units line on a ROLL
    // batch points at a non-existent pool product, and "wrong unit" is the real error.
    const expectedUnit = UNIT_FOR[batch.productType];
    if (line.unitOfMeasure !== expectedUnit) {
      throw new Error(
        `Unidad incorrecta para ${line.description}: se esperaba ${expectedUnit}.`,
      );
    }

    const product = touchedProducts.get(line.productId) ?? products.get(line.productId);
    if (!product) throw new Error(`Producto no encontrado: ${line.productId}`);

    if (batch.productType === 'ROLL') {
      // ROLL: deduct Kg from the specific roll's currentWeightKg.
      const roll = touchedProducts.get(product._id) ?? { ...product };
      if (roll.currentWeightKg < line.quantity) {
        throw new Error(
          `Stock insuficiente en ${line.description}: quedan ${roll.currentWeightKg} kg.`,
        );
      }
      roll.currentWeightKg = round2(roll.currentWeightKg - line.quantity);
      if (roll.currentWeightKg < 0) roll.currentWeightKg = 0; // clamp float dust
      touchedProducts.set(roll._id, roll);
      // A roll reaching empty removes one from the batch's roll count.
      if (roll.currentWeightKg <= ROLL_EMPTY_KG) {
        const b = touchedBatches.get(batch._id) ?? { ...batch };
        b.currentUnits = Math.max(0, b.currentUnits - 1);
        touchedBatches.set(b._id, b);
      }
    } else {
      // COMBO/PIECE: deduct whole units from batch.currentUnits (single pool product).
      const b = touchedBatches.get(batch._id) ?? { ...batch };
      if (b.currentUnits < line.quantity) {
        throw new Error(
          `Stock insuficiente en ${line.description}: quedan ${b.currentUnits} ud.`,
        );
      }
      b.currentUnits = b.currentUnits - line.quantity;
      touchedBatches.set(b._id, b);
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
  const paymentStatus = computePaymentStatus(
    totalUsd,
    paidUsdCash,
    paidUsdTransfer,
    paidBs,
    input.exchangeRateBCV,
  );

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

  // ONE bulkDocs — sale + movement + touched counters written atomically.
  const writes = [sale, movement, ...touchedProducts.values(), ...touchedBatches.values()];
  const results = await db.bulkDocs(writes);

  // Counter docs can conflict with a concurrent local write. Retry ONCE with fresh revs.
  const conflicted = results.some((r) => 'error' in r && (r as PouchDB.Core.Error).status === 409);
  if (conflicted) {
    if (isRetry) throw new Error('Conflicto de inventario persistente. Reintente la venta.');
    // Re-check idempotency: the sale may have won even if a counter lost.
    const already = await getExisting(db, saleId);
    if (already) return already;
    return attemptCheckout(db, input, saleId, /*isRetry*/ true);
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
