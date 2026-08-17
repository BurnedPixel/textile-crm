// Nota de entrega as a PDF, for the "Compartir PDF" button in SaleTerminal.
// Mirrors NotaEntrega.tsx section-for-section, wording and figures — the two
// must never drift, so every number here comes from saleTaxes()/usdPaid() in
// queries.ts, exactly like the on-screen component.

import { jsPDF } from 'jspdf';
import { fmtUsd, fmtBs, fmtDateTime, toBs, PAYMENT_LABEL } from './format';
import { saleTaxes, usdPaid } from './queries';
import type { ClientDoc, FiscalConfigDoc, SaleDoc } from './types';

const MARGIN = 10;
const PAGE_W = 210; // A4 portrait, mm
const PAGE_H = 297;

export function buildNotaPdf(
  sale: SaleDoc,
  client: ClientDoc | null,
  fiscal: FiscalConfigDoc | null,
): ArrayBuffer {
  const taxes = saleTaxes(sale);
  const rate = sale.exchangeRateBCV;
  const paidUsd = usdPaid(sale.paidUsdCash, sale.paidUsdTransfer, sale.paidBs, rate);
  const owedUsd = Math.max(0, +(taxes.grandTotalUsd - paidUsd).toFixed(2));
  const creditSnapshotUsd = Math.max(0, +(paidUsd - taxes.grandTotalUsd).toFixed(2));

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  const ensureRoom = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(fiscal?.businessName ?? '—', MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  const rifLine = `${fiscal?.taxId ? `RIF ${fiscal.taxId}` : 'RIF no configurado'}${fiscal?.address ? ` · ${fiscal.address}` : ''}`;
  doc.text(rifLine, MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'bold');
  doc.text('NOTA DE ENTREGA', MARGIN, y);
  y += 3;
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 4.5;

  // Client block (left) + date block (right)
  const rightX = PAGE_W - MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('CLIENTE', MARGIN, y);
  doc.text('FECHA', rightX, y, { align: 'right' });
  y += 3.8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(client?.name ?? 'Sin cliente', MARGIN, y);
  doc.text(fmtDateTime(sale.date), rightX, y, { align: 'right' });
  y += 3.8;
  doc.setFontSize(8);
  if (client?.documentId) {
    doc.text(client.documentId, MARGIN, y);
  }
  doc.text(`Op. ${sale.transactionId.slice(0, 8)}`, rightX, y, { align: 'right' });
  y += 3.8;
  if (client?.address) {
    doc.text(client.address, MARGIN, y);
  }
  doc.text(`Tasa BCV ${fmtBs(rate)} / $`, rightX, y, { align: 'right' });
  y += 6;

  // Line items table
  const colDesc = MARGIN;
  const colQty = 120;
  const colPrice = 150;
  const colSub = rightX;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.text('DESCRIPCIÓN', colDesc, y);
  doc.text('CANT.', colQty, y, { align: 'right' });
  doc.text('P. UNIT.', colPrice, y, { align: 'right' });
  doc.text('SUBTOTAL', colSub, y, { align: 'right' });
  y += 2;
  doc.line(MARGIN, y, rightX, y);
  y += 3.6;

  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  for (const l of sale.lineItems) {
    const descLines = doc.splitTextToSize(l.description, colQty - colDesc - 4);
    const rowHeight = Math.max(3.6, descLines.length * 3.4);
    ensureRoom(rowHeight + 1.5);
    doc.text(descLines, colDesc, y);
    const qtyLabel = `${l.quantity} ${l.unitOfMeasure === 'Kg' ? 'kg' : 'ud'}`;
    doc.text(qtyLabel, colQty, y, { align: 'right' });
    doc.text(fmtUsd(l.unitPriceAtSale), colPrice, y, { align: 'right' });
    doc.text(fmtUsd(l.lineSubtotalUsd), colSub, y, { align: 'right' });
    y += rowHeight;
  }
  y += 1.5;
  ensureRoom(30);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, rightX, y);
  // Text y is the BASELINE — leave room for the ascenders of the first row.
  y += 5;

  // Totals block
  const totalRow = (label: string, usd: number, opts: { strong?: boolean } = {}) => {
    ensureRoom(7);
    doc.setFont('helvetica', opts.strong ? 'bold' : 'normal');
    doc.setFontSize(opts.strong ? 9 : 8);
    doc.text(label, colPrice - 30, y);
    doc.setFont('courier', opts.strong ? 'bold' : 'normal');
    doc.text(fmtUsd(usd), colSub, y, { align: 'right' });
    y += 3.2;
    if (rate > 0) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(7);
      doc.text(fmtBs(toBs(usd, rate)), colSub, y, { align: 'right' });
      y += 3.2;
    }
    y += 0.6;
  };

  totalRow('Base', taxes.baseUsd);
  if ((sale.ivaRate ?? 0) > 0) {
    totalRow(`IVA ${((sale.ivaRate ?? 0) * 100).toFixed(0)} %`, taxes.ivaUsd);
  }
  if (taxes.igtfUsd > 0) {
    totalRow(`IGTF ${((sale.igtfRate ?? 0) * 100).toFixed(0)} %`, taxes.igtfUsd);
  }
  totalRow('Total', taxes.grandTotalUsd, { strong: true });
  totalRow(`Pagado (${PAYMENT_LABEL[sale.paymentStatus]})`, paidUsd);
  if (owedUsd > 0.005) {
    totalRow('Saldo pendiente', owedUsd, { strong: true });
  }
  if (creditSnapshotUsd > 0.005) {
    totalRow('Vuelto pendiente', creditSnapshotUsd, { strong: true });
  }

  if (sale.creditTerms) {
    ensureRoom(6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Condiciones: ${sale.creditTerms}`, MARGIN, y);
    y += 6;
  }

  ensureRoom(6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text(
    'Documento interno de entrega. La factura fiscal la emite la máquina homologada por el SENIAT.',
    MARGIN,
    y,
  );

  return doc.output('arraybuffer');
}
