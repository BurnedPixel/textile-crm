// Dashboard island — Panel page. PouchDB reads only (browser).
// O(1) stat reads via cached counters (Batch.currentUnits, Product.currentWeightKg).
// No movement ledger aggregation here. (CLAUDE.md: Dashboard reads must be O(1))

import { useState, useEffect, useRef, useCallback } from 'react';
import { db, dbReady, onDbChange } from '../../lib/db';
import { getConfig, getStockedBatches, getSales, getClients } from '../../lib/queries';
import { grandTotalUsd, SETTLED_EPSILON } from '../../lib/queries';
import {
  getPayments, paymentsBySale, saleBalance,
  getRefunds, refundsBySale,
} from '../../lib/payments';
import { getColorChart, chartColorByName, type ColorChartDoc } from '../../lib/catalog';
import { CollectDialog, RefundDialog } from '../shared/PaymentDialogs';
import {
  fmtUsd, fmtBs, fmtDateTime, toBs, round2, fmtLots,
  PAYMENT_LABEL, PAYMENT_TONE, PRODUCT_TYPE_LABEL, NM_LABEL,
} from '../../lib/format';
import {
  Badge,
  SwatchChip,
  Money,
  Kbd,
  EmptyState,
  Button,
  normStr,
} from '../ui';
import { hasRollStock } from '../../lib/types';
import type { SaleDoc, PaymentDoc, RefundDoc, ClientDoc, BatchDoc, ProductDoc, SystemConfigDoc } from '../../lib/types';

// ─── HELPERS ────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function isoToday(): string {
  return today;
}

/** Days between an ISO date string and today. Positive = past. */
function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

// Payment state is DERIVED — sale.paymentStatus is only the checkout snapshot,
// and every later collection is its own `payment:` doc. Reading the stored field
// would show debts that were settled weeks ago (see payments.ts).

// ─── DATA FETCH (raw, not via useLiveQuery — we need multiple queries at once) ─

interface DashboardData {
  config: SystemConfigDoc | null;
  stocked: Array<{ batch: BatchDoc; products: ProductDoc[] }>;
  todaySales: SaleDoc[];
  recentSales: SaleDoc[];
  pendingSales: SaleDoc[];
  /** Sales the business owes change on («saldo a favor del cliente»), unwindowed like pendings. */
  creditSales: SaleDoc[];
  /** Collections indexed by saleId — every payment read on this page goes through it. */
  paymentsFor: Map<string, PaymentDoc[]>;
  /** Refunds («vuelto entregado») indexed by saleId — same coverage as payments. */
  refundsFor: Map<string, RefundDoc[]>;
  clients: ClientDoc[];
  /** The colour chart — resolves a code for batches that predate `colorCode`. */
  chart: ColorChartDoc | null;
}

async function fetchAll(): Promise<DashboardData> {
  const todayStart = isoToday();

  // ponytail: one full sale scan per load is acceptable for typical factory
  // volume (<10k sales/yr). Not upgradable to a Mango index — pendingSales/
  // creditSales filter on owedUsd/creditUsd, derived at read from three doc
  // types, and only the frozen checkout snapshot is indexable. If perf
  // becomes an issue, the real upgrade path is a device-local `_local/`
  // rollup ({lastSeq, openSaleIds} advanced from db.changes since lastSeq,
  // rebuildable by a full scan; never replicates).
  // UNWINDOWED on purpose (2026-08-16): the INFORME import carries real
  // January dates, and a 90-day window hid those debts from «Cobros
  // pendientes» while /clientes (full ledger) showed them.
  const [config, stocked, allSales, allClients, payments, refunds, chart] = await Promise.all([
    getConfig(db),
    getStockedBatches(db),
    getSales(db, { descending: true }),
    getClients(db),
    // Every payment, not a windowed slice: a collection made today can settle a
    // sale from any date, and missing it would show a debt that is gone.
    getPayments(db),
    getRefunds(db),
    getColorChart(db),
  ]);
  const paymentsFor = paymentsBySale(payments);
  const refundsFor = refundsBySale(refunds);

  const todaySales = allSales.filter((s) => s.date.slice(0, 10) === todayStart);
  const recentSales = allSales.slice(0, 8);

  // DERIVED, not sale.paymentStatus — a sale settled by a later collection must
  // drop out of this list, and the sale doc itself can never be updated to say so.
  const pendingSales = allSales.filter(
    (s) => saleBalance(s, paymentsFor.get(s._id) ?? [], refundsFor.get(s._id) ?? []).status !== 'PAID',
  );
  const creditSales = allSales.filter(
    (s) => saleBalance(s, paymentsFor.get(s._id) ?? [], refundsFor.get(s._id) ?? []).creditUsd > SETTLED_EPSILON,
  );

  return {
    config, stocked, todaySales, recentSales, pendingSales, creditSales, paymentsFor, refundsFor,
    clients: allClients, chart,
  };
}

