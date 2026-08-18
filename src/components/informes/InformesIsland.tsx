// Informes page island — read-only weekly/monthly reports over existing data.
// USD-first: summaries are never converted at today's rate (mixed historical
// rates make a single Bs total a lie). Nómina section only for isAdmin(), and
// only if buildPayrollSummary succeeds — a failure hides the section rather
// than breaking the page. UI: SPANISH. Code/fields: ENGLISH.

import { useEffect, useState } from 'react';
import { db } from '../../lib/db';
import { nominaDb } from '../../lib/nominadb';
import { isAdmin } from '../../lib/auth';
import {
  weekPeriod, monthPeriod, shiftPeriod, buildReport, buildPayrollSummary,
  type ReportPeriod, type ReportData, type PayrollSummary,
} from '../../lib/report';
import { Button, Kbd, Money } from '../ui';

export default function InformesIsland() {
  const [kind, setKind] = useState<'WEEK' | 'MONTH'>('WEEK');
  const [period, setPeriod] = useState<ReportPeriod>(() => weekPeriod(new Date()));
  const [report, setReport] = useState<ReportData | null>(null);
  const [payroll, setPayroll] = useState<PayrollSummary | null>(null);
  const [sharingPdf, setSharingPdf] = useState(false);
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

  async function handleSharePdf() {
    if (!report) return;
    setSharingPdf(true);
    try {
      const { buildInformePdf } = await import('../../lib/informe-pdf');
      const buf = buildInformePdf(report, admin ? payroll : null);
      const file = new File([buf], `informe-${report.period.start}.pdf`, { type: 'application/pdf' });
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
      console.error('informe PDF', err);
    } finally {
      setSharingPdf(false);
    }
  }

  if (!report) return null;

  return (
    <div className="informe-report" style={{ maxWidth: '860px' }}>
      {/* Page header + period picker */}
      <div className="no-print" style={{ marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
            Informes
          </h1>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginTop: '4px' }}>
            Resumen de ventas, cobros, gastos y movimientos. <span className="kbd-hints"><Kbd>g r</Kbd></span>
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="ghost" size="lg" onClick={() => window.print()}>Imprimir</Button>
          <Button variant="ghost" size="lg" onClick={handleSharePdf} disabled={sharingPdf}>
            {sharingPdf ? 'Generando…' : 'Compartir PDF'}
          </Button>
        </div>
      </div>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '1.5rem' }}>
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
                color: kind === k ? '#fff' : 'var(--color-ink)',
              }}
            >
              {k === 'WEEK' ? 'Semana' : 'Mes'}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, -1))} aria-label="Periodo anterior">‹</Button>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)', minWidth: '260px', textAlign: 'center' }}>
          {report.period.label}
        </span>
        <Button variant="ghost" size="md" onClick={() => setPeriod(shiftPeriod(period, 1))} aria-label="Periodo siguiente">›</Button>
      </div>

      {/* Print-only period label */}
      <div className="print-only" style={{ display: 'none', fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>
        {report.period.label}
      </div>

      <Section title="Ventas">
        <StatRow label="Cantidad de ventas" value={String(report.sales.count)} />
        <StatRow label="Base" money={report.sales.baseUsd} />
        <StatRow label="IVA" money={report.sales.ivaUsd} />
        <StatRow label="IGTF" money={report.sales.igtfUsd} />
        <StatRow label="Total general" money={report.sales.grandTotalUsd} strong />
        <StatRow label="En libros / no en libros" value={`${report.sales.onBooksCount} / ${report.sales.offBooksCount}`} />
      </Section>

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
          <MiniTable
            headers={['Categoría', '#', 'Total']}
            rows={report.expenses.byCategory.map((c) => [c.category, String(c.count), <Money key="m" usd={c.totalUsd} />])}
          />
        )}
      </Section>

      <Section title="Movimientos de inventario">
        <StatRow label="Kg entrada / salida" value={`${report.movements.kgIn} / ${report.movements.kgOut}`} />
        <StatRow label="Unidades entrada / salida" value={`${report.movements.unitsIn} / ${report.movements.unitsOut}`} />
        {report.movements.byReason.length > 0 && (
          <MiniTable
            headers={['Motivo', '#', 'Kg (neto)', 'Unidades (neto)']}
            rows={report.movements.byReason.map((r) => [r.reason, String(r.count), String(r.kg), String(r.units)])}
          />
        )}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="informe-section" style={{ marginBottom: '1.75rem' }}>
      <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-thread)', borderBottom: '1px dashed var(--color-thread)', paddingBottom: '6px', marginBottom: '10px' }}>
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
                fontFamily: 'var(--font-sans)', fontSize: '10px', fontWeight: 700,
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
          <tr key={ri} style={{ borderBottom: ri < rows.length - 1 ? '1px solid rgba(138,131,113,0.15)' : 'none' }}>
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
