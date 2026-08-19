// Ventas page island — unwindowed sales history + reachable nota de entrega.
// UI: SPANISH. Code/fields: ENGLISH.
//
// Unlike the Panel's 90-day "Ventas recientes"/"Cobros pendientes" lists, this
// page is deliberately the un-windowed surface: getSales() with no date bounds.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../../lib/db';
import { getSales, getClients, getFiscalConfig, grandTotalUsd, SETTLED_EPSILON } from '../../lib/queries';
import { getPayments, getRefunds, paymentsBySale, refundsBySale, saleBalance } from '../../lib/payments';
import { useLiveQuery } from '../../lib/hooks';
import { fmtDate, fmtDateTime, PAYMENT_LABEL } from '../../lib/format';
import { Button, Combobox, EmptyState, Money, Select } from '../ui';
import NotaEntrega from '../venta/NotaEntrega.tsx';
import type { SaleDoc, PaymentDoc, RefundDoc } from '../../lib/types';

type EstadoFilter = 'ALL' | 'PENDING' | 'PAID' | 'CREDIT';

const ESTADO_OPTIONS: { value: EstadoFilter; label: string }[] = [
  { value: 'ALL',     label: 'Todas' },
  { value: 'PENDING', label: 'Pendientes' },
  { value: 'PAID',    label: 'Pagadas' },
  { value: 'CREDIT',  label: 'A favor del cliente' },
];

const CONTADO = 'Contado';

const PAYMENT_TAG: Record<'PAID' | 'PARTIAL' | 'PENDING', string> = {
  PAID: 'tag-sage',
  PARTIAL: 'tag-lavender',
  PENDING: 'tag-rose',
};

