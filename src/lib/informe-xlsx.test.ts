import { describe, expect, it } from 'vitest';
import { makeTestDb } from './testdb';
import { buildInformeSheets } from './informe-xlsx';
import { buildXlsx } from './xlsx';
import { buildReport, monthPeriod } from './report';
import {
  saleIdOf, paymentIdOf, refundIdOf, expenseIdOf, movementIdOf, payrollPayIdOf, workerIdOf,
  type SaleDoc, type PaymentDoc, type RefundDoc, type ExpenseDoc, type InventoryMovementDoc,
  type BatchDoc, type ProductDoc, type ClientDoc, type PayrollPayDoc, type WorkerDoc,
} from './types';

describe('buildInformeSheets', () => {
  it('produces every sheet with money as numbers, one row per sale line, and PK-prefixed bytes', async () => {
    const db = makeTestDb();
    const nominaDb = makeTestDb();
    const date = '2026-08-05T14:30:00.000Z';

    await db.put({
      _id: 'client:v-1', type: 'client', documentId: 'V-1', entityType: 'PERSON',
      name: 'ANA PEREZ', address: '', phoneNumber: '', email: '', specialty: [], updatedAt: date,
    } as ClientDoc);

    await db.put({
      _id: 'batch:azul:30:jersey', type: 'batch', color: 'Azul', nm: '30', fabricType: 'Jersey',
      productType: 'ROLL', initialUnitCount: 1, currentUnits: 1, location: '', createdAt: date,
    } as BatchDoc);
    await db.put({
      _id: 'product:batch:azul:30:jersey:R1', type: 'product', batchId: 'batch:azul:30:jersey',
      pieceId: 'R1', initialWeightKg: 20, currentWeightKg: 15, purchaseValueUsd: 2, salePriceUsd: 5,
      conditionTag: 'FIRST', createdAt: date, lotNumber: '7892',
    } as ProductDoc);

    const saleId = saleIdOf(date, 'A');
    await db.put({
      _id: saleId, type: 'sale', transactionId: 'A', clientId: 'client:v-1', date,
      isOnTheBooks: true, exchangeRateBCV: 36, totalUsd: 100, ivaRate: 0.16, igtfRate: 0.03,
      paidUsdCash: 80, paidUsdTransfer: 0, paidBs: 0, paymentStatus: 'PARTIAL', creditTerms: null,
      lineItems: [
        {
          productId: 'product:batch:azul:30:jersey:R1', batchId: 'batch:azul:30:jersey',
          description: 'Azul · 30 · Jersey (Lote 7892)', quantity: 5, unitOfMeasure: 'Kg',
          unitPriceAtSale: 20, lineSubtotalUsd: 100,
        },
        {
          productId: 'product:batch:azul:30:jersey:R1', batchId: 'batch:azul:30:jersey',
          description: 'Azul · 30 · Jersey (Lote 7892) — segunda línea', quantity: 2, unitOfMeasure: 'Kg',
          unitPriceAtSale: 10, lineSubtotalUsd: 20,
        },
      ],
    } as SaleDoc);

    await db.put({
      _id: paymentIdOf(date, 'p1'), type: 'payment', paymentId: 'p1', saleId, date,
      exchangeRateBCV: 36, paidUsdCash: 20, paidUsdTransfer: 0, paidBs: 0, note: 'abono', operatorId: 'op',
    } as PaymentDoc);

    await db.put({
      _id: expenseIdOf(date, 'e1'), type: 'expense', expenseId: 'e1', date, category: 'Insumos',
      description: 'hilo', isFixedExpense: false, entryMethod: 'CASH', amountUsd: 10, exchangeRateBCV: 36,
    } as ExpenseDoc);

    await db.put({
      _id: movementIdOf(date, 'm1'), type: 'movement', movementId: 'm1', date, movementType: 'OUT',
      referenceId: saleId, reason: 'Venta', operatorId: 'op',
      lineItems: [{ productId: 'product:batch:azul:30:jersey:R1', quantityChanged: -7, unitOfMeasure: 'Kg', conditionTag: 'FIRST' }],
    } as InventoryMovementDoc);

    await nominaDb.put({
      _id: workerIdOf('V-9'), type: 'worker', documentId: 'V-9', name: 'LUIS GOMEZ', active: true,
      concepts: [], updatedAt: date,
    } as WorkerDoc);
    await nominaDb.put({
      _id: payrollPayIdOf(date, 'pp1'), type: 'payrollpay', payId: 'pp1', workerId: workerIdOf('V-9'),
      date, entryMethod: 'TRANSFER', exchangeRateBCV: 36,
      lines: [{ label: 'Salario', amountUsd: 200, periodKey: '2026-08' }],
      totalUsd: 200, operatorId: 'op',
    } as PayrollPayDoc);

    const period = monthPeriod(new Date(2026, 7, 1));
    const report = await buildReport(db, period);

    const sheets = await buildInformeSheets(db, period, report, nominaDb);
    const byName = new Map(sheets.map((s) => [s.name, s]));

    expect([...byName.keys()]).toEqual([
      'Resumen', 'Ventas', 'Ventas por producto', 'Movimientos', 'Cobros y vueltos',
      'Gastos', 'Inventario actual', 'Nómina',
    ]);

    // Resumen: two columns, money as numbers.
    const resumen = byName.get('Resumen')!;
    expect(resumen.headers).toEqual(['Concepto', 'Valor']);
    const totalRow = resumen.rows.find((r) => r[0] === 'Total general $');
    expect(totalRow?.[1]).toBe(report.sales.grandTotalUsd); // never re-derived, straight from ReportData

    // Ventas: one row, numbers not strings.
    const ventas = byName.get('Ventas')!;
    expect(ventas.rows).toHaveLength(1);
    expect(typeof ventas.rows[0][5]).toBe('number'); // Base

    // Ventas por producto: one row PER LINE (2 lines on the one sale).
    const porProducto = byName.get('Ventas por producto')!;
    expect(porProducto.rows).toHaveLength(2);
    expect(porProducto.rows[0]).toContain('Azul'); // color
    expect(porProducto.rows[0]).toContain('Lote 7892');
    expect(typeof porProducto.rows[0][porProducto.headers.indexOf('Subtotal')]).toBe('number');

    // Movimientos: one row.
    const movimientos = byName.get('Movimientos')!;
    expect(movimientos.rows).toHaveLength(1);
    expect(movimientos.rows[0]).toContain('Salida');

    // Cobros y vueltos: one payment row, client resolved.
    const cobros = byName.get('Cobros y vueltos')!;
    expect(cobros.rows).toHaveLength(1);
    expect(cobros.rows[0]).toContain('ANA PEREZ');
    expect(cobros.rows[0]).toContain('Cobro');

    // Gastos: one row.
    expect(byName.get('Gastos')!.rows).toHaveLength(1);

    // Inventario actual: one row (the roll, 15kg left).
    const inv = byName.get('Inventario actual')!;
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0][inv.headers.indexOf('Kg actuales')]).toBe(15);

    // Nómina: present with admin nominaDb, one line row.
    const nomina = byName.get('Nómina')!;
    expect(nomina.rows).toHaveLength(1);
    expect(nomina.rows[0]).toContain('LUIS GOMEZ');

    // Omitted entirely without nominaDb.
    const sheetsNoAdmin = await buildInformeSheets(db, period, report, null);
    expect(sheetsNoAdmin.some((s) => s.name === 'Nómina')).toBe(false);

    const bytes = buildXlsx(sheets);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
  });

  it('Ventas derives the balance today (a later cobro settles the sale, a vuelto is not lost)', async () => {
    const db = makeTestDb();
    const date = '2026-08-05T14:30:00.000Z';
    const saleId = saleIdOf(date, 'A');
    await db.put({
      _id: saleId, type: 'sale', transactionId: 'A', clientId: null, date,
      isOnTheBooks: false, exchangeRateBCV: 36, totalUsd: 100,
      paidUsdCash: 80, paidUsdTransfer: 0, paidBs: 0, paymentStatus: 'PARTIAL', creditTerms: null,
      lineItems: [],
    } as unknown as SaleDoc);
    // Collected three days later: the sale doc still says PARTIAL / 80 paid.
    await db.put({
      _id: paymentIdOf('2026-08-08T12:00:00.000Z', 'p1'), type: 'payment', paymentId: 'p1', saleId,
      date: '2026-08-08T12:00:00.000Z', exchangeRateBCV: 36, paidUsdCash: 30, paidUsdTransfer: 0,
      paidBs: 0, note: '', operatorId: 'op',
    } as PaymentDoc);
    // ...and 10 of it handed back as vuelto.
    await db.put({
      _id: refundIdOf('2026-08-09T12:00:00.000Z', 'r1'), type: 'refund', saleId,
      date: '2026-08-09T12:00:00.000Z', exchangeRateBCV: 36, givenUsdCash: 10, givenUsdTransfer: 0,
      givenBs: 0, note: '', operatorId: 'op',
    } as RefundDoc);

    const period = monthPeriod(new Date(2026, 7, 1));
    const report = await buildReport(db, period);
    const ventas = (await buildInformeSheets(db, period, report)).find((s) => s.name === 'Ventas')!;
    const row = ventas.rows[0];
    expect(row[ventas.headers.indexOf('Pagado')]).toBe(110);
    expect(row[ventas.headers.indexOf('Saldo')]).toBe(0);
    expect(row[ventas.headers.indexOf('A favor')]).toBe(0);
    expect(row[ventas.headers.indexOf('Estado')]).toBe('Pagada');
  });

  it('every sheet is present with headers even for an empty period', async () => {
    const db = makeTestDb();
    const period = monthPeriod(new Date(2020, 0, 1));
    const report = await buildReport(db, period);
    const sheets = await buildInformeSheets(db, period, report);
    expect(sheets.map((s) => s.name)).toEqual([
      'Resumen', 'Ventas', 'Ventas por producto', 'Movimientos', 'Cobros y vueltos', 'Gastos', 'Inventario actual',
    ]);
    for (const s of sheets) {
      if (s.name === 'Resumen') continue; // carries the aggregate rows, never empty
      expect(s.rows).toEqual([]);
    }
    expect(sheets[0].rows.length).toBeGreaterThan(0);
  });
});
