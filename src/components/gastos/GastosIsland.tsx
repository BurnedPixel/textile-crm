// Gastos page island — expense form + month-filtered list.
// UI: SPANISH. Code/fields: ENGLISH.

import { useState, useMemo } from 'react';
import { db } from '../../lib/db';
import { getConfig, getExpenses, addExpense } from '../../lib/queries';
import { useLiveQuery } from '../../lib/hooks';
import { fmtDate, fmtUsd, fmtBs, toBs, round2 } from '../../lib/format';
import {
  Button, Input, NumberInput, Select, Field, Kbd, Badge, Money, EmptyState,
} from '../ui';
import type { ExpenseDoc } from '../../lib/types';

const CATEGORIES = [
  'Materia prima',
  'Nómina',
  'Servicios',
  'Transporte',
  'Mantenimiento',
  'Alquiler',
  'Otros',
] as const;

const ENTRY_METHODS: { value: 'CASH' | 'TRANSFER'; label: string }[] = [
  { value: 'CASH',     label: 'Efectivo' },
  { value: 'TRANSFER', label: 'Transferencia' },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Category → badge tone
function categoryTone(cat: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (cat === 'Nómina')        return 'warn';
  if (cat === 'Materia prima') return 'ok';
  if (cat === 'Alquiler')      return 'danger';
  return 'neutral';
}

export default function GastosIsland() {
  // ---- Form state ----
  const [date,        setDate]        = useState(todayIso);
  const [category,    setCategory]    = useState<string>(CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [isFixed,     setIsFixed]     = useState(false);
  const [method,      setMethod]      = useState<'CASH' | 'TRANSFER'>('CASH');
  const [amountUsd,   setAmountUsd]   = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [formError,   setFormError]   = useState<string | null>(null);
  const [submitted,   setSubmitted]   = useState(false);

  // ---- Month filter ----
  const [month, setMonth] = useState(currentMonth);

  // ---- Live data ----
  const { data: config } = useLiveQuery((db) => getConfig(db));
  const rate = config?.currentDailyRateBCV ?? 0;

  const { data: allExpenses } = useLiveQuery(
    (db) => getExpenses(db, { startDate: month, endDate: month + '￿' }),
    [month],
  );

  // Filter: only expenses whose date starts with month (scanLedger uses ISO date prefix)
  const expenses: ExpenseDoc[] = useMemo(() => allExpenses ?? [], [allExpenses]);

  const monthlyTotalUsd = useMemo(
    () => round2(expenses.reduce((acc, e) => acc + e.amountUsd, 0)),
    [expenses],
  );

  // ---- Submit ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const cfg = await getConfig(db);
    if (!cfg || !(cfg.currentDailyRateBCV > 0)) {
      setFormError(
        'No hay tasa BCV configurada. Configure la tasa en la página de Configuración antes de registrar gastos.',
      );
      return;
    }

    const usd = parseFloat(amountUsd);
    if (!(usd > 0)) {
      setFormError('El monto debe ser mayor que cero.');
      return;
    }

    setSubmitting(true);
    try {
      await addExpense(db, {
        date: new Date(date + 'T12:00:00').toISOString(),
        category,
        description: description.trim(),
        isFixedExpense: isFixed,
        entryMethod: method,
        amountUsd: usd,
        exchangeRateBCV: cfg.currentDailyRateBCV,
      });
      // Reset form
      setDate(todayIso());
      setCategory(CATEGORIES[0]);
      setDescription('');
      setIsFixed(false);
      setMethod('CASH');
      setAmountUsd('');
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 2500);
    } catch (err) {
      setFormError((err as Error).message ?? 'Error al registrar el gasto.');
    } finally {
      setSubmitting(false);
    }
  }

  const usdPreview = parseFloat(amountUsd);

  return (
    <div style={{ maxWidth: '860px' }}>
      {/* Page header */}
      <div style={{ marginBottom: '1.75rem' }}>
        <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
          Gastos
        </h1>
        <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginTop: '4px' }}>
          Registra y consulta los gastos operativos de la fábrica.{' '}
          <span className="kbd-hints"><Kbd>g o</Kbd> para ir a Configuración.</span>
        </p>
      </div>

      {/* Form card */}
      <form onSubmit={handleSubmit}>
        <div className="card" style={{ background: 'var(--color-cloth)', border: '1px dashed var(--color-thread)', borderRadius: '10px', padding: '1.5rem', marginBottom: '2rem' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-thread)', margin: '0 0 1.25rem' }}>
            Nuevo gasto
          </h2>

          <div className="form-grid-2" style={{ marginBottom: '1rem' }}>
            <Field label="Fecha">
              <Input
                type="date"
                value={date}
                max={todayIso()}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </Field>

            <Field label="Categoría">
              <Select value={category} onChange={(e) => setCategory(e.target.value)} required>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </Field>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <Field label="Descripción">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Descripción del gasto…"
                required
              />
            </Field>
          </div>

          <div className="form-grid-2" style={{ marginBottom: '1rem' }}>
            <Field label="Método de pago">
              <Select value={method} onChange={(e) => setMethod(e.target.value as 'CASH' | 'TRANSFER')} required>
                {ENTRY_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </Select>
            </Field>

            <Field
              label="Monto (USD)"
              hint={
                rate > 0 && usdPreview > 0
                  ? `≈ ${fmtBs(toBs(usdPreview, rate))} a la tasa actual`
                  : rate === 0
                  ? 'Configure la tasa BCV en Configuración'
                  : undefined
              }
            >
              <NumberInput
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
                placeholder="0.00"
                min="0.01"
                step="0.01"
                required
              />
            </Field>
          </div>

          {/* Fixed expense checkbox */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '14px', color: 'var(--color-ink)', marginBottom: '1.25rem' }}>
            <input
              type="checkbox"
              checked={isFixed}
              onChange={(e) => setIsFixed(e.target.checked)}
              style={{ width: '16px', height: '16px', accentColor: 'var(--color-dye)', cursor: 'pointer' }}
            />
            Gasto fijo (recurrente)
          </label>

          {formError && (
            <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', background: 'rgba(163,46,46,0.08)', border: '1px solid rgba(163,46,46,0.2)', borderRadius: '6px', padding: '10px 14px', marginBottom: '1rem' }}>
              {formError.includes('Configure la tasa') ? (
                <>
                  {formError.split('Configuración')[0]}
                  <a href="/configuracion" style={{ color: 'var(--color-dye)', fontWeight: 600 }}>Configuración</a>
                  {formError.split('Configuración')[1]}
                </>
              ) : formError}
            </div>
          )}

          {submitted && (
            <div role="status" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ok)', background: 'rgba(62,107,58,0.08)', border: '1px solid rgba(62,107,58,0.2)', borderRadius: '6px', padding: '10px 14px', marginBottom: '1rem' }}>
              Gasto registrado correctamente.
            </div>
          )}

          <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Registrando…' : 'Registrar gasto'}
            </Button>
          </div>
        </div>
      </form>

      {/* Divider */}
      <hr className="exp-divider" style={{ border: 'none', borderTop: '1px dashed var(--color-thread)', marginBottom: '1.5rem' }} />

      {/* Month filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '1.25rem' }}>
        <label style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-thread)' }}>
          Mes
        </label>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: '"tnum" 1', fontSize: '14px', color: 'var(--color-ink)', background: 'var(--color-cloth)', border: '1.5px solid var(--color-thread)', borderRadius: '6px', padding: '6px 12px', outline: 'none', cursor: 'pointer' }}
        />
      </div>

      {/* Expense list */}
      {expenses.length === 0 ? (
        <EmptyState title="Sin gastos en este período" />
      ) : (
        <div style={{ background: 'var(--color-cloth)', border: '1px dashed var(--color-thread)', borderRadius: '10px', overflow: 'hidden' }}>
          <table className="table-cards exp-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-thread)' }}>
                {['Fecha', 'Categoría', 'Descripción', 'Fijo', 'Método', 'Monto'].map((h) => (
                  <th key={h} style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-thread)', padding: '10px 14px', textAlign: h === 'Monto' ? 'right' : 'left' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expenses.map((e, i) => (
                <tr key={e._id} style={{ borderBottom: i < expenses.length - 1 ? '1px solid rgba(138,131,113,0.15)' : 'none' }}>
                  <td style={tdStyle}>{fmtDate(e.date)}</td>
                  <td style={tdStyle}>
                    <Badge tone={categoryTone(e.category)}>{e.category}</Badge>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.description}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    {e.isFixedExpense && (
                      <span
                        title="Gasto fijo"
                        aria-label="Gasto fijo"
                        style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-dye)' }}
                      />
                    )}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--color-thread)' }}>
                    {e.entryMethod === 'CASH' ? 'Efectivo' : 'Transferencia'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {/* Historical accuracy: use the locked rate on the expense, not today's */}
                    <Money usd={e.amountUsd} rate={e.exchangeRateBCV} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer totals */}
          <div style={{ borderTop: '1px solid var(--color-thread)', padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="exp-note" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
              Bs calculados a la tasa histórica de cada gasto
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-thread)' }}>
                Total del mes
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700, color: 'var(--color-ink)', fontFeatureSettings: '"tnum" 1' }}>
                {fmtUsd(monthlyTotalUsd)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const tdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '13px',
  color: 'var(--color-ink)',
  padding: '10px 14px',
  verticalAlign: 'middle',
};
