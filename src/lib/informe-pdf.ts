// Informe as a PDF, for the "Compartir PDF" button in InformesIsland.
// Mirrors InformesIsland.tsx section-for-section — every figure comes from the
// SAME ReportData object, never recomputed. Pattern copied from nota-pdf.ts
// (jspdf via dynamic import, y-coords are BASELINES).

import { jsPDF } from 'jspdf';
import { fmtUsd } from './format';
import type { ReportData, PayrollSummary } from './report';

const MARGIN = 10;
const PAGE_W = 210; // A4 portrait, mm
const PAGE_H = 297;

export function buildInformePdf(report: ReportData, payroll: PayrollSummary | null): ArrayBuffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;
  const rightX = PAGE_W - MARGIN;

  const ensureRoom = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const sectionTitle = (title: string) => {
    ensureRoom(8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(title, MARGIN, y);
    y += 2;
    doc.setLineWidth(0.2);
    doc.line(MARGIN, y, rightX, y);
    y += 5;
  };

  const row = (label: string, value: string) => {
    ensureRoom(5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(label, MARGIN, y);
    doc.setFont('courier', 'normal');
    doc.text(value, rightX, y, { align: 'right' });
    y += 4.5;
  };

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('INFORME', MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(report.period.label, MARGIN, y);
  y += 3;
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, rightX, y);
  y += 6;

  // Ventas
  sectionTitle('Ventas');
  row('Cantidad de ventas', String(report.sales.count));
  row('Base', fmtUsd(report.sales.baseUsd));
  row('IVA', fmtUsd(report.sales.ivaUsd));
  row('IGTF', fmtUsd(report.sales.igtfUsd));
  row('Total general', fmtUsd(report.sales.grandTotalUsd));
  row('En libros / no en libros', `${report.sales.onBooksCount} / ${report.sales.offBooksCount}`);
  y += 3;

  // Cobros y vueltos
  sectionTitle('Cobros y vueltos');
  row('Cobros posteriores (abonos)', String(report.collections.paymentsCount));
  row('Cobrado', fmtUsd(report.collections.collectedUsd));
  row('Vueltos entregados', String(report.collections.refundsCount));
  row('Total vueltos', fmtUsd(report.collections.refundedUsd));
  y += 3;

  // Gastos
  sectionTitle('Gastos');
  row('Cantidad de gastos', String(report.expenses.count));
  row('Total', fmtUsd(report.expenses.totalUsd));
  row('Fijos', fmtUsd(report.expenses.fixedUsd));
  row('Variables', fmtUsd(report.expenses.variableUsd));
  if (report.expenses.byCategory.length > 0) {
    y += 1;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    ensureRoom(4);
    doc.text('Por categoría', MARGIN, y);
    y += 4;
    for (const c of report.expenses.byCategory) {
      row(`${c.category} (${c.count})`, fmtUsd(c.totalUsd));
    }
  }
  y += 3;

  // Movimientos de inventario
  sectionTitle('Movimientos de inventario');
  row('Kg entrada / salida', `${report.movements.kgIn} / ${report.movements.kgOut}`);
  row('Unidades entrada / salida', `${report.movements.unitsIn} / ${report.movements.unitsOut}`);
  if (report.movements.byReason.length > 0) {
    y += 1;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    ensureRoom(4);
    doc.text('Por motivo', MARGIN, y);
    y += 4;
    for (const r of report.movements.byReason) {
      row(`${r.reason} (${r.count})`, `${r.kg} kg / ${r.units} ud`);
    }
  }

  // Nómina — only when the caller passed a summary (admin-only section).
  if (payroll) {
    y += 3;
    sectionTitle('Nómina');
    row('Cantidad de pagos', String(payroll.count));
    row('Total', fmtUsd(payroll.totalUsd));
  }

  return doc.output('arraybuffer');
}
