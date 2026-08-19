// Informes page island — read-only weekly/monthly reports over existing data.
// USD-first: summaries are never converted at today's rate (mixed historical
// rates make a single Bs total a lie). Nómina section only for isAdmin(), and
// only if buildPayrollSummary succeeds — a failure hides the section rather
// than breaking the page. UI: SPANISH. Code/fields: ENGLISH.
// Export is .xlsx (buildInformeSheets + buildXlsx) — no PDF, no print.

import { useEffect, useMemo, useState } from 'react';
import { db } from '../../lib/db';
import { nominaDb } from '../../lib/nominadb';
import { isAdmin } from '../../lib/auth';
import {
  weekPeriod, monthPeriod, customPeriod, periodOf, shiftPeriod, buildReport, buildPayrollSummary, PERIOD_KIND_LABEL, fromIsoDate, toIsoDate,
  type PeriodKind, type ReportPeriod, type ReportData, type PayrollSummary,
} from '../../lib/report';
import { buildInformeSheets } from '../../lib/informe-xlsx';
import { buildXlsx, type SheetSpec } from '../../lib/xlsx';
import { fmtUsd, fmtKg, fmtUnits } from '../../lib/format';
import { Button, Input, Kbd, Money } from '../ui';
import { ChartCard, SalesLegend, SalesLineChart, BarList, CHART_VIOLET, CHART_BRASS } from '../panel/charts';

