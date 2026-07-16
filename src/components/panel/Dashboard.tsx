// Dashboard island — Panel page. PouchDB reads only (browser).
// O(1) stat reads via cached counters (Batch.currentUnits, Product.currentWeightKg).
// No movement ledger aggregation here. (CLAUDE.md: Dashboard reads must be O(1))

import { useState, useEffect, useRef, useCallback } from 'react';
import { db, dbReady, onDbChange } from '../../lib/db';
import { getConfig, getStockedBatches, getSales, getClients } from '../../lib/queries';
import { fmtUsd, fmtBs, fmtDate, fmtDateTime, toBs, round2 } from '../../lib/format';
import {
  Badge,
  SwatchChip,
  Money,
  Kbd,
  EmptyState,
  Button,
  normStr,
} from '../ui';
import type { SaleDoc, ClientDoc, BatchDoc, ProductDoc, SystemConfigDoc } from '../../lib/types';

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

function paymentTone(status: string): 'ok' | 'warn' | 'danger' {
  if (status === 'PAID') return 'ok';
  if (status === 'PARTIAL') return 'warn';
  return 'danger';
}

function paymentLabel(status: string): string {
  if (status === 'PAID') return 'Pagada';
  if (status === 'PARTIAL') return 'Parcial';
  return 'Pendiente';
}

function productTypeBadge(pt: string): string {
  if (pt === 'ROLL') return 'Rollo';
  if (pt === 'COMBO') return 'Combo';
  return 'Pieza';
}

/** Remaining USD owed on a sale (uses sale's locked rate for Bs conversion). */
function remainingUsd(sale: SaleDoc): number {
  const paidUsd =
    sale.paidUsdCash +
    sale.paidUsdTransfer +
    (sale.exchangeRateBCV > 0 ? sale.paidBs / sale.exchangeRateBCV : 0);
  return Math.max(0, sale.totalUsd - paidUsd);
}

// ─── DATA FETCH (raw, not via useLiveQuery — we need multiple queries at once) ─

interface DashboardData {
  config: SystemConfigDoc | null;
  stocked: Array<{ batch: BatchDoc; products: ProductDoc[] }>;
  todaySales: SaleDoc[];
  recentSales: SaleDoc[];
  pendingSales: SaleDoc[];
  clients: ClientDoc[];
}

async function fetchAll(): Promise<DashboardData> {
  const todayStart = isoToday();
  const [config, stocked, todaySales, recentSales, allClients] = await Promise.all([
    getConfig(db),
    getStockedBatches(db),
    getSales(db, { startDate: todayStart, endDate: todayStart, descending: true }),
    getSales(db, { limit: 8, descending: true }),
    getClients(db),
  ]);

  // Pending/partial sales — scan recent 90 days to avoid unbounded scan.
  // ponytail: scanning ~90d of sales is acceptable for typical factory volume (<10k sales/yr).
  // Upgrade to a Mango index on paymentStatus if perf becomes an issue.
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const historicSales = await getSales(db, { startDate: cutoff, descending: true });
  const pendingSales = historicSales.filter(
    (s) => s.paymentStatus === 'PENDING' || s.paymentStatus === 'PARTIAL',
  );

  return { config, stocked, todaySales, recentSales, pendingSales, clients: allClients };
}

// ─── STAT CARD ───────────────────────────────────────────────────────────────

