// Informes page island — read-only weekly/monthly reports over existing data.
// USD-first: summaries are never converted at today's rate (mixed historical
// rates make a single Bs total a lie). Nómina section only for isAdmin(), and
// only if buildPayrollSummary succeeds — a failure hides the section rather
// than breaking the page. UI: SPANISH. Code/fields: ENGLISH.
// Export is .xlsx (buildInformeSheets + buildXlsx) — no PDF, no print.

import { useEffect, useState } from 'react';
import { db } from '../../lib/db';
import { nominaDb } from '../../lib/nominadb';
import { isAdmin } from '../../lib/auth';
import {
  weekPeriod, monthPeriod, shiftPeriod, buildReport, buildPayrollSummary,
  type ReportPeriod, type ReportData, type PayrollSummary,
} from '../../lib/report';
import { buildInformeSheets } from '../../lib/informe-xlsx';
import { buildXlsx } from '../../lib/xlsx';
import { fmtUsd, fmtKg, fmtUnits } from '../../lib/format';
import { Button, Kbd, Money } from '../ui';
import { ChartCard, SalesLegend, SalesLineChart, BarList, CHART_VIOLET, CHART_BRASS } from '../panel/charts';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// null = no comparable base (an empty previous period is not "+100%" growth).
function variance(current: number, previous: number): { text: string; positive: boolean } | null {
  if (previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return { text: `${sign}${pct.toFixed(0)}%`, positive: pct >= 0 };
}

export default function InformesIsland() {
  const [kind, setKind] = useState<'WEEK' | 'MONTH'>('WEEK');
  const [period, setPeriod] = useState<ReportPeriod>(() => weekPeriod(new Date()));
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

  function switchKind(next: 'WEEK' | 'MONTH') {
    setKind(next);
    setPeriod(next === 'WEEK' ? weekPeriod(new Date()) : monthPeriod(new Date()));
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

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', border: '1px solid var(--color-thread)', borderRadius: '8px', overflow: 'hidden' }}>
          {(['WEEK', 'MONTH'] as const).map((k) => (
            <button
              key={k}
              onClick={() => switchKind(k)}
              style={{
                padding: '6px 14px', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.04em',
                background: kind === k ? 'var(--color-dye)' : 'transparent',
                color: kind === k ? 'var(--color-cloth)' : 'var(--color-ink)',
              }}
            >
              {k === 'WEEK' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
        {/* ‹ label › wrap as one unit on narrow screens; min() keeps the desktop width stable */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label="Periodo anterior">‹</Button>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)', minWidth: 'min(260px, 60vw)', textAlign: 'center' }}>
            {report.period.label}
          </span>
          <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Periodo siguiente">›</Button>
        </div>
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

      <ChartCard title="Ventas y cobros del periodo" aside={<SalesLegend />}>
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
