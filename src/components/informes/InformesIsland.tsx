// Informes page island — read-only weekly/monthly reports over existing data.
// USD-first: summaries are never converted at today's rate (mixed historical
// rates make a single Bs total a lie). Nómina section only for isAdmin(), and
// only if buildPayrollSummary succeeds — a failure hides the section rather
// than breaking the page. UI: SPANISH. Code/fields: ENGLISH.
// Export is .xlsx (buildInformeSheets + buildXlsx) — no PDF, no print.

import { useEffect, useRef, useState } from 'react';
import { db } from '../../lib/db';
import { nominaDb } from '../../lib/nominadb';
import { isAdmin } from '../../lib/auth';
import {
  weekPeriod, fortnightPeriod, monthPeriod, quarterPeriod, halfPeriod, yearPeriod,
  customPeriod, periodOf, shiftPeriod, buildReport, buildPayrollSummary, PERIOD_KIND_LABEL, fromIsoDate,
  type PeriodKind, type ReportPeriod, type ReportData, type PayrollSummary,
} from '../../lib/report';
import { buildInformeSheets } from '../../lib/informe-xlsx';
import { buildXlsx } from '../../lib/xlsx';
import { fmtUsd, fmtKg, fmtUnits } from '../../lib/format';
import { Button, Input, Kbd, Money } from '../ui';
import { ChartCard, SalesLegend, SalesLineChart, BarList, CHART_VIOLET, CHART_BRASS } from '../panel/charts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const QUARTER_LABEL = ['1.er trimestre', '2.º trimestre', '3.er trimestre', '4.º trimestre'];
const HALF_LABEL = ['1.er semestre', '2.º semestre'];
const PERIOD_KINDS = Object.keys(PERIOD_KIND_LABEL) as PeriodKind[];

/**
 * The date a kind switch should land on: TODAY when the period being viewed
 * contains it, otherwise the period's first day. Narrowing «Año 2026» to
 * Semana should give this week, not the week of January 1st; narrowing a past
 * month should stay in that month.
 */