// Accent-insensitive row filter for the on-screen data table. Distinct from
// types.ts `norm()` (which also folds ':'/'/'/spaces into dashes for _id
// safety) — here we just want case/accent-insensitive substring matching.
const normText = (v: unknown): string =>
  String(v ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const ROW_CAP = 200;

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PERIOD_KINDS = Object.keys(PERIOD_KIND_LABEL) as PeriodKind[];
const SHORT_KIND: Record<PeriodKind, string> = {
  DAY: '1D', WEEK: '1S', MONTH: '1M', QUARTER: '3M', HALF: '6M', YEAR: '1A', CUSTOM: 'Rango',
};

// null = no comparable base (an empty previous period is not "+100%" growth).
function variance(current: number, previous: number): { text: string; positive: boolean } | null {
  if (previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return { text: `${sign}${pct.toFixed(0)}%`, positive: pct >= 0 };
}

export default function InformesIsland() {
  const [kind, setKind] = useState<PeriodKind>('WEEK');
  const [period, setPeriod] = useState<ReportPeriod>(() => weekPeriod(new Date()));
  const [report, setReport] = useState<ReportData | null>(null);
  const [payroll, setPayroll] = useState<PayrollSummary | null>(null);
  const [exporting, setExporting] = useState(false);
  const admin = isAdmin();
  // «Hoy» doubles as the indicator: filled when the period on screen contains today.
  const todayIso = toIsoDate(new Date());
  const showsToday = period.start <= todayIso && todayIso <= period.end;

  // Sheets power BOTH the on-screen "Datos" table and the Excel export — one
  // scan, cached per period key, so switching sheets/filtering never re-hits
  // the db and the export button reuses whatever is already loaded.
  const [sheets, setSheets] = useState<SheetSpec[] | null>(null);
  const [sheetsKey, setSheetsKey] = useState<string | null>(null);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const periodKey = `${period.start}_${period.end}`;

  useEffect(() => {
    let cancelled = false;
    buildReport(db, period).then((r) => { if (!cancelled) setReport(r); });
    if (admin) {
      buildPayrollSummary(nominaDb(), period)
        .then((p) => { if (!cancelled) setPayroll(p); })
        .catch(() => { if (!cancelled) setPayroll(null); });
    } else {
      setPayroll(null);
    }
    return () => { cancelled = true; };
  }, [period, admin]);

  // Datos section stays open across a period jump; refresh its cached sheets
  // when the period moves out from under it (guarded on sheetsKey so an
  // already-cached period doesn't re-scan on every render).
  useEffect(() => {
    if (dataOpen && report && sheetsKey !== periodKey) ensureSheets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataOpen, periodKey, report]);

  // A kind switch aligns to the PERIOD being viewed — its first day — never to
  // today's date: looking at «Año 2026» and pressing Semana lands on the first
  // week of that year, not on whatever week today happens to fall in. CUSTOM has
  // no natural container, so it keeps the exact range and the two date inputs
  // beside the chips take over.
  function switchKind(next: PeriodKind) {
    setKind(next);
    setPeriod(next === 'CUSTOM' ? customPeriod(period.start, period.end) : periodOf(next, fromIsoDate(period.start)));
  }

  // Returns the sheets for the CURRENT period, reusing the cache if it's
  // already loaded (Datos section open, or a re-export without a period
  // change) instead of re-scanning the whole db.
  async function ensureSheets(): Promise<SheetSpec[]> {
    if (sheets && sheetsKey === periodKey) return sheets;
    setSheetsLoading(true);
    try {
      const s = await buildInformeSheets(db, period, report!, admin ? nominaDb() : null);
      setSheets(s);
      setSheetsKey(periodKey);
      setSheetName((prev) => (prev && s.some((sh) => sh.name === prev)) ? prev : s[0]?.name ?? null);
      return s;
    } finally {
      setSheetsLoading(false);
    }
  }

  async function handleExportExcel() {
    if (!report) return;
    setExporting(true);
    try {
      const exportSheets = await ensureSheets();
      const bytes = buildXlsx(exportSheets);
      const name = `informe-${report.period.start}_${report.period.end}.xlsx`;
      const file = new File([bytes as BlobPart], name, { type: XLSX_TYPE });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Informe' });
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
      console.error('informe xlsx', err);
    } finally {
      setExporting(false);
    }
  }

  // Jump straight to a period with the platform's own picker. It replaced a
  // modal with month/quarter/half/year grids: one native control does the
  // same job for every kind, and on a phone it opens the OS date wheel.
  const jumpControl = kind === 'CUSTOM' ? (
    <>
      {/* The bound you type STAYS where you typed it: pushing the other one
          instead of letting customPeriod swap them, which made your date
          jump to the opposite box. */}
      <input
        type="date" aria-label="Desde" value={period.start} max={period.end}
        onChange={(e) => { const v = e.target.value;
          if (v) setPeriod(customPeriod(v, v > period.end ? v : period.end)); }}
      />
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>a</span>
      <input
        type="date" aria-label="Hasta" value={period.end} min={period.start}
        onChange={(e) => { const v = e.target.value;
          if (v) setPeriod(customPeriod(v < period.start ? v : period.start, v)); }}
      />
    </>
  ) : kind === 'MONTH' ? (
    <input
      type="month" aria-label="Ir al mes" value={period.start.slice(0, 7)}
      onChange={(e) => e.target.value && setPeriod(monthPeriod(fromIsoDate(`${e.target.value}-01`)))}
    />
  ) : (
    <input
      type="date" aria-label="Ir a la fecha" value={period.start}
      onChange={(e) => e.target.value && setPeriod(periodOf(kind, fromIsoDate(e.target.value)))}
    />
  );

  const selectedSheet = sheets?.find((s) => s.name === sheetName) ?? null;
  const filteredRows = useMemo(() => {
    if (!selectedSheet) return [];
    const q = normText(filterText.trim());
    if (!q) return selectedSheet.rows;
    return selectedSheet.rows.filter((row) => row.some((cell) => normText(cell).includes(q)));
  }, [selectedSheet, filterText]);

  if (!report) return null;

  const salesVar = variance(report.sales.grandTotalUsd, report.previous.grandTotalUsd);
  const countVar = variance(report.sales.count, report.previous.count);
  const expensesVar = variance(report.expenses.totalUsd, report.previous.expensesTotalUsd);
  const collectedVar = variance(report.collections.collectedUsd, report.previous.collectedUsd);

  return (
    <div className="informe-report" style={{ maxWidth: '860px' }}>
      <div style={{ marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-display" style={{ margin: 0 }}>
            Informes
          </h1>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginTop: '4px' }}>
            Desempeño y datos de ventas, cobros, gastos y movimientos. <span className="kbd-hints"><Kbd>g r</Kbd></span>
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <Button variant="ghost" size="lg" onClick={handleExportExcel} disabled={exporting}>
            {exporting ? 'Generando…' : 'Exportar Excel'}
          </Button>
        </div>
      </div>

      {/* ---- Quote block: big total + variance, then period context ---- */}
      <div style={{ marginBottom: '1.5rem' }}>
        <p className="micro-label" style={{ marginBottom: '2px' }}>Total vendido</p>
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '10px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '34px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>
            {fmtUsd(report.sales.grandTotalUsd)}
          </span>
          {salesVar ? (
            <span className={`tag ${salesVar.positive ? 'tag-sage' : 'tag-rose'}`}>{salesVar.text}</span>
          ) : (
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>—</span>
          )}
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>vs. periodo anterior</span>
        </div>

        <p data-period-label style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', marginTop: '6px' }}>
          {report.period.label}
        </p>
      </div>

      <ChartCard
        title={
          report.seriesGranularity === 'HOUR' ? 'Ventas y cobros por hora'
            : report.seriesGranularity === 'MONTH' ? 'Ventas y cobros por mes'
            : 'Ventas y cobros por día del periodo'
        }
        aside={
          <span className="period-nav">
            <button onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label="Periodo anterior">‹</button>
            <span className="period-nav-mid">
              {jumpControl}
              <button
                className={`today-chip${showsToday ? ' active' : ''}`}
                aria-pressed={showsToday}
                title={showsToday ? 'El periodo en pantalla incluye hoy' : 'Ir al periodo de hoy'}
                onClick={() => setPeriod(kind === 'CUSTOM' ? customPeriod(todayIso, todayIso) : periodOf(kind, new Date()))}
              >
                Hoy
              </button>
            </span>
            <button onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Periodo siguiente">›</button>
          </span>
        }
      >
        <div style={{ marginBottom: '4px' }}><SalesLegend /></div>
        <SalesLineChart series={report.daily} bands={report.bands} />
        {/* Range chips, ticker-style, pinned to the chart's foot. */}
        <div style={{ borderTop: '1px dashed var(--color-bone)', paddingTop: '10px' }}>
          <span className="range-track">
            {PERIOD_KINDS.map((k) => (
              <button
                key={k}
                className={`range-chip${kind === k ? ' active' : ''}`}
                aria-pressed={kind === k}
                aria-label={PERIOD_KIND_LABEL[k]}
                title={PERIOD_KIND_LABEL[k]}
                onClick={() => switchKind(k)}
              >
                {SHORT_KIND[k]}
              </button>
            ))}
          </span>
        </div>
      </ChartCard>

      {/* Information grid — every figure the quote block/KPI cards used to show. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: '32px', margin: '1.5rem 0' }}>
        <InfoRow label="Nº de ventas" value={String(report.sales.count)} delta={countVar} />
        <InfoRow label="Ticket promedio" value={fmtUsd(report.avgTicketUsd)} />
        <InfoRow label="Cobros posteriores" value={fmtUsd(report.collections.collectedUsd)} delta={collectedVar} />
        <InfoRow label="Vueltos entregados" value={fmtUsd(report.collections.refundedUsd)} />
        <InfoRow label="Gastos" value={fmtUsd(report.expenses.totalUsd)} delta={expensesVar} invert />
        <InfoRow label="Utilidad bruta estimada" value={fmtUsd(report.cogs.grossMarginUsd)} />
        <InfoRow label="Margen" value={`${Math.round(report.cogs.marginPct * 100)}%`} />
        <InfoRow label="Valor de stock (hoy)" value={fmtUsd(report.stockNow.valueUsd)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', margin: '1.5rem 0' }}>
        <ChartCard title="Top clientes">
          {report.topClients.length > 0
            ? <BarList rows={report.topClients} color={CHART_VIOLET} fmt={fmtUsd} />
            : <Empty />}
        </ChartCard>
        <ChartCard title="Top artículos ($)">
          {report.topArticles.length > 0
            ? <BarList rows={report.topArticles.map((a) => ({ label: a.label, value: a.usd }))} color={CHART_VIOLET} fmt={fmtUsd} />
            : <Empty />}
        </ChartCard>
      </div>

      {/* ---- Datos: the same rows as the Excel export, filtered on screen ---- */}
      <details
        className="card"
        style={{ padding: '20px 24px', marginBottom: '1.75rem' }}
        onToggle={(e) => { const open = e.currentTarget.open; setDataOpen(open); }}
      >
        <summary style={{ cursor: 'pointer' }}>
          <span className="micro-label">• Datos</span>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', marginLeft: '8px' }}>
            ventas, productos, movimientos, cobros, gastos e inventario
          </span>
        </summary>

        <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {(sheets ?? []).map((s) => (
              <button
                key={s.name}
                className={`range-chip${sheetName === s.name ? ' active' : ''}`}
                aria-pressed={sheetName === s.name}
                onClick={() => setSheetName(s.name)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            <Input
              placeholder="Filtrar filas…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ maxWidth: '280px' }}
            />
          </div>

          {sheetsLoading && (
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>Cargando datos…</p>
          )}

          {!sheetsLoading && selectedSheet && (
            filteredRows.length === 0 ? <Empty /> : (
              <>
                <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: '460px', border: '1px solid var(--color-bone)', borderRadius: '6px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {selectedSheet.headers.map((h) => (
                          <th
                            key={h}
                            style={{
                              position: 'sticky', top: 0, background: 'var(--color-cloth)',
                              textAlign: 'left', padding: '6px 10px', whiteSpace: 'nowrap',
                              fontFamily: 'var(--font-sans)', fontSize: '10px', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-thread)',
                              borderBottom: '1px solid var(--color-bone)',
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.slice(0, ROW_CAP).map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => {
                            const numeric = typeof cell === 'number';
                            return (
                              <td
                                key={ci}
                                style={{
                                  padding: '5px 10px', borderBottom: '1px solid var(--color-bone)',
                                  fontFamily: numeric ? 'var(--font-mono)' : 'var(--font-sans)',
                                  fontVariantNumeric: numeric ? 'tabular-nums' : undefined,
                                  fontSize: '12px', textAlign: numeric ? 'right' : 'left', whiteSpace: 'nowrap',
                                }}
                              >
                                {cell ?? ''}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filteredRows.length > ROW_CAP && (
                  <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>
                    Mostrando {ROW_CAP} de {filteredRows.length} filas — exporta el Excel para verlas todas.
                  </p>
                )}
              </>
            )
          )}
        </div>
      </details>

      <Section title="Cobros y vueltos">
        <StatRow label="Cobros posteriores (abonos)" value={String(report.collections.paymentsCount)} />
        <StatRow label="Cobrado" money={report.collections.collectedUsd} />
        <StatRow label="Vueltos entregados" value={String(report.collections.refundsCount)} />
        <StatRow label="Total vueltos" money={report.collections.refundedUsd} />
      </Section>

      <Section title="Gastos">
        <StatRow label="Cantidad de gastos" value={String(report.expenses.count)} />
        <StatRow label="Total" money={report.expenses.totalUsd} strong />
        <StatRow label="Fijos" money={report.expenses.fixedUsd} />
        <StatRow label="Variables" money={report.expenses.variableUsd} />
        {report.expenses.byCategory.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <MiniTable
              headers={['Categoría', '#', 'Total']}
              rows={report.expenses.byCategory.map((c) => [c.category, String(c.count), <Money key="m" usd={c.totalUsd} />])}
            />
          </div>
        )}
      </Section>

      <Section title="Inventario">
        <StatRow label="Kg entrada / salida" value={`${report.movements.kgIn} / ${report.movements.kgOut}`} />
        <StatRow label="Unidades entrada / salida" value={`${report.movements.unitsIn} / ${report.movements.unitsOut}`} />
        {report.inventory.topOut.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <p className="micro-label" style={{ marginBottom: '6px' }}>• Artículos con más salida (Kg)</p>
            <BarList rows={report.inventory.topOut} color={CHART_BRASS} fmt={fmtKg} />
          </div>
        )}
        {report.movements.byReason.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: '8px' }}>
            <MiniTable
              headers={['Motivo', '#', 'Kg (neto)', 'Unidades (neto)']}
              rows={report.movements.byReason.map((r) => [r.reason, String(r.count), String(r.kg), String(r.units)])}
            />
          </div>
        )}
        <p className="micro-label" style={{ marginTop: '10px' }}>• Stock actual (hoy)</p>
        <StatRow label="Artículos" value={String(report.stockNow.batches)} />
        <StatRow label="Kg" value={fmtKg(report.stockNow.kg)} />
        <StatRow label="Unidades" value={fmtUnits(report.stockNow.units)} />
        <StatRow label="Valor de stock" money={report.stockNow.valueUsd} />
      </Section>

      <Section title="Rentabilidad">
        <StatRow label="Base" money={report.sales.baseUsd} />
        <StatRow label="Costo estimado" money={report.cogs.costUsd} />
        <StatRow label="Utilidad bruta" money={report.cogs.grossMarginUsd} strong />
        <StatRow label="Margen" value={`${Math.round(report.cogs.marginPct * 100)}%`} />
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)', marginTop: '4px' }}>
          Costo estimado a partir del costo de compra registrado HOY en cada rollo/artículo vendido —
          cubre el {Math.round(report.cogs.coverage * 100)}% del monto vendido. Si se corrige el costo de un
          rollo, esta cifra cambia también en informes ya cerrados; no es una cifra contable exacta.
        </p>
      </Section>

      {admin && payroll && (
        <Section title="Nómina">
          <StatRow label="Cantidad de pagos" value={String(payroll.count)} />
          <StatRow label="Total" money={payroll.totalUsd} strong />
        </Section>
      )}
    </div>
  );
}

function Empty() {
  return <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>Sin datos en este periodo.</p>;
}

// Two-column label/value grid (Yahoo Finance "Summary" panel style): rows
// hairline-separated, label small and gray, value mono tabular. Variance
// (when passed) rides beside the value as the same .tag pill used elsewhere.
function InfoRow({ label, value, delta, invert }: { label: string; value: string; delta?: { text: string; positive: boolean } | null; invert?: boolean }) {
  const good = delta ? (invert ? !delta.positive : delta.positive) : true;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', padding: '9px 0', borderBottom: '1px solid var(--color-bone)' }}>
      <span className="micro-label">{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{value}</span>
        {delta !== undefined && (
          delta ? (
            <span className={`tag ${good ? 'tag-sage' : 'tag-rose'}`} style={{ fontSize: '10px', padding: '1px 6px' }}>{delta.text}</span>
          ) : (
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>—</span>
          )
        )}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="informe-section" style={{ marginBottom: '1.75rem' }}>
      <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-thread)', borderBottom: '1px dashed var(--color-thread)', paddingBottom: '6px', marginBottom: '10px' }}>
        {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {children}
      </div>
    </section>
  );
}

function StatRow({ label, value, money, strong }: { label: string; value?: string; money?: number; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: strong ? '13px' : '12px', fontWeight: strong ? 700 : 400, color: 'var(--color-ink)' }}>
        {label}
      </span>
      {money !== undefined ? <Money usd={money} /> : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 700 : 400 }}>{value}</span>
      )}
    </div>
  );
}

function MiniTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--color-thread)' }}>
          {headers.map((h, i) => (
            <th
              key={h}
              style={{
                textAlign: i === 0 ? 'left' : 'right', padding: '4px 0',
                fontFamily: 'var(--font-sans)', fontSize: '10px', fontWeight: 500,
                textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-thread)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} style={{ borderBottom: ri < rows.length - 1 ? '1px solid color-mix(in srgb, var(--color-thread) 15%, transparent)' : 'none' }}>
            {r.map((cell, ci) => (
              <td key={ci} style={{ textAlign: ci === 0 ? 'left' : 'right', padding: '4px 0', fontFamily: 'var(--font-mono)', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