function StatCard({ label, primary, secondary }: { label: string; primary: string; secondary?: string }) {
  return (
    <div
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

/** /venta with the batch's facets preselected (SaleTerminal reads these on mount). */
function ventaUrl(batch: BatchDoc): string {
  const p = new URLSearchParams({ color: batch.color, nm: batch.nm, fabric: batch.fabricType });
  return `/venta?${p}`;
}

interface InventoryTableProps {
  stocked: Array<{ batch: BatchDoc; products: ProductDoc[] }>;
}

function InventoryTable({ stocked }: InventoryTableProps) {
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  // Accent-insensitive: "pique" finds "Piqué", "azúl" finds "Azul".
  const filtered = filter.trim()
    ? stocked.filter(({ batch }) => {
        const q = normStr(filter);
        return (
          normStr(batch.color).includes(q) ||
          normStr(batch.nm).includes(q) ||
          normStr(batch.fabricType).includes(q) ||
          (batch.location ? normStr(batch.location).includes(q) : false)
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
      const rolls = products.filter((p) => p.currentWeightKg > 0).length;
      return `${rolls} rollo${rolls !== 1 ? 's' : ''} · ${totalKg.toFixed(2)} kg`;
    }
    return `${batch.currentUnits} ud`;
  }

  if (stocked.length === 0) {
    return (
      <EmptyState
        title="Sin inventario con stock disponible"
        action={<a href="/ingreso"><Button variant="primary">Registrar ingreso</Button></a>}
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
          placeholder="Filtrar lotes… Color, NM, tipo…"
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
              {['Color', 'NM', 'Tipo', 'Categoría', 'Stock', 'Ubicación'].map((h) => (
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
                  <Badge tone="neutral">{productTypeBadge(batch.productType)}</Badge>
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
                <td style={{ padding: '10px 12px', color: 'var(--color-thread)', whiteSpace: 'nowrap' }}>
                  {batch.location || '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
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
  clientMap: Map<string, string>;
  config: SystemConfigDoc | null;
}

function SidePanel({ recentSales, pendingSales, clientMap, config }: SideProps) {
  const rate = config?.currentDailyRateBCV;

  function clientName(clientId: string | null): string {
    if (!clientId) return 'Contado';
    return clientMap.get(clientId) ?? 'Cliente';
  }

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
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '10px 12px',
                  background: 'var(--color-cloth)',
                  border: '1px dashed var(--color-thread)',
                  borderRadius: '6px',
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
                  <Badge tone={paymentTone(sale.paymentStatus)}>
                    {paymentLabel(sale.paymentStatus)}
                  </Badge>
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
                  <Money usd={sale.totalUsd} rate={rate} />
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

        {pendingSales.length === 0 ? (
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
              const owed = remainingUsd(sale);
              const days = daysSince(sale.date);
              return (
                <div
                  key={sale._id}
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
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '10px',
                      color: days > 30 ? 'var(--color-danger)' : 'var(--color-thread)',
                    }}
                  >
                    {days === 0 ? 'Hoy' : `hace ${days}d`}
                  </span>
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

  const load = useCallback(() => {
    void fetchAll().then(setData).catch((err) => console.error('[Dashboard]', err));
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

  const { config, stocked, todaySales, recentSales, pendingSales, clients } = data;
  const rate = config?.currentDailyRateBCV;

  // Client id → name map (single pass)
  const clientMap = new Map<string, string>(clients.map((c) => [c._id, c.name]));

  // Stat: Ventas de hoy
  const todayCount = todaySales.length;
  const todayUsd = round2(todaySales.reduce((s, sale) => s + sale.totalUsd, 0));
  // Sum each sale's Bs using its own locked rate (immutability rule)
  const todayBs = todaySales.reduce((s, sale) => s + toBs(sale.totalUsd, sale.exchangeRateBCV), 0);

  // Stat: Por cobrar
  const receivableUsd = round2(pendingSales.reduce((s, sale) => s + remainingUsd(sale), 0));

  // Stat: Lotes con stock
  const stockedLotes = stocked.length;

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
          secondary={rate ? fmtBs(toBs(receivableUsd, rate)) : undefined}
        />
        <StatCard label="Lotes con stock" primary={String(stockedLotes)} />
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
          <InventoryTable stocked={stocked} />
        </div>

        {/* Side panel */}
        <SidePanel
          recentSales={recentSales}
          pendingSales={pendingSales}
          clientMap={clientMap}
          config={config}
        />
      </div>
    </div>
  );
}
