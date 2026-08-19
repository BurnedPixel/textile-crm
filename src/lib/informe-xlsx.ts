// Informe as an .xlsx workbook, for the "Exportar Excel" button in
// InformesIsland. Independent re-scan of the period (ReportData only carries
// aggregates, this needs the raw rows) — same scanLedger/scanPrefix calls
// report.ts already makes, no new indexes. Pure over `db`, no db.ts import.

import { scanLedger, scanPrefix, saleTaxes, usdPaid } from './queries';
import { getPayments, getRefunds, paymentsBySale, refundsBySale, saleBalance } from './payments';
import { round2, round3, fmtLot, PAYMENT_LABEL, CONDITION_LABEL, PRODUCT_TYPE_LABEL, NM_LABEL, fmtPiece } from './format';
import { hasRollStock } from './types';
import type {
  SaleDoc, PaymentDoc, RefundDoc, ExpenseDoc, InventoryMovementDoc,
  PayrollPayDoc, BatchDoc, ProductDoc, ClientDoc, WorkerDoc, MovementType, EntryMethod,
} from './types';
import { periodScanOpts, type ReportPeriod, type ReportData } from './report';
import type { SheetSpec } from './xlsx';

type DB = PouchDB.Database;

// Not in format.ts (no other caller needs it yet) — a local map, not a
// redeclaration of an existing translation.
const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  IN: 'Entrada', OUT: 'Salida', ADJUST: 'Ajuste',
};
const ENTRY_METHOD_LABEL: Record<EntryMethod, string> = {
  CASH: 'Efectivo', TRANSFER: 'Transferencia',
};

/** Local calendar date + HH:mm, no Intl month names — spreadsheet-legible, sortable. */
function isoParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

function batchLabel(batch: BatchDoc | undefined, fallback: string): string {
  return batch ? `${batch.color} · ${batch.nm} · ${batch.fabricType}` : fallback;
}