// ─── STAT CARD ───────────────────────────────────────────────────────────────

function StatCard({ label, primary, secondary }: { label: string; primary: string; secondary?: string }) {
  return (
    <div
      className="stat-card"
      style={{
        flex: '1 1 160px',
        minWidth: 0,
        padding: '16px 20px',
        background: 'var(--color-cloth)',
        border: '1px dashed var(--color-thread)',
        borderLeft: '3px solid var(--color-dye)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--color-thread)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '22px',
          fontWeight: 700,
          fontFeatureSettings: '"tnum" 1',
          color: 'var(--color-ink)',
          lineHeight: 1.1,
        }}
      >
        {primary}
      </span>
      {secondary && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            fontFeatureSettings: '"tnum" 1',
            color: 'var(--color-thread)',
          }}
        >
          {secondary}
        </span>
      )}
    </div>
  );
}

// ─── INVENTORY TABLE ──────────────────────────────────────────────────────────

/**
 * /venta with the batch's facets preselected (SaleTerminal reads these on
 * mount). NO trailing slash: the PWA precache manifest lists pages as bare
 * `venta` (how @vite-pwa/astro canonicalizes them under trailingSlash
 * 'ignore'), so `/venta/?…` misses the cache and the offline fallback serves
 * the PANEL — the click looks dead on an installed PWA. Verify URL-shape
 * changes with a service-worker-CONTROLLED browser, never a fresh profile.
 */
function ventaUrl(batch: BatchDoc): string {
  const p = new URLSearchParams({ color: batch.color, nm: batch.nm, fabric: batch.fabricType });
  return `/venta?${p}`;
}

/** /ventas with the sale preselected — same bare-path, no-trailing-slash rule as ventaUrl. */
function ventaHistorialUrl(sale: SaleDoc): string {
  return `/ventas?${new URLSearchParams({ sale: sale._id })}`;
}

interface InventoryTableProps {
  stocked: Array<{ batch: BatchDoc; products: ProductDoc[] }>;
  chart: ColorChartDoc | null;
}