function anchorDate(p: ReportPeriod): Date {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = fromIsoDate(p.start);
  return today >= start && today <= fromIsoDate(p.end) ? today : start;
}

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
  const [jumpOpen, setJumpOpen] = useState(false);
  const [report, setReport] = useState<ReportData | null>(null);
  const [payroll, setPayroll] = useState<PayrollSummary | null>(null);
  const [exporting, setExporting] = useState(false);
  const admin = isAdmin();

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

  // Switching kind keeps the date being looked at — periodOf(next, start of
  // the current period) — never resets to today. CUSTOM has no natural
  // container (periodOf falls back to the month), so it's special-cased to
  // keep the exact same range and open the jump panel directly to edit it.
  function switchKind(next: PeriodKind) {
    setKind(next);
    if (next === 'CUSTOM') {
      setPeriod(customPeriod(period.start, period.end));
      setJumpOpen(true);
      return;
    }
    setPeriod(periodOf(next, anchorDate(period)));
  }

  async function handleExportExcel() {
    if (!report) return;
    setExporting(true);
    try {
      const sheets = await buildInformeSheets(db, period, report, admin ? nominaDb() : null);
      const bytes = buildXlsx(sheets);
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

      {/* Independent pills, one per PeriodKind — wraps 2-3 rows at 360px, never scrolls. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {PERIOD_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => switchKind(k)}
            style={{
              padding: '6px 14px', borderRadius: '999px', cursor: 'pointer',
              border: kind === k ? '1px solid var(--color-dye)' : '1px solid var(--color-thread)',
              fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.04em',
              background: kind === k ? 'var(--color-dye)' : 'transparent',
              color: kind === k ? 'var(--color-cloth)' : 'var(--color-ink)',
            }}
          >
            {PERIOD_KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginBottom: '1.5rem' }}>
        {/* ‹ label › wrap as one unit on narrow screens; min() keeps the desktop width stable */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label="Periodo anterior">‹</Button>
          <button
            onClick={() => setJumpOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={jumpOpen}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 8px',
              fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)',
              minWidth: 'min(260px, 60vw)', textAlign: 'center', textDecoration: 'underline',
              textDecorationColor: 'var(--color-thread)', textUnderlineOffset: '3px',
              // A long CUSTOM label ("Del 30 de julio al 9 de septiembre de 2026")
              // is wider than the box at 360px and spilled over the › arrow.
              whiteSpace: 'normal', lineHeight: 1.3,
            }}
          >
            {report.period.label}
          </button>
          <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Periodo siguiente">›</Button>
        </div>
        {jumpOpen && (
          <PeriodJumpPanel
            kind={kind}
            period={period}
            onPick={(p) => { setPeriod(p); setJumpOpen(false); }}
            onClose={() => setJumpOpen(false)}
          />
        )}
      </div>

      {/* ---- KPIs ---- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '1.5rem' }}>
        <Kpi label="Total vendido" value={fmtUsd(report.sales.grandTotalUsd)} delta={salesVar} />
        <Kpi label="Nº de ventas" value={String(report.sales.count)} delta={countVar} />
        <Kpi label="Ticket promedio" value={fmtUsd(report.avgTicketUsd)} />
        <Kpi label="Cobros posteriores" value={fmtUsd(report.collections.collectedUsd)} delta={collectedVar} />
        <Kpi label="Gastos" value={fmtUsd(report.expenses.totalUsd)} delta={expensesVar} invert />
        <Kpi label="Utilidad bruta estimada" value={fmtUsd(report.cogs.grossMarginUsd)} />
      </div>

      <ChartCard
        title={report.seriesGranularity === 'MONTH' ? 'Ventas y cobros por mes' : 'Ventas y cobros por día del periodo'}
        aside={<SalesLegend />}
      >
        <SalesLineChart series={report.daily} />
      </ChartCard>

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

function Kpi({ label, value, delta, invert }: { label: string; value: string; delta?: { text: string; positive: boolean } | null; invert?: boolean }) {
  const good = delta ? (invert ? !delta.positive : delta.positive) : true;
  return (
    <div className="card" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <span className="micro-label">{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{value}</span>
      {delta !== undefined && (
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
          {delta ? (
            <span className={`tag ${good ? 'tag-sage' : 'tag-rose'}`} style={{ fontSize: '11px', padding: '2px 8px' }}>{delta.text}</span>
          ) : (
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>—</span>
          )}
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', color: 'var(--color-thread)' }}>vs anterior</span>
        </span>
      )}
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

// ---- Period jump panel: two clicks to any month/quarter/half/year, a native
// date picker for week/fortnight, and a custom range. Native <dialog> —
// same pattern as CollectDialog/RefundDialog (PaymentDialogs.tsx): showModal()
// on mount gives backdrop, Escape-to-close and the focus trap for free, and
// its width already caps at calc(100vw - 32px) so it never overflows 360px. ----

function gridBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 4px', borderRadius: '6px', cursor: 'pointer',
    border: active ? '1px solid var(--color-dye)' : '1px solid var(--color-thread)',
    background: active ? 'var(--color-dye)' : 'transparent',
    color: active ? 'var(--color-cloth)' : 'var(--color-ink)',
    fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 500,
  };
}

function PeriodJumpPanel({
  kind, period, onPick, onClose,
}: {
  kind: PeriodKind;
  period: ReportPeriod;
  onPick: (p: ReportPeriod) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const periodStart = fromIsoDate(period.start);
  const [year, setYear] = useState(periodStart.getFullYear());
  const [yearAnchor, setYearAnchor] = useState(periodStart.getFullYear());
  const [desde, setDesde] = useState(period.start);
  const [hasta, setHasta] = useState(period.end);

  useEffect(() => { ref.current?.showModal(); }, []);

  const yearGrid = Array.from({ length: 8 }, (_, i) => yearAnchor - 7 + i);
  const invalidCustom = fromIsoDate(desde).getTime() > fromIsoDate(hasta).getTime();

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Saltar de periodo"
      style={{
        border: '1px solid var(--color-thread)', borderRadius: '8px',
        background: 'var(--color-cloth)', padding: '20px 24px',
        width: 'min(420px, calc(100vw - 32px))', color: 'var(--color-ink)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-thread)', margin: 0 }}>
          Ir a {PERIOD_KIND_LABEL[kind].toLowerCase()}
        </h2>

        {(kind === 'MONTH' || kind === 'QUARTER' || kind === 'HALF') && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
              <Button variant="ghost" size="md" onClick={() => setYear((y) => y - 1)} aria-label="Año anterior">‹</Button>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700 }}>{year}</span>
              <Button variant="ghost" size="md" onClick={() => setYear((y) => y + 1)} aria-label="Año siguiente">›</Button>
            </div>
            {kind === 'MONTH' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                {MONTH_SHORT.map((label, m) => {
                  const active = period.kind === 'MONTH' && periodStart.getFullYear() === year && periodStart.getMonth() === m;
                  return (
                    <button key={label} style={gridBtnStyle(active)} aria-current={active} onClick={() => onPick(monthPeriod(new Date(year, m, 1)))}>
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            {kind === 'QUARTER' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                {QUARTER_LABEL.map((label, q) => {
                  const active = period.kind === 'QUARTER' && periodStart.getFullYear() === year && Math.floor(periodStart.getMonth() / 3) === q;
                  return (
                    <button key={label} style={gridBtnStyle(active)} aria-current={active} onClick={() => onPick(quarterPeriod(new Date(year, q * 3, 1)))}>
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            {kind === 'HALF' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
                {HALF_LABEL.map((label, h) => {
                  const active = period.kind === 'HALF' && periodStart.getFullYear() === year && (periodStart.getMonth() < 6 ? 0 : 1) === h;
                  return (
                    <button key={label} style={gridBtnStyle(active)} aria-current={active} onClick={() => onPick(halfPeriod(new Date(year, h * 6, 1)))}>
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {kind === 'YEAR' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
              <Button variant="ghost" size="md" onClick={() => setYearAnchor((y) => y - 8)} aria-label="Años anteriores">‹</Button>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-thread)' }}>{yearGrid[0]}–{yearGrid[7]}</span>
              <Button variant="ghost" size="md" onClick={() => setYearAnchor((y) => y + 8)} aria-label="Años siguientes">›</Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
              {yearGrid.map((y) => {
                const active = period.kind === 'YEAR' && periodStart.getFullYear() === y;
                return (
                  <button key={y} style={gridBtnStyle(active)} aria-current={active} onClick={() => onPick(yearPeriod(new Date(y, 0, 1)))}>
                    {y}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {(kind === 'WEEK' || kind === 'FORTNIGHT') && (
          <div>
            <label className="micro-label" style={{ display: 'block', marginBottom: '6px' }}>Ir a la fecha</label>
            <Input
              type="date"
              defaultValue={period.start}
              onChange={(e) => {
                if (!e.target.value) return;
                onPick(kind === 'WEEK' ? weekPeriod(fromIsoDate(e.target.value)) : fortnightPeriod(fromIsoDate(e.target.value)));
              }}
            />
          </div>
        )}

        {kind === 'CUSTOM' && (
          <>
            <div className="form-grid-2">
              <div>
                <label className="micro-label" style={{ display: 'block', marginBottom: '6px' }}>Desde</label>
                <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
              </div>
              <div>
                <label className="micro-label" style={{ display: 'block', marginBottom: '6px' }}>Hasta</label>
                <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
              </div>
            </div>
            {invalidCustom && (
              <p role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-danger)', margin: 0 }}>
                La fecha «Desde» debe ser anterior o igual a «Hasta».
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="primary" size="md" disabled={invalidCustom} onClick={() => onPick(customPeriod(desde, hasta))}>
                Aplicar
              </Button>
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="md" onClick={() => ref.current?.close()}>Cerrar</Button>
        </div>
      </div>
    </dialog>
  );
}
