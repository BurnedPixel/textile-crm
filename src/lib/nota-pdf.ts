// Nota de entrega as a PDF, for the "Compartir PDF" button in SaleTerminal.
// Mirrors NotaEntrega.tsx section-for-section, wording and figures — the two
// must never drift, so every number here comes from saleTaxes()/usdPaid() in
// queries.ts, exactly like the on-screen component.

import { jsPDF } from 'jspdf';
import { fmtUsd, fmtBs, fmtDateTime, toBs, PAYMENT_LABEL } from './format';
import { saleTaxes, usdPaid } from './queries';
import type { ClientDoc, FiscalConfigDoc, SaleDoc } from './types';

const MARGIN = 15;
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
  doc.setFontSize(13);
  doc.text(fiscal?.businessName ?? '—', MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const rifLine = `${fiscal?.taxId ? `RIF ${fiscal.taxId}` : 'RIF no configurado'}${fiscal?.address ? ` · ${fiscal.address}` : ''}`;
  doc.text(rifLine, MARGIN, y);
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.text('NOTA DE ENTREGA — no es una factura fiscal', MARGIN, y);
  y += 4;
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  // Client block (left) + date block (right)
  const rightX = PAGE_W - MARGIN;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('CLIENTE', MARGIN, y);
  doc.text('FECHA', rightX, y, { align: 'right' });
  y += 4.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(client?.name ?? 'Sin cliente', MARGIN, y);
  doc.text(fmtDateTime(sale.date), rightX, y, { align: 'right' });
  y += 4.5;
  doc.setFontSize(9);
  if (client?.documentId) {
    doc.text(client.documentId, MARGIN, y);
  }
  doc.text(`Op. ${sale.transactionId.slice(0, 8)}`, rightX, y, { align: 'right' });
  y += 4.5;
  if (client?.address) {
    doc.text(client.address, MARGIN, y);
  }
  doc.text(`Tasa BCV ${fmtBs(rate)} / $`, rightX, y, { align: 'right' });
  y += 8;

  // Line items table
  const colDesc = MARGIN;
  const colQty = 120;
  const colPrice = 150;
  const colSub = rightX;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('DESCRIPCIÓN', colDesc, y);
  doc.text('CANT.', colQty, y, { align: 'right' });
  doc.text('P. UNIT.', colPrice, y, { align: 'right' });
  doc.text('SUBTOTAL', colSub, y, { align: 'right' });
  y += 2;
  doc.line(MARGIN, y, rightX, y);
  y += 4.5;

  doc.setFont('courier', 'normal');
  doc.setFontSize(9);
  for (const l of sale.lineItems) {
    const descLines = doc.splitTextToSize(l.description, colQty - colDesc - 4);
    const rowHeight = Math.max(4.5, descLines.length * 4.2);
    ensureRoom(rowHeight + 2);
    doc.text(descLines, colDesc, y);
    const qtyLabel = `${l.quantity} ${l.unitOfMeasure === 'Kg' ? 'kg' : 'ud'}`;
    doc.text(qtyLabel, colQty, y, { align: 'right' });
    doc.text(fmtUsd(l.unitPriceAtSale), colPrice, y, { align: 'right' });
    doc.text(fmtUsd(l.lineSubtotalUsd), colSub, y, { align: 'right' });
    y += rowHeight;
  }
  y += 2;
  ensureRoom(30);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, rightX, y);
  // Text y is the BASELINE — leave room for the ascenders of the first row.
  y += 5;

  // Totals block
  const totalRow = (label: string, usd: number, opts: { strong?: boolean } = {}) => {
    ensureRoom(9);
    doc.setFont('helvetica', opts.strong ? 'bold' : 'normal');
    doc.setFontSize(opts.strong ? 10 : 9);
    doc.text(label, colPrice - 30, y);
    doc.setFont('courier', opts.strong ? 'bold' : 'normal');
    doc.text(fmtUsd(usd), colSub, y, { align: 'right' });
    y += 4;
    if (rate > 0) {
      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.text(fmtBs(toBs(usd, rate)), colSub, y, { align: 'right' });
      y += 4;
    }
    y += 1;
  };

  totalRow('Base imponible', taxes.baseUsd);
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