export default function VentasIsland() {
  // ---- Filters ----
  const [month, setMonth] = useState('');           // empty = all history
  const [clientFilter, setClientFilter] = useState('');
  const [estado, setEstado] = useState<EstadoFilter>('ALL');

  // ---- Live data (unwindowed, descending — deliberate: no date bounds) ----
  // Collapsed into one useLiveQuery (was 5) so a single DB change fires one
  // re-run instead of five — same pattern as ClientsPage's combined ledger read.
  const { data: ledgerData } = useLiveQuery(async (d) => {
    const [sales, payments, refunds, clients, fiscal] = await Promise.all([
      getSales(d),
      getPayments(d),
      getRefunds(d),
      getClients(d),
      getFiscalConfig(d),
    ]);
    return { sales, payments, refunds, clients, fiscal };
  });
  const { sales, payments, refunds, clients, fiscal } = ledgerData ?? {
    sales: undefined,
    payments: undefined,
    refunds: undefined,
    clients: undefined,
    fiscal: undefined,
  };

  const paymentsFor = useMemo(() => paymentsBySale(payments ?? []), [payments]);
  const refundsFor = useMemo(() => refundsBySale(refunds ?? []), [refunds]);
  const clientById = useMemo(() => new Map((clients ?? []).map((c) => [c._id, c])), [clients]);

  const clientName = (clientId: string | null): string =>
    (clientId && clientById.get(clientId)?.name) || CONTADO;

  const clientOptions = useMemo(
    () => [CONTADO, ...(clients ?? []).map((c) => c.name)],
    [clients],
  );

  const balanceOf = (sale: SaleDoc) => saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []);

  // ---- Filtered list ----
  const filtered = useMemo(() => {
    const q = clientFilter.trim().toLowerCase();
    return (sales ?? []).filter((sale) => {
      if (month && !sale.date.slice(0, 7).startsWith(month)) return false;
      if (q) {
        const name = clientName(sale.clientId).toLowerCase();
        if (q === CONTADO.toLowerCase()) {
          if (sale.clientId !== null) return false;
        } else if (!name.includes(q)) {
          return false;
        }
      }
      if (estado !== 'ALL') {
        const b = balanceOf(sale);
        if (estado === 'PENDING' && !(b.owedUsd > SETTLED_EPSILON)) return false;
        if (estado === 'PAID' && !(b.status === 'PAID' && b.creditUsd <= SETTLED_EPSILON)) return false;
        if (estado === 'CREDIT' && !(b.creditUsd > SETTLED_EPSILON)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, month, clientFilter, estado, paymentsFor, refundsFor, clientById]);

  const totalUsd = useMemo(
    () => filtered.reduce((acc, s) => acc + grandTotalUsd(s), 0),
    [filtered],
  );

  // ---- Selection + deep link (?sale=…) ----
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deepLinked = useRef(false);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('sale');
    if (id) { deepLinked.current = true; setSelectedId(id); }
  }, []);

  const selectedSale = useMemo(
    () => (sales ?? []).find((s) => s._id === selectedId) ?? null,
    [sales, selectedId],
  );
  // The detail expands in place under the clicked row, so only a deep link
  // (?sale=… — the row may be far down the unwindowed list) needs a scroll.
  useEffect(() => {
    if (selectedSale && deepLinked.current) {
      deepLinked.current = false;
      document.querySelector(`[data-sale-row="${CSS.escape(selectedSale._id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedSale]);
  const selectedClient = selectedSale ? clientById.get(selectedSale.clientId ?? '') ?? null : null;
  const selectedPayments = selectedSale ? paymentsFor.get(selectedSale._id) ?? [] : [];
  const selectedRefunds = selectedSale ? refundsFor.get(selectedSale._id) ?? [] : [];
  const selectedBalance = selectedSale
    ? saleBalance(selectedSale, selectedPayments, selectedRefunds)
    : null;

  const [sharingPdf, setSharingPdf] = useState(false);

  /** Mirrors SaleTerminal's "Compartir PDF" handler verbatim. */
  async function handleSharePdf(): Promise<void> {
    if (!selectedSale) return;
    setSharingPdf(true);
    try {
      const { buildNotaPdf } = await import('../../lib/nota-pdf');
      const buf = buildNotaPdf(selectedSale, selectedClient, fiscal ?? null);
      const file = new File([buf], `nota-${selectedSale.transactionId.slice(0, 8)}.pdf`, {
        type: 'application/pdf',
      });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Nota de entrega' });
        } catch (err) {
          if ((err as Error).name !== 'AbortError') throw err;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('nota PDF', err);
    } finally {
      setSharingPdf(false);
    }
  }

  return (
    <div style={{ maxWidth: '1000px' }}>
      {/* Page header */}
      <div className="no-print" style={{ marginBottom: '1.75rem' }}>
        <h1 className="title-display" style={{ margin: 0 }}>
          Ventas
        </h1>
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginTop: '4px' }}>
          Histórico completo de ventas. Selecciona una para ver o compartir su nota de entrega.
        </p>
      </div>

      {/* Filters */}
      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '14px', marginBottom: '1.25rem' }}>
        <div>
          <label className="micro-label" style={filterLabel}>Mes</label>
          <input
            type="month"
            data-filter-month
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: '"tnum" 1', fontSize: '14px', color: 'var(--color-ink)', background: 'var(--color-cloth)', border: '1.5px solid var(--color-thread)', borderRadius: '6px', padding: '6px 12px', outline: 'none', cursor: 'pointer', display: 'block' }}
          />
        </div>

        <div style={{ minWidth: '220px' }}>
          <label className="micro-label" style={filterLabel}>Cliente</label>
          <Combobox
            data-filter-client
            data-hotkey-search
            value={clientFilter}
            onChange={setClientFilter}
            options={clientOptions}
            placeholder="Todos los clientes…"
          />
        </div>

        <div>
          <label className="micro-label" style={filterLabel}>Estado</label>
          <Select data-filter-estado value={estado} onChange={(e) => setEstado(e.target.value as EstadoFilter)}>
            {ESTADO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
      </div>

      {/* Sales table */}
      {filtered.length === 0 ? (
        <EmptyState title="Sin ventas para este filtro" />
      ) : (
        // NOT no-print: the expanded nota lives inside this wrapper, and display:none
        // on an ancestor would blank the printout — print CSS hides via visibility.
        <div className="print-collapse" style={{ background: 'var(--color-cloth)', border: '1px solid var(--color-bone)', borderRadius: '8px', overflow: 'hidden', marginBottom: '1.5rem' }}>
          <table className="table-cards" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-thread)' }}>
                {['Fecha', 'Cliente', 'Total', 'Estado'].map((h) => (
                  <th key={h} style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-thread)', padding: '10px 14px', textAlign: h === 'Total' || h === 'Estado' ? 'right' : 'left' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((sale, i) => {
                const b = balanceOf(sale);
                const isCredit = b.creditUsd > SETTLED_EPSILON;
                const isOpen = selectedId === sale._id;
                const toggle = () => setSelectedId(isOpen ? null : sale._id);
                return (
                  <Fragment key={sale._id}>
                  <tr
                    data-sale-row={sale._id}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={toggle}
                    onKeyDown={(e) => { if (e.key === 'Enter') toggle(); }}
                    style={{
                      borderBottom: !isOpen && i < filtered.length - 1 ? '1px solid color-mix(in srgb, var(--color-thread) 15%, transparent)' : 'none',
                      cursor: 'pointer',
                      background: isOpen ? 'color-mix(in srgb, var(--color-dye) 6%, transparent)' : undefined,
                    }}
                  >
                    <td style={tdStyle}>{fmtDateTime(sale.date)}</td>
                    <td style={tdStyle}>{clientName(sale.clientId)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <Money usd={grandTotalUsd(sale)} rate={sale.exchangeRateBCV} />
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      {isCredit ? (
                        <span className="tag tag-credit">A favor {b.creditUsd.toFixed(2)} $</span>
                      ) : (
                        <span className={`tag ${PAYMENT_TAG[b.status]}`}>{PAYMENT_LABEL[b.status]}</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && selectedSale && selectedBalance && (
                    <tr>
                      <td colSpan={4} style={{ padding: '0 14px 14px', borderBottom: i < filtered.length - 1 ? '1px solid color-mix(in srgb, var(--color-thread) 15%, transparent)' : 'none' }}>
                        <div data-sale-detail style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                          <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {selectedBalance.owedUsd > SETTLED_EPSILON ? (
                                <span className="tag tag-rose">Saldo pendiente {selectedBalance.owedUsd.toFixed(2)} $</span>
                              ) : selectedBalance.creditUsd > SETTLED_EPSILON ? (
                                <span className="tag tag-credit">A favor del cliente {selectedBalance.creditUsd.toFixed(2)} $</span>
                              ) : (
                                <span className="tag tag-sage">Pagada</span>
                              )}
                            </div>
                            <Button variant="ghost" size="md" onClick={() => setSelectedId(null)}>Cerrar</Button>
                          </div>

                          {/* Cobros y vueltos */}
                          {(selectedPayments.length > 0 || selectedRefunds.length > 0) && (
                            <div className="no-print" style={{ background: 'var(--color-greige)', border: '1px solid var(--color-bone)', borderRadius: '8px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <span className="micro-label">
                                Cobros y vueltos
                              </span>
                              {[...selectedPayments.map((p) => ({ ...p, kind: 'Cobro' as const })), ...selectedRefunds.map((r) => ({ ...r, kind: 'Vuelto entregado' as const }))]
                                .sort((a, b2) => a.date.localeCompare(b2.date))
                                .map((entry: (PaymentDoc | RefundDoc) & { kind: string }) => (
                                  <div key={entry._id} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-ink)' }}>
                                    <span>{entry.kind} — {fmtDate(entry.date)}{entry.note ? ` (${entry.note})` : ''}</span>
                                  </div>
                                ))}
                            </div>
                          )}

                          <NotaEntrega sale={selectedSale} client={selectedClient} fiscal={fiscal ?? null} />

                          <div className="no-print" style={{ display: 'flex', gap: '12px' }}>
                            <Button variant="ghost" size="lg" onClick={() => window.print()}>
                              Imprimir nota
                            </Button>
                            <Button variant="ghost" size="lg" data-share-pdf disabled={sharingPdf} onClick={handleSharePdf}>
                              {sharingPdf ? 'Generando…' : 'Compartir PDF'}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          {/* Footer totals */}
          <div style={{ borderTop: '1px solid var(--color-thread)', padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
              {filtered.length} venta{filtered.length !== 1 ? 's' : ''}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="micro-label">
                Total
              </span>
              <Money usd={totalUsd} />
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

const filterLabel: React.CSSProperties = { display: 'block', marginBottom: '4px' };

const tdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '13px',
  color: 'var(--color-ink)',
  padding: '10px 14px',
  verticalAlign: 'middle',
};
