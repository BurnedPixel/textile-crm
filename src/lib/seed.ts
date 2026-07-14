// Demo data seeder (DEV only — called from db.ts when the DB is empty). Builds
// realistic Venezuelan textile data THROUGH the real logic paths (ingressStock,
// checkout, saveClient, saveDailyRate, addExpense) so the seed exercises the same
// validation + ledger writes production uses. Never raw puts. Takes `db` first.

import { batchIdOf, productIdOf, type CartLineItem } from './types';
import { saveDailyRate, saveClient, addExpense } from './queries';
import { ingressStock } from './inventory';
import { checkout } from './checkout';

type DB = PouchDB.Database;

const RATE = 36.5;
const OP = 'demo';

interface RollSpec {
  color: string;
  nm: string;
  fabricType: string;
  rolls: number;
  kgEach: number;
  purchaseUsd: number;
  saleUsd: number;
}

// ~8 batches: mostly ROLL, one COMBO, one PIECE.
const ROLL_BATCHES: RollSpec[] = [
  { color: 'Azul Rey', nm: '30', fabricType: 'Jersey', rolls: 5, kgEach: 22, purchaseUsd: 5.5, saleUsd: 8.5 },
  { color: 'Negro', nm: '24', fabricType: 'Rib', rolls: 6, kgEach: 18, purchaseUsd: 5.0, saleUsd: 7.9 },
  { color: 'Rojo Vino', nm: '30', fabricType: 'Piqué', rolls: 4, kgEach: 20, purchaseUsd: 6.0, saleUsd: 9.2 },
  { color: 'Verde Botella', nm: '20', fabricType: 'Interlock', rolls: 4, kgEach: 25, purchaseUsd: 5.8, saleUsd: 8.8 },
  { color: 'Blanco', nm: '24', fabricType: 'Jersey', rolls: 6, kgEach: 15, purchaseUsd: 4.9, saleUsd: 7.5 },
  { color: 'Gris Melange', nm: '30', fabricType: 'Rib', rolls: 3, kgEach: 21, purchaseUsd: 5.3, saleUsd: 8.1 },
];

export async function seedDemoData(db: DB): Promise<void> {
  await saveDailyRate(db, RATE);

  // --- Inventory: ROLL batches (each roll a distinct piece, weight-tracked). ---
  for (const spec of ROLL_BATCHES) {
    await ingressStock(db, {
      color: spec.color,
      nm: spec.nm,
      fabricType: spec.fabricType,
      productType: 'ROLL',
      location: 'Depósito A',
      operatorId: OP,
      reason: 'Inventario inicial',
      rolls: Array.from({ length: spec.rolls }, (_, i) => ({
        pieceId: `R${i + 1}`,
        weightKg: spec.kgEach,
        purchaseValueUsd: spec.purchaseUsd,
        salePriceUsd: spec.saleUsd,
        conditionTag: 'FIRST' as const,
      })),
    });
  }

  // --- One COMBO batch (units). ---
  await ingressStock(db, {
    color: 'Multicolor',
    nm: '24',
    fabricType: 'Combo',
    productType: 'COMBO',
    location: 'Depósito B',
    operatorId: OP,
    reason: 'Inventario inicial',
    units: 40,
    unitPurchaseValueUsd: 12,
    unitSalePriceUsd: 19,
    unitConditionTag: 'FIRST',
  });

  // --- One PIECE batch (units). ---
  await ingressStock(db, {
    color: 'Negro',
    nm: '30',
    fabricType: 'Franela',
    productType: 'PIECE',
    location: 'Depósito B',
    operatorId: OP,
    reason: 'Inventario inicial',
    units: 120,
    unitPurchaseValueUsd: 2.5,
    unitSalePriceUsd: 4.5,
    unitConditionTag: 'FIRST',
  });

  // --- Clients (V- = cédula/persona, J- = RIF/empresa). ---
  const c1 = await saveClient(db, {
    documentId: 'V-12345678',
    entityType: 'PERSON',
    name: 'María Rodríguez',
    address: 'Av. Bolívar, Valencia',
    phoneNumber: '0414-1234567',
    specialty: ['Ropa infantil'],
  });
  const c2 = await saveClient(db, {
    documentId: 'J-40123456-7',
    entityType: 'COMPANY',
    name: 'Textiles El Sol C.A.',
    address: 'Zona Industrial, Maracay',
    phoneNumber: '0243-7654321',
    specialty: ['Uniformes', 'Franelas'],
  });
  const c3 = await saveClient(db, {
    documentId: 'V-9876543',
    entityType: 'PERSON',
    name: 'José Pérez',
    address: 'Calle 5, San Diego',
    phoneNumber: '0424-9998877',
    specialty: ['Deportivo'],
  });

  // --- 3 sales with varied payment states. ---
  // Sale 1 — PAID in USD cash.
  const azulJersey = batchIdOf('Azul Rey', '30', 'Jersey');
  await checkout(db, {
    transactionId: 'seed-sale-1',
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    clientId: c1._id,
    isOnTheBooks: true,
    exchangeRateBCV: RATE,
    creditTerms: null,
    operatorId: OP,
    lines: [
      line(azulJersey, 'R1', 'Azul rey · NM 30 · Jersey · R1', 10, 'Kg', 8.5),
    ],
    payments: { paidUsdCash: 85, paidUsdTransfer: 0, paidBs: 0 },
  });

  // Sale 2 — PARTIAL (some cash, rest owed), COMBO units.
  const combo = batchIdOf('Multicolor', '24', 'Combo');
  await checkout(db, {
    transactionId: 'seed-sale-2',
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    clientId: c2._id,
    isOnTheBooks: true,
    exchangeRateBCV: RATE,
    creditTerms: '15 días',
    operatorId: OP,
    lines: [line(combo, 'stock', 'Multicolor · NM 24 · Combo', 6, 'Units', 19)],
    payments: { paidUsdCash: 50, paidUsdTransfer: 0, paidBs: 0 },
  });

  // Sale 3 — PENDING credit (nothing paid yet).
  const negroRib = batchIdOf('Negro', '24', 'Rib');
  await checkout(db, {
    transactionId: 'seed-sale-3',
    createdAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    clientId: c3._id,
    isOnTheBooks: false,
    exchangeRateBCV: RATE,
    creditTerms: '30 días',
    operatorId: OP,
    lines: [line(negroRib, 'R2', 'Negro · NM 24 · Rib · R2', 12, 'Kg', 7.9)],
    payments: { paidUsdCash: 0, paidUsdTransfer: 0, paidBs: 0 },
  });

  // --- 2 expenses. ---
  await addExpense(db, {
    category: 'Servicios',
    description: 'Electricidad depósito',
    isFixedExpense: true,
    entryMethod: 'TRANSFER',
    amountUsd: 45,
    exchangeRateBCV: RATE,
  });
  await addExpense(db, {
    category: 'Logística',
    description: 'Flete de mercancía',
    isFixedExpense: false,
    entryMethod: 'CASH',
    amountUsd: 30,
    exchangeRateBCV: RATE,
  });
}

function line(
  batchId: string,
  pieceId: string,
  description: string,
  quantity: number,
  unitOfMeasure: 'Kg' | 'Units',
  unitPriceAtSale: number,
): CartLineItem {
  return {
    productId: productIdOf(batchId, pieceId),
    batchId,
    description,
    quantity,
    unitOfMeasure,
    unitPriceAtSale,
    lineSubtotalUsd: 0, // checkout recomputes — trust nothing from the cart.
  };
}