export async function buildInformeSheets(
  db: DB,
  period: ReportPeriod,
  report: ReportData,
  nominaDb?: DB | null,
): Promise<SheetSpec[]> {
  const opts = periodScanOpts(period);
  // allPayments/allRefunds are UNBOUNDED on purpose: what a sale is worth today
  // depends on collections made after the period too, so the balance columns
  // cannot be derived from the period-scoped scans.
  const [sales, payments, refunds, expenses, movements, batches, products, clients, allPayments, allRefunds] = await Promise.all([
    scanLedger<SaleDoc>(db, 'sale:', opts),
    scanLedger<PaymentDoc>(db, 'payment:', opts),
    scanLedger<RefundDoc>(db, 'refund:', opts),
    scanLedger<ExpenseDoc>(db, 'expense:', opts),
    scanLedger<InventoryMovementDoc>(db, 'movement:', opts),
    scanPrefix<BatchDoc>(db, 'batch:'),
    scanPrefix<ProductDoc>(db, 'product:'),
    scanPrefix<ClientDoc>(db, 'client:'),
    getPayments(db),
    getRefunds(db),
  ]);
  const paymentsFor = paymentsBySale(allPayments);
  const refundsFor = refundsBySale(allRefunds);

  const batchById = new Map(batches.map((b) => [b._id, b]));
  const productById = new Map(products.map((p) => [p._id, p]));
  const productsByBatchId = new Map<string, ProductDoc[]>();
  for (const p of products) {
    const arr = productsByBatchId.get(p.batchId) ?? [];
    arr.push(p);
    productsByBatchId.set(p.batchId, arr);
  }
  const clientById = new Map(clients.map((c) => [c._id, c]));
  const clientName = (clientId: string | null) =>
    clientId ? (clientById.get(clientId)?.name ?? clientId) : 'Contado';

  // ---- 1. Resumen ----
  const resumen: SheetSpec = {
    name: 'Resumen',
    headers: ['Concepto', 'Valor'],
    rows: [
      ['Periodo', report.period.label],
      ['Desde', report.period.start],
      ['Hasta', report.period.end],
      ['Cantidad de ventas', report.sales.count],
      ['Base $', report.sales.baseUsd],
      ['IVA $', report.sales.ivaUsd],
      ['IGTF $', report.sales.igtfUsd],
      ['Total general $', report.sales.grandTotalUsd],
      ['En libros', report.sales.onBooksCount],
      ['Fuera de libros', report.sales.offBooksCount],
      ['Ticket promedio $', report.avgTicketUsd],
      ['Mejor día', report.bestDay?.date ?? ''],
      ['Total mejor día $', report.bestDay?.totalUsd ?? 0],
      ['Ventas periodo anterior', report.previous.count],
      ['Total periodo anterior $', report.previous.grandTotalUsd],
      ['Gastos periodo anterior $', report.previous.expensesTotalUsd],
      ['Cobrado periodo anterior $', report.previous.collectedUsd],
      ['Cobros posteriores (abonos)', report.collections.paymentsCount],
      ['Cobrado $', report.collections.collectedUsd],
      ['Vueltos entregados', report.collections.refundsCount],
      ['Total vueltos $', report.collections.refundedUsd],
      ['Cantidad de gastos', report.expenses.count],
      ['Total gastos $', report.expenses.totalUsd],
      ['Gastos fijos $', report.expenses.fixedUsd],
      ['Gastos variables $', report.expenses.variableUsd],
      ['Costo de venta $', report.cogs.costUsd],
      ['Utilidad bruta $', report.cogs.grossMarginUsd],
      ['Margen %', round2(report.cogs.marginPct * 100)],
      ['Cobertura de costo %', round2(report.cogs.coverage * 100)],
      ['Kg entrada', report.movements.kgIn],
      ['Kg salida', report.movements.kgOut],
      ['Unidades entrada', report.movements.unitsIn],
      ['Unidades salida', report.movements.unitsOut],
      ['Artículos en stock', report.stockNow.batches],
      ['Kg en stock', report.stockNow.kg],
      ['Unidades en stock', report.stockNow.units],
      ['Valor de stock $', report.stockNow.valueUsd],
    ],
  };

  // ---- 2. Ventas ----
  const ventasSorted = [...sales].sort((a, b) => a.date.localeCompare(b.date));
  const ventas: SheetSpec = {
    name: 'Ventas',
    headers: ['Fecha', 'Hora', 'ID de venta', 'Cliente', 'En libros', 'Base', 'IVA', 'IGTF', 'Total', 'Pagado', 'Saldo', 'A favor', 'Estado', 'Tasa BCV'],
    rows: ventasSorted.map((s) => {
      const { date, time } = isoParts(s.date);
      const t = saleTaxes(s);
      // Balance DERIVED today, never the checkout snapshot on the sale: a later
      // cobro or vuelto changes what is owed, and sale.paymentStatus does not.
      const b = saleBalance(s, paymentsFor.get(s._id) ?? [], refundsFor.get(s._id) ?? []);
      return [
        date, time, s.transactionId, clientName(s.clientId), s.isOnTheBooks ? 'Sí' : 'No',
        round2(t.baseUsd), round2(t.ivaUsd), round2(t.igtfUsd), round2(t.grandTotalUsd),
        b.paidUsd, b.owedUsd, b.creditUsd, PAYMENT_LABEL[b.status], s.exchangeRateBCV,
      ];
    }),
  };

  // ---- 3. Ventas por producto ----
  const ventasProducto: SheetSpec = {
    name: 'Ventas por producto',
    headers: ['Fecha', 'ID de venta', 'Cliente', 'Artículo', 'Color', 'Código', NM_LABEL, 'Tela', 'Lote', 'Descripción', 'Cantidad', 'Unidad', 'Precio unitario', 'Subtotal'],
    rows: ventasSorted.flatMap((s) => {
      const { date } = isoParts(s.date);
      return s.lineItems.map((li) => {
        const batch = batchById.get(li.batchId);
        const product = productById.get(li.productId);
        return [
          date, s.transactionId, clientName(s.clientId), batchLabel(batch, li.batchId),
          batch?.color ?? '', batch?.colorCode ?? '', batch?.nm ?? '', batch?.fabricType ?? '',
          fmtLot(product?.lotNumber), li.description,
          li.unitOfMeasure === 'Kg' ? round3(li.quantity) : round2(li.quantity),
          li.unitOfMeasure, round2(li.unitPriceAtSale), round2(li.lineSubtotalUsd),
        ];
      });
    }),
  };

  // ---- 4. Movimientos ----
  const movimientosSorted = [...movements].sort((a, b) => a.date.localeCompare(b.date));
  const movimientos: SheetSpec = {
    name: 'Movimientos',
    headers: ['Fecha', 'Hora', 'Tipo', 'Motivo', 'Referencia', 'Operador', 'Artículo', 'Rollo/Producto', 'Lote', 'Cantidad', 'Unidad', 'Condición'],
    rows: movimientosSorted.flatMap((m) => {
      const { date, time } = isoParts(m.date);
      return m.lineItems.map((li) => {
        const product = productById.get(li.productId);
        const batch = product ? batchById.get(product.batchId) : undefined;
        return [
          date, time, MOVEMENT_TYPE_LABEL[m.movementType], m.reason, m.referenceId, m.operatorId,
          batchLabel(batch, product?.batchId ?? li.productId),
          product ? fmtPiece(product.pieceId) : li.productId,
          fmtLot(product?.lotNumber),
          li.unitOfMeasure === 'Kg' ? round3(li.quantityChanged) : round2(li.quantityChanged),
          li.unitOfMeasure, CONDITION_LABEL[li.conditionTag],
        ];
      });
    }),
  };

  // ---- 5. Cobros y vueltos ----
  type CV = { date: string; kind: 'Cobro' | 'Vuelto entregado'; saleId: string; cash: number; transfer: number; bs: number; rate: number; note: string; operatorId: string };
  const cv: CV[] = [
    ...payments.map((p): CV => ({
      date: p.date, kind: 'Cobro', saleId: p.saleId, cash: p.paidUsdCash, transfer: p.paidUsdTransfer,
      bs: p.paidBs, rate: p.exchangeRateBCV, note: p.note, operatorId: p.operatorId,
    })),
    ...refunds.map((r): CV => ({
      date: r.date, kind: 'Vuelto entregado', saleId: r.saleId, cash: r.givenUsdCash, transfer: r.givenUsdTransfer,
      bs: r.givenBs, rate: r.exchangeRateBCV, note: r.note, operatorId: r.operatorId,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  // Sales referenced may sit outside the period (a collection on an old debt) — resolve individually.
  const saleIds = [...new Set(cv.map((c) => c.saleId))];
  const referencedSales = await Promise.all(saleIds.map((id) => db.get(id).catch(() => null) as Promise<SaleDoc | null>));
  const saleById = new Map(referencedSales.filter((s): s is SaleDoc => s !== null).map((s) => [s._id, s]));
  const cobrosVueltos: SheetSpec = {
    name: 'Cobros y vueltos',
    headers: ['Fecha', 'Tipo', 'ID de venta', 'Cliente', 'Efectivo $', 'Transferencia $', 'Bs', 'Tasa BCV', 'Equivalente $', 'Nota', 'Operador'],
    rows: cv.map((c) => {
      const { date } = isoParts(c.date);
      const sale = saleById.get(c.saleId);
      return [
        date, c.kind, sale?.transactionId ?? c.saleId, clientName(sale?.clientId ?? null),
        round2(c.cash), round2(c.transfer), round2(c.bs), c.rate,
        round2(usdPaid(c.cash, c.transfer, c.bs, c.rate)), c.note, c.operatorId,
      ];
    }),
  };

  // ---- 6. Gastos ----
  const gastosSorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
  const gastos: SheetSpec = {
    name: 'Gastos',
    headers: ['Fecha', 'Categoría', 'Descripción', 'Fijo', 'Método', 'Monto $', 'Tasa BCV'],
    rows: gastosSorted.map((e) => [
      isoParts(e.date).date, e.category, e.description, e.isFixedExpense ? 'Sí' : 'No',
      ENTRY_METHOD_LABEL[e.entryMethod], round2(e.amountUsd), e.exchangeRateBCV,
    ]),
  };

  // ---- 7. Inventario actual (hoy, no el periodo) ----
  const invRows: (string | number)[][] = [];
  for (const b of batches) {
    if (b.currentUnits <= 0) continue;
    const batchProducts = productsByBatchId.get(b._id) ?? [];
    const label = batchLabel(b, b._id);
    if (b.productType === 'ROLL') {
      for (const p of batchProducts) {
        if (!hasRollStock(p.currentWeightKg)) continue;
        invRows.push([
          label, b.color, b.colorCode ?? '', b.nm, b.fabricType, PRODUCT_TYPE_LABEL[b.productType],
          fmtLot(p.lotNumber), p.fiberComposition ?? '', p.pantone ?? '', CONDITION_LABEL[p.conditionTag],
          round3(p.currentWeightKg), 0, round2(p.purchaseValueUsd), round2(p.salePriceUsd),
          round2(p.currentWeightKg * p.purchaseValueUsd),
        ]);
      }
    } else {
      const p = batchProducts[0];
      invRows.push([
        label, b.color, b.colorCode ?? '', b.nm, b.fabricType, PRODUCT_TYPE_LABEL[b.productType],
        fmtLot(p?.lotNumber), p?.fiberComposition ?? '', p?.pantone ?? '', p ? CONDITION_LABEL[p.conditionTag] : '',
        0, round2(b.currentUnits), round2(p?.purchaseValueUsd ?? 0), round2(p?.salePriceUsd ?? 0),
        round2(b.currentUnits * (p?.purchaseValueUsd ?? 0)),
      ]);
    }
  }
  const inventarioActual: SheetSpec = {
    name: 'Inventario actual',
    headers: ['Artículo', 'Color', 'Código', NM_LABEL, 'Tela', 'Tipo', 'Lote', 'Composición', 'Pantone', 'Condición', 'Kg actuales', 'Unidades', 'Costo $', 'Precio $', 'Valor $'],
    rows: invRows,
  };

  const sheets = [resumen, ventas, ventasProducto, movimientos, cobrosVueltos, gastos, inventarioActual];

  // ---- 8. Nómina (only when the caller passed a DB it can read — admin-only). ----
  if (nominaDb) {
    try {
      const [pays, workers] = await Promise.all([
        scanLedger<PayrollPayDoc>(nominaDb, 'payrollpay:', opts),
        scanPrefix<WorkerDoc>(nominaDb, 'worker:'),
      ]);
      const workerById = new Map(workers.map((w) => [w._id, w]));
      const paysSorted = [...pays].sort((a, b) => a.date.localeCompare(b.date));
      sheets.push({
        name: 'Nómina',
        headers: ['Fecha', 'Trabajador', 'Concepto', 'Periodo cubierto', 'Monto $', 'Tasa BCV'],
        rows: paysSorted.flatMap((pay) => {
          const { date } = isoParts(pay.date);
          const worker = workerById.get(pay.workerId);
          return pay.lines.map((line) => [
            date, worker?.name ?? pay.workerId, line.label, line.periodKey, round2(line.amountUsd), pay.exchangeRateBCV,
          ]);
        }),
      });
    } catch {
      // No admin access (or nomina DB unreachable) — omit the sheet, same
      // failure-hidden criterion the informes island already uses.
    }
  }

  return sheets;
}