function InventoryTable({ stocked, chart }: InventoryTableProps) {
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  // Stored code first; batches that predate the field (INFORME import, legacy)
  // resolve theirs from the colour chart by name.
  const codeOf = (b: BatchDoc) => b.colorCode ?? chartColorByName(chart, b.color)?.code;

  // Accent-insensitive: "pique" finds "Piqué", "azúl" finds "Azul".
  const filtered = filter.trim()
    ? stocked.filter(({ batch, products }) => {
        const q = normStr(filter);
        const code = codeOf(batch);
        return (
          normStr(batch.color).includes(q) ||
          (code ? normStr(code).includes(q) : false) ||
          normStr(batch.nm).includes(q) ||
          normStr(batch.fabricType).includes(q) ||
          (batch.location ? normStr(batch.location).includes(q) : false) ||
          // The lot is the number printed on the bundle — the one an operator
          // has in hand when they go looking for an artículo.
          products.some((p) => p.lotNumber && normStr(p.lotNumber).includes(q))
        );
      })
    : stocked;

  // Reset cursor when filter changes
  useEffect(() => { setCursor(-1); }, [filter]);

  // Arrow nav + Enter to /venta
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => {
          const next = Math.min(c + 1, filtered.length - 1);
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => {
          const next = Math.max(c - 1, 0);
          rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter' && cursor >= 0 && filtered[cursor]) {
        window.location.href = ventaUrl(filtered[cursor].batch);
      } else if (e.key === 'Escape') {
        setFilter('');
      }
    },
    [filtered, cursor],
  );

  function stockLabel(batch: BatchDoc, products: ProductDoc[]): string {
    if (batch.productType === 'ROLL') {
      const totalKg = products.reduce((s, p) => s + p.currentWeightKg, 0);
      const rolls = products.filter((p) => hasRollStock(p.currentWeightKg)).length;
      return `${rolls} rollo${rolls !== 1 ? 's' : ''} · ${totalKg.toFixed(2)} kg`;
    }
    return `${batch.currentUnits} ud`;
  }

  if (stocked.length === 0) {
    return (
      <EmptyState
        title="Sin inventario con stock disponible"
        action={<a href="/inventario"><Button variant="primary">Registrar ingreso</Button></a>}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Search input */}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          data-hotkey-search
          type="search"
          placeholder={`Filtrar artículos… Color, código, ${NM_LABEL}, tipo, nº de lote…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            fontFamily: 'var(--font-sans)',
            fontSize: '14px',
            color: 'var(--color-ink)',
            backgroundColor: 'var(--color-cloth)',
            border: '1.5px solid var(--color-thread)',
            borderRadius: '6px',
            padding: '0 40px 0 12px',
            minHeight: '44px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => ((e.target as HTMLInputElement).style.borderColor = 'var(--color-dye)')}
          onBlur={(e) => ((e.target as HTMLInputElement).style.borderColor = 'var(--color-thread)')}
        />
        <span
          style={{
            position: 'absolute',
            right: '10px',
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}
        >
          <Kbd>/</Kbd>
        </span>
      </div>

      {/* Table — reflows to stacked cards on phones (.table-cards) */}
      <div>
        <table
          className="table-cards inv-table"
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
          }}
        >
          <thead>
            <tr>
              {['Color', NM_LABEL, 'Tipo', 'Categoría', 'Stock', 'Lote', 'Ubicación'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--color-thread)',
                    borderBottom: '1px solid var(--color-thread)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ batch, products }, idx) => (
              <tr
                key={batch._id}
                ref={(el) => { rowRefs.current[idx] = el; }}
                onClick={() => { window.location.href = ventaUrl(batch); }}
                style={{
                  cursor: 'pointer',
                  background:
                    cursor === idx
                      ? 'rgba(181,23,92,0.07)'
                      : idx % 2 === 0
                        ? 'transparent'
                        : 'var(--color-cloth)',
                  outline: cursor === idx ? '2px solid var(--color-dye)' : 'none',
                  outlineOffset: '-2px',
                }}
              >
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <SwatchChip color={batch.color} size="sm" />
                  {codeOf(batch) && (
                    <span style={{ marginLeft: '6px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)' }}>
                      {codeOf(batch)}
                    </span>
                  )}
                </td>
                <td
                  style={{
                    padding: '10px 12px',
                    fontFamily: 'var(--font-mono)',
                    fontFeatureSettings: '"tnum" 1',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {batch.nm}
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  {batch.fabricType}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <Badge tone="neutral">{PRODUCT_TYPE_LABEL[batch.productType]}</Badge>
                </td>
                <td
                  style={{
                    padding: '10px 12px',
                    fontFamily: 'var(--font-mono)',
                    fontFeatureSettings: '"tnum" 1',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {stockLabel(batch, products)}
                </td>
                <td
                  style={{
                    padding: '10px 12px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    color: 'var(--color-dye)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtLots(batch.productType, products)}
                </td>
                <td style={{ padding: '10px 12px', color: 'var(--color-thread)', whiteSpace: 'nowrap' }}>
                  {batch.location || '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: '32px',
                    textAlign: 'center',
                    color: 'var(--color-thread)',
                    fontStyle: 'italic',
                  }}
                >
                  Sin resultados para "{filter}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <p
          className="kbd-hints"
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '11px',
            color: 'var(--color-thread)',
            margin: 0,
          }}
        >
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> navegar · <Kbd>↵</Kbd> ir a venta
        </p>
      )}
    </div>
  );
}

// ─── SIDE PANEL ───────────────────────────────────────────────────────────────

function Divider() {
  return (
    <hr
      style={{
        border: 'none',
        borderTop: '1px dashed var(--color-thread)',
        margin: '20px 0',
      }}
    />
  );
}

interface SideProps {
  recentSales: SaleDoc[];
  pendingSales: SaleDoc[];
  creditSales: SaleDoc[];
  paymentsFor: Map<string, PaymentDoc[]>;
  refundsFor: Map<string, RefundDoc[]>;
  clientMap: Map<string, string>;
  config: SystemConfigDoc | null;
  onCollect: (sale: SaleDoc, owedUsd: number) => void;
  onRefund: (sale: SaleDoc, creditUsd: number) => void;
}

function SidePanel({
  recentSales, pendingSales, creditSales, paymentsFor, refundsFor, clientMap, config, onCollect, onRefund,
}: SideProps) {
  const rate = config?.currentDailyRateBCV;

  function clientName(clientId: string | null): string {
    if (!clientId) return 'Contado';
    return clientMap.get(clientId) ?? 'Cliente';
  }

  const saleStatus = (sale: SaleDoc) =>
    saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []).status;

  return (
    <aside
      className="side-panel"
      style={{
        width: '280px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {/* Ventas recientes */}
      <section>
        <h2
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-thread)',
            margin: '0 0 12px',
          }}
        >
          Ventas recientes
        </h2>

        {recentSales.length === 0 ? (
          <EmptyState
            title="Sin ventas aún"
            action={<a href="/venta"><Button variant="ghost" size="md">Nueva venta</Button></a>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {recentSales.map((sale) => (
              <div
                key={sale._id}
                data-sale-row={sale._id}
                role="button"
                tabIndex={0}
                onClick={() => { window.location.href = ventaHistorialUrl(sale); }}
                onKeyDown={(e) => { if (e.key === 'Enter') window.location.href = ventaHistorialUrl(sale); }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '10px 12px',
                  background: 'var(--color-cloth)',
                  border: '1px dashed var(--color-thread)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '8px',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--color-ink)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    {clientName(sale.clientId)}
                  </span>
                  {/* Derived — a sale collected later is "Pagada" here even though
                      its own frozen paymentStatus still says PENDING. */}
                  <Badge tone={PAYMENT_TONE[saleStatus(sale)]}>{PAYMENT_LABEL[saleStatus(sale)]}</Badge>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '10px',
                      color: 'var(--color-thread)',
                    }}
                  >
                    {fmtDateTime(sale.date)}
                  </span>
                  {/* The rate locked on THIS sale, not today's. A sale from
                      Tuesday converted at Friday's rate shows bolívares nobody
                      ever charged — and disagrees with its own nota. (The
                      pending list below is different on purpose: an outstanding
                      balance is money owed TODAY, so it converts at today's.) */}
                  <Money usd={grandTotalUsd(sale)} rate={sale.exchangeRateBCV} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Divider />

      {/* Cobros pendientes */}
      <section>
        <h2
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--color-thread)',
            margin: '0 0 12px',
          }}
        >
          Cobros pendientes
        </h2>

        {pendingSales.length === 0 && creditSales.length === 0 ? (
          <p
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              color: 'var(--color-thread)',
              margin: 0,
              fontStyle: 'italic',
            }}
          >
            Sin cobros pendientes.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {pendingSales.map((sale) => {
              const owed = saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []).owedUsd;
              const days = daysSince(sale.date);
              return (
                <div
                  key={sale._id}
                  data-pending-sale={sale._id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    padding: '10px 12px',
                    background: 'var(--color-cloth)',
                    border: `1px dashed ${days > 30 ? 'var(--color-danger)' : 'var(--color-thread)'}`,
                    borderRadius: '6px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--color-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {clientName(sale.clientId)}
                    </span>
                    <Money usd={owed} rate={rate} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '10px',
                        color: days > 30 ? 'var(--color-danger)' : 'var(--color-thread)',
                      }}
                    >
                      {days === 0 ? 'Hoy' : `hace ${days}d`}
                    </span>
                    <Button variant="ghost" size="md" type="button" onClick={() => onCollect(sale, owed)}>
                      Registrar cobro
                    </Button>
                  </div>
                </div>
              );
            })}
            {creditSales.map((sale) => {
              const credit = saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []).creditUsd;
              const days = daysSince(sale.date);
              return (
                <div
                  key={sale._id}
                  data-credit-sale={sale._id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    padding: '10px 12px',
                    background: 'rgba(62,107,58,0.08)',
                    border: '1px solid rgba(62,107,58,0.25)',
                    borderLeft: '3px solid var(--color-ok)',
                    borderRadius: '6px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '12px',
                        fontWeight: 600,
                        color: 'var(--color-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {clientName(sale.clientId)}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '10px',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'var(--color-ok)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      A favor
                    </span>
                    <Money usd={credit} rate={rate} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '10px',
                        color: 'var(--color-thread)',
                      }}
                    >
                      {days === 0 ? 'Hoy' : `hace ${days}d`}
                    </span>
                    <Button variant="ghost" size="md" type="button" onClick={() => onRefund(sale, credit)}>
                      Entregar vuelto
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </aside>
  );
}

// ─── HEADER ──────────────────────────────────────────────────────────────────

function Header({ config }: { config: SystemConfigDoc | null }) {
  const todayLabel = new Intl.DateTimeFormat('es-VE', { dateStyle: 'full' }).format(new Date());
  // Age-based, not same-calendar-day: the rate is written at 07:00 Caracas and
  // clients run in any timezone (UTC-day equality false-alarmed every Caracas
  // evening and all weekend — BCV publishes nothing Sat/Sun, so ≥3 days ≈ a
  // genuinely missed refresh, not a weekend).
  const rateStale = config ? daysSince(config.lastUpdate) >= 3 : false;

  return (
    <div
      className="panel-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        marginBottom: '28px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <h1
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '22px',
            fontWeight: 800,
            fontStretch: '125%',
            textTransform: 'uppercase',
            letterSpacing: '-0.02em',
            color: 'var(--color-ink)',
            margin: 0,
          }}
        >
          Panel
        </h1>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            color: 'var(--color-thread)',
            textTransform: 'capitalize',
          }}
        >
          {todayLabel}
        </span>
      </div>

      {/* BCV rate chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        {config ? (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              fontFeatureSettings: '"tnum" 1',
              padding: '6px 12px',
              background: 'var(--color-cloth)',
              border: '1px solid var(--color-thread)',
              borderRadius: '6px',
              color: 'var(--color-ink)',
              whiteSpace: 'nowrap',
            }}
          >
            {config.currentDailyRateBCV.toFixed(2)}{' '}
            <span style={{ color: 'var(--color-thread)', fontSize: '11px' }}>Bs/$</span>
          </div>
        ) : (
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
            Sin tasa
          </span>
        )}
        {rateStale && (
          <a href="/configuracion" style={{ textDecoration: 'none' }}>
            <Badge tone="warn">Tasa desactualizada</Badge>
          </a>
        )}
        {!config && (
          <a href="/configuracion" style={{ textDecoration: 'none' }}>
            <Badge tone="danger">Configurar tasa</Badge>
          </a>
        )}
      </div>
    </div>
  );
}

// ─── ROOT DASHBOARD ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [collecting, setCollecting] = useState<{ sale: SaleDoc; owedUsd: number } | null>(null);
  const [refunding, setRefunding] = useState<{ sale: SaleDoc; creditUsd: number } | null>(null);

  // The 150ms debounce (onDbChange) is shorter than a full include_docs scan,
  // so overlapping loads can resolve out of order. A monotonic generation
  // counter drops any setData that isn't from the latest load — otherwise a
  // stale run can overwrite a settled debt back onto the Panel.
  const generationRef = useRef(0);
  const load = useCallback(() => {
    const generation = ++generationRef.current;
    void fetchAll()
      .then((result) => {
        if (generation === generationRef.current) setData(result);
      })
      .catch((err) => console.error('[Dashboard]', err));
  }, []);

  useEffect(() => {
    void dbReady.then(load);
    const off = onDbChange(load);
    return off;
  }, [load]);

  if (!data) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '200px',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          color: 'var(--color-thread)',
        }}
      >
        Cargando…
      </div>
    );
  }

  const { config, stocked, todaySales, recentSales, pendingSales, creditSales, paymentsFor, refundsFor, clients, chart } = data;
  const rate = config?.currentDailyRateBCV;

  // Client id → name map (single pass)
  const clientMap = new Map<string, string>(clients.map((c) => [c._id, c.name]));

  // Stat: Ventas de hoy
  const todayCount = todaySales.length;
  // Grand total, like every other money figure: the pre-tax total is what the
  // document stores, never what the client owes.
  const todayUsd = round2(todaySales.reduce((s, sale) => s + grandTotalUsd(sale), 0));
  // Sum each sale's Bs using its own locked rate (immutability rule)
  const todayBs = todaySales.reduce((s, sale) => s + toBs(grandTotalUsd(sale), sale.exchangeRateBCV), 0);

  // Stat: Por cobrar — derived from the ledger, not sale.paymentStatus.
  const receivableUsd = round2(
    pendingSales.reduce(
      (s, sale) => s + saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []).owedUsd,
      0,
    ),
  );


  // Stat: Por devolver — the mirror of receivableUsd, money owed TO the client.
  const refundableUsd = round2(
    creditSales.reduce(
      (s, sale) => s + saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []).creditUsd,
      0,
    ),
  );

  // Stat: Artículos con stock
  const stockedItems = stocked.length;

  // Stat: Inventario — ROLL in Kg, units in Units. Two separate figures.
  const totalKg = stocked
    .filter(({ batch }) => batch.productType === 'ROLL')
    .flatMap(({ products }) => products)
    .reduce((s, p) => s + p.currentWeightKg, 0);
  const totalUnits = stocked
    .filter(({ batch }) => batch.productType !== 'ROLL')
    .reduce((s, { batch }) => s + batch.currentUnits, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1400px' }}>
      <Header config={config} />

      {/* Stat row */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <StatCard
          label="Ventas de hoy"
          primary={todayCount === 0 ? '0' : `${todayCount} venta${todayCount !== 1 ? 's' : ''}`}
          secondary={
            todayCount > 0
              ? `${fmtUsd(todayUsd)}${rate ? ` · ${fmtBs(todayBs)}` : ''}`
              : undefined
          }
        />
        <StatCard
          label="Por cobrar"
          primary={fmtUsd(receivableUsd)}
          secondary={
            refundableUsd > SETTLED_EPSILON
              ? `Por devolver: ${fmtUsd(refundableUsd)}`
              : rate ? fmtBs(toBs(receivableUsd, rate)) : undefined
          }
        />
        <StatCard label="Artículos con stock" primary={String(stockedItems)} />
        <StatCard
          label="Inventario"
          primary={`${totalKg.toFixed(2)} kg`}
          secondary={totalUnits > 0 ? `${totalUnits} ud` : undefined}
        />
      </div>

      {/* Main area: inventory table + side panel */}
      <div
        style={{
          display: 'flex',
          gap: '32px',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        {/* Inventory table */}
        <div style={{ flex: '1 1 500px', minWidth: 0 }}>
          <h2
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--color-thread)',
              margin: '0 0 12px',
            }}
          >
            Inventario
          </h2>
          <InventoryTable stocked={stocked} chart={chart} />
        </div>

        {/* Side panel */}
        <SidePanel
          recentSales={recentSales}
          pendingSales={pendingSales}
          creditSales={creditSales}
          paymentsFor={paymentsFor}
          refundsFor={refundsFor}
          clientMap={clientMap}
          config={config}
          onCollect={(sale, owedUsd) => setCollecting({ sale, owedUsd })}
          onRefund={(sale, creditUsd) => setRefunding({ sale, creditUsd })}
        />
      </div>

      {collecting && (
        <CollectDialog
          sale={collecting.sale}
          owedUsd={collecting.owedUsd}
          rate={rate}
          clientName={collecting.sale.clientId ? clientMap.get(collecting.sale.clientId) ?? 'Cliente' : 'Contado'}
          onClose={() => setCollecting(null)}
        />
      )}

      {refunding && (
        <RefundDialog
          sale={refunding.sale}
          creditUsd={refunding.creditUsd}
          rate={rate}
          clientName={refunding.sale.clientId ? clientMap.get(refunding.sale.clientId) ?? 'Cliente' : 'Contado'}
          onClose={() => setRefunding(null)}
        />
      )}
    </div>
  );
}
