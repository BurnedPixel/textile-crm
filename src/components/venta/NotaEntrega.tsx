// Nota de entrega — NOT a fiscal invoice.
//
// The client owns a SENIAT-homologated fiscal printer that asks for the client,
// the products and the prices, prints the factura and transmits it (casilla 15).
// That machine stays the legal document. This app computes the tax, shows the
// figures and prints a delivery note carrying the fiscal header — it must never
// produce something that looks like a factura, and it has no correlativo.
//
// Every figure comes from saleTaxes(), the one pure function over the sale. The
// eventual fiscal-printer payload has to be built from these same numbers: two
// derivations of one tax figure is how they drift.

import { fmtUsd, fmtBs, fmtDateTime, toBs, PAYMENT_LABEL } from '../../lib/format';
import { saleTaxes, usdPaid } from '../../lib/queries';
import type { ClientDoc, FiscalConfigDoc, SaleDoc } from '../../lib/types';

interface NotaEntregaProps {
  sale: SaleDoc;
  client: ClientDoc | null;
  fiscal: FiscalConfigDoc | null;
}

export default function NotaEntrega({ sale, client, fiscal }: NotaEntregaProps) {
  const taxes = saleTaxes(sale);
  const rate = sale.exchangeRateBCV;
  const paidUsd = usdPaid(sale.paidUsdCash, sale.paidUsdTransfer, sale.paidBs, rate);
  const owedUsd = Math.max(0, +(taxes.grandTotalUsd - paidUsd).toFixed(2));
  // Symmetric snapshot: money received beyond the grand total, AT CHECKOUT.
  // The nota is a snapshot of the sale doc alone — no payments/refunds here.
  const creditSnapshotUsd = Math.max(0, +(paidUsd - taxes.grandTotalUsd).toFixed(2));

  return (
    <section className="nota-entrega" aria-label="Nota de entrega" style={sheet}>
      <header className="nota-header" style={{ borderBottom: '1px solid var(--color-ink)', paddingBottom: 10, marginBottom: 12 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
          {fiscal?.businessName ?? '—'}
        </div>
        <div style={meta}>
          {fiscal?.taxId ? `RIF ${fiscal.taxId}` : 'RIF no configurado'}
          {fiscal?.address ? ` · ${fiscal.address}` : ''}
        </div>
        <div style={{ ...meta, marginTop: 6, fontWeight: 700, color: 'var(--color-ink)' }}>
          NOTA DE ENTREGA
        </div>
      </header>

      <div className="nota-meta-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={label}>Cliente</div>
          <div style={value}>{client?.name ?? 'Sin cliente'}</div>
          {client?.documentId && <div style={meta}>{client.documentId}</div>}
          {client?.address && <div style={meta}>{client.address}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={label}>Fecha</div>
          <div style={value}>{fmtDateTime(sale.date)}</div>
          <div style={meta}>Op. {sale.transactionId.slice(0, 8)}</div>
          <div style={meta}>Tasa BCV {fmtBs(rate)} / $</div>
        </div>
      </div>

      <table className="nota-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={th}>Descripción</th>
            <th style={{ ...th, textAlign: 'right' }}>Cant.</th>
            <th style={{ ...th, textAlign: 'right' }}>P. unit.</th>
            <th style={{ ...th, textAlign: 'right' }}>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {sale.lineItems.map((l, i) => (
            <tr key={`${l.productId}-${i}`}>
              <td style={td}>{l.description}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                {l.quantity} {l.unitOfMeasure === 'Kg' ? 'kg' : 'ud'}
              </td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(l.unitPriceAtSale)}</td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(l.lineSubtotalUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="nota-totals" style={{ marginLeft: 'auto', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Row label="Base" usd={taxes.baseUsd} rate={rate} />
        {(sale.ivaRate ?? 0) > 0 && (
          <Row label={`IVA ${((sale.ivaRate ?? 0) * 100).toFixed(0)} %`} usd={taxes.ivaUsd} rate={rate} />
        )}
        {taxes.igtfUsd > 0 && (
          <Row label={`IGTF ${((sale.igtfRate ?? 0) * 100).toFixed(0)} %`} usd={taxes.igtfUsd} rate={rate} />
        )}
        <div style={{ borderTop: '1px solid var(--color-ink)', marginTop: 4, paddingTop: 4 }}>
          <Row label="Total" usd={taxes.grandTotalUsd} rate={rate} strong />
        </div>
        <Row label={`Pagado (${PAYMENT_LABEL[sale.paymentStatus]})`} usd={paidUsd} rate={rate} />
        {owedUsd > 0.005 && <Row label="Saldo pendiente" usd={owedUsd} rate={rate} strong />}
        {creditSnapshotUsd > 0.005 && <Row label="Vuelto pendiente" usd={creditSnapshotUsd} rate={rate} strong />}
      </div>

      {sale.creditTerms && (
        <div style={{ ...meta, marginTop: 12 }}>Condiciones: {sale.creditTerms}</div>
      )}
      <div className="nota-footer" style={{ ...meta, marginTop: 12, fontSize: 10 }}>
        Documento interno de entrega. La factura fiscal la emite la máquina homologada por el SENIAT.
      </div>
    </section>
  );
}

function Row({ label, usd, rate, strong }: { label: string; usd: number; rate: number; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <span className="nota-row-label" style={{ fontFamily: 'var(--font-sans)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: strong ? 'var(--color-ink)' : 'var(--color-thread)', fontWeight: strong ? 700 : 400 }}>
        {label}
      </span>
      <span style={{ textAlign: 'right' }}>
        <span className="nota-row-usd" style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 700 : 400, fontSize: strong ? 14 : 12 }}>
          {fmtUsd(usd)}
        </span>
        {rate > 0 && (
          <span className="nota-row-bs" style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-thread)' }}>
            {fmtBs(toBs(usd, rate))}
          </span>
        )}
      </span>
    </div>
  );
}

const sheet: React.CSSProperties = {
  backgroundColor: '#fff',
  border: '1px solid var(--color-thread)',
  borderRadius: 8,
  padding: '20px 24px',
  textAlign: 'left',
  color: 'var(--color-ink)',
};

const label: React.CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-thread)',
};

const value: React.CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 };

const meta: React.CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--color-thread)' };

const th: React.CSSProperties = {
  ...label, textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--color-thread)',
};

const td: React.CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: 12, padding: '5px 6px',
  borderBottom: '1px dashed rgba(138,131,113,0.35)', verticalAlign: 'top',
};
