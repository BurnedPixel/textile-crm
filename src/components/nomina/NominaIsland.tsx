// Nómina page island — admin-only. Reads/writes the SEPARATE nómina DB
// (nominadb.ts), never db.ts's main `db` except to read the BCV rate
// (getConfig pattern — the rate is read once per submit, never cached on a
// logic-module call). UI: SPANISH. Code/fields: ENGLISH.

import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../../lib/db';
import { nominaDb, onNominaChange } from '../../lib/nominadb';
import { getConfig, uuidv4 } from '../../lib/queries';
import { isAdmin, cachedUser } from '../../lib/auth';
import {
  listWorkers, listPayrollPays, saveWorker, recordPayrollPayment,
  dueSummary, type WorkerDue, type DueConcept,
} from '../../lib/payroll';
import { periodLabel } from '../../lib/nomina-format';
import {
  FIELD_MAX, validateDocumentId, validateName,
  type WorkerDoc, type PayrollPayDoc, type PayrollConcept, type PayrollFrequency, type EntryMethod,
} from '../../lib/types';
import { fmtDateTime, round2 } from '../../lib/format';
import {
  Button, Input, NumberInput, Select, Field, Badge, Money, EmptyState, Combobox, Kbd,
} from '../ui';

const FREQ_LABEL: Record<PayrollFrequency, string> = { WEEKLY: 'Semanal', MONTHLY: 'Mensual' };

const CONCEPT_SUGGESTIONS = ['Salario', 'Bono de transporte', 'Bono de guerra', 'Utilidades'];

const ENTRY_METHODS: { value: EntryMethod; label: string }[] = [
  { value: 'CASH', label: 'Efectivo' },
  { value: 'TRANSFER', label: 'Transferencia' },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// ─── DATA ─────────────────────────────────────────────────────────────────
// nominaDb() has no useLiveQuery coverage (that hook is wired to the main
// db's onDbChange) — this mirrors its shape against onNominaChange instead.

interface NominaData {
  workers: WorkerDoc[];
  duePays: PayrollPayDoc[];
  historyPays: PayrollPayDoc[];
}

function useNominaData() {
  const [data, setData] = useState<NominaData | undefined>(undefined);

  const load = useCallback(() => {
    const localDb = nominaDb();
    Promise.all([
      listWorkers(localDb),
      // dueForWorker's deepest lookback is 4 weeks; 70 days is comfortable slack.
      listPayrollPays(localDb, { startDate: isoDaysAgo(70) }),
      listPayrollPays(localDb, { limit: 50 }),
    ])
      .then(([workers, duePays, historyPays]) => setData({ workers, duePays, historyPays }))
      .catch((err) => console.error('[nomina]', err));
  }, []);

  useEffect(() => {
    load();
    return onNominaChange(load);
  }, [load]);

  return { data, reload: load };
}

// ─── PAY DIALOG ───────────────────────────────────────────────────────────

interface PayLineState {
  checked: boolean;
  label: string;
  amountUsd: string;
  periodKey: string;
  frequency: PayrollFrequency;
}

function PayDialog({
  worker,
  due,
  onClose,
}: {
  worker: WorkerDoc;
  due: DueConcept[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Minted at OPEN — every submit (including a retry) carries the same payId,
  // so recordPayrollPayment is idempotent (checkout transactionId pattern).
  const meta = useRef({ payId: uuidv4(), date: new Date().toISOString() });
  const [lines, setLines] = useState<PayLineState[]>(
    due.map((d) => ({
      checked: true,
      label: d.label,
      amountUsd: d.amountUsd.toFixed(2),
      periodKey: d.periodKey,
      frequency: d.frequency,
    })),
  );
  const [method, setMethod] = useState<EntryMethod>('CASH');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function setLine(idx: number, patch: Partial<PayLineState>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  const checkedLines = lines.filter((l) => l.checked);
  const totalUsd = round2(checkedLines.reduce((sum, l) => sum + (Number(l.amountUsd) || 0), 0));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (checkedLines.length === 0) {
      setError('Selecciona al menos un concepto a pagar.');
      return;
    }
    const cfg = await getConfig(db);
    if (!cfg || !(cfg.currentDailyRateBCV > 0)) {
      setError('No hay tasa BCV configurada. Configúrala en Ajustes antes de registrar un pago.');
      return;
    }
    setSaving(true);
    try {
      await recordPayrollPayment(
        nominaDb(),
        {
          payId: meta.current.payId,
          workerId: worker._id,
          date: meta.current.date,
          entryMethod: method,
          operatorId: cachedUser()?.name ?? 'desconocido',
          lines: checkedLines.map((l) => ({
            label: l.label,
            amountUsd: Number(l.amountUsd) || 0,
            periodKey: l.periodKey,
          })),
        },
        cfg.currentDailyRateBCV,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Error al registrar el pago.');
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Registrar pago"
      style={{
        border: '1px solid var(--color-thread)',
        borderRadius: '8px',
        background: 'var(--color-cloth)',
        padding: '20px 24px',
        width: 'min(480px, calc(100vw - 32px))',
        color: 'var(--color-ink)',
      }}
    >
      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-thread)', margin: '0 0 6px' }}>
            Registrar pago
          </h2>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', margin: 0 }}>
            {worker.name} · <span style={{ fontFamily: 'var(--font-mono)' }}>{worker.documentId}</span>
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {lines.map((line, idx) => (
            <div key={`${line.label}-${line.periodKey}`} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="checkbox"
                checked={line.checked}
                onChange={(e) => setLine(idx, { checked: e.target.checked })}
                style={{ width: '16px', height: '16px', accentColor: 'var(--color-dye)', cursor: 'pointer', flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)' }}>
                  {line.label}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)' }}>
                  {periodLabel(line.periodKey)}
                </div>
              </div>
              <NumberInput
                value={line.amountUsd}
                min="0.01"
                step="0.01"
                disabled={!line.checked}
                onChange={(e) => setLine(idx, { amountUsd: e.target.value })}
                style={{ width: '110px' }}
              />
            </div>
          ))}
        </div>

        <Field label="Método de pago">
          <Select value={method} onChange={(e) => setMethod(e.target.value as EntryMethod)}>
            {ENTRY_METHODS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
        </Field>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', margin: 0 }}>
          Total del pago: <strong style={{ color: 'var(--color-ink)' }}><Money usd={totalUsd} /></strong>
        </p>

        {error && (
          <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" type="button" onClick={() => ref.current?.close()}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'Registrando…' : 'Registrar pago'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

// ─── PAGOS PENDIENTES ─────────────────────────────────────────────────────

const dueThStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--color-thread)', padding: '10px 12px', textAlign: 'left',
};
const dueTdStyle: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'top' };

function DueSection({ dues, rate, onPay }: { dues: WorkerDue[]; rate: number; onPay: (wd: WorkerDue) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (dues.length === 0) {
    return <EmptyState title="Sin pagos pendientes" />;
  }

  function toggle(workerId: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  }

  const totalGeneralUsd = round2(dues.reduce((sum, wd) => sum + wd.totalUsd, 0));

  return (
    <div style={{ background: 'var(--color-cloth)', border: '1px dashed var(--color-thread)', borderRadius: '10px', overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '480px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-thread)' }}>
            <th style={dueThStyle}>Trabajador</th>
            <th style={dueThStyle}>Pendiente</th>
            <th style={{ ...dueThStyle, textAlign: 'right' }}>Total</th>
            <th style={{ ...dueThStyle, textAlign: 'right' }}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {dues.map((wd, i) => {
            const isOpen = open.has(wd.worker._id);
            const overdueCount = wd.due.filter((d) => d.overdue).length;
            return (
              <>
                <tr
                  key={wd.worker._id}
                  onClick={() => toggle(wd.worker._id)}
                  style={{
                    borderBottom: isOpen ? 'none' : (i < dues.length - 1 ? '1px solid rgba(138,131,113,0.15)' : 'none'),
                    cursor: 'pointer',
                  }}
                >
                  <td style={dueTdStyle}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600, color: 'var(--color-ink)' }}>
                      {wd.worker.name}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)' }}>
                      {wd.worker.documentId}
                    </div>
                  </td>
                  <td style={dueTdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)' }}>
                        {wd.due.length} {wd.due.length === 1 ? 'concepto' : 'conceptos'}
                      </span>
                      {overdueCount > 0 && (
                        <Badge tone="danger">{overdueCount} {overdueCount === 1 ? 'atrasado' : 'atrasados'}</Badge>
                      )}
                    </div>
                  </td>
                  <td style={{ ...dueTdStyle, textAlign: 'right' }}>
                    <Money usd={wd.totalUsd} rate={rate || undefined} />
                  </td>
                  <td style={{ ...dueTdStyle, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                      <Button variant="primary" size="md" onClick={() => onPay(wd)}>
                        Pagar
                      </Button>
                      <Button
                        variant="ghost"
                        size="md"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Ocultar detalle' : 'Ver detalle'}
                        onClick={() => toggle(wd.worker._id)}
                      >
                        {isOpen ? '▲' : '▼'}
                      </Button>
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr style={{ borderBottom: i < dues.length - 1 ? '1px solid rgba(138,131,113,0.15)' : 'none' }}>
                    <td colSpan={4} style={{ padding: '0 12px 12px', background: 'rgba(138,131,113,0.05)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {wd.due.map((d) => (
                          <div key={`${d.label}-${d.periodKey}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '4px 0', borderBottom: '1px solid rgba(138,131,113,0.12)' }}>
                            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              {d.label} · {periodLabel(d.periodKey)}
                              {d.overdue && <Badge tone="danger">Atrasado</Badge>}
                            </span>
                            <Money usd={d.amountUsd} rate={rate || undefined} />
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '1px solid var(--color-thread)' }}>
            <td colSpan={2} style={{ ...dueTdStyle, fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-thread)' }}>
              Total general
            </td>
            <td style={{ ...dueTdStyle, textAlign: 'right' }}>
              <Money usd={totalGeneralUsd} rate={rate || undefined} />
            </td>
            <td style={dueTdStyle} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── TRABAJADORES ─────────────────────────────────────────────────────────

interface WorkerFormState {
  documentId: string;
  name: string;
  active: boolean;
  concepts: PayrollConcept[];
}

function blankWorkerForm(): WorkerFormState {
  return { documentId: '', name: '', active: true, concepts: [] };
}

function workerToForm(w: WorkerDoc): WorkerFormState {
  return { documentId: w.documentId, name: w.name, active: w.active, concepts: w.concepts };
}

function ConceptsEditor({ concepts, onChange }: { concepts: PayrollConcept[]; onChange: (c: PayrollConcept[]) => void }) {
  function update(idx: number, patch: Partial<PayrollConcept>) {
    onChange(concepts.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function remove(idx: number) {
    onChange(concepts.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([...concepts, { label: '', amountUsd: 0, frequency: 'WEEKLY' }]);
  }
  return (
    <div className="concepts-editor" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {concepts.map((c, idx) => (
        <div key={idx} className="concept-row">
          <div>
            <Field label="Concepto">
              <Combobox
                value={c.label}
                onChange={(v) => update(idx, { label: v })}
                options={CONCEPT_SUGGESTIONS}
                placeholder="Salario, Bono de transporte…"
                maxLength={FIELD_MAX.payrollLabel}
              />
            </Field>
          </div>
          <div style={{ width: '110px', flexShrink: 0 }}>
            <Field label="Monto (USD)">
              <NumberInput
                value={c.amountUsd === 0 ? '' : String(c.amountUsd)}
                min="0.01"
                step="0.01"
                placeholder="0.00"
                onChange={(e) => update(idx, { amountUsd: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
          <div style={{ width: '130px', flexShrink: 0 }}>
            <Field label="Frecuencia">
              <Select value={c.frequency} onChange={(e) => update(idx, { frequency: e.target.value as PayrollFrequency })}>
                <option value="WEEKLY">Semanal</option>
                <option value="MONTHLY">Mensual</option>
              </Select>
            </Field>
          </div>
          <Button variant="ghost" type="button" onClick={() => remove(idx)}>
            Quitar
          </Button>
        </div>
      ))}
      <div>
        <Button variant="ghost" type="button" onClick={add} disabled={concepts.length >= 20}>
          + Concepto
        </Button>
      </div>
    </div>
  );
}

function WorkerForm({
  initial,
  isNew,
  onSave,
  onCancel,
  saving,
  serverError,
}: {
  initial: WorkerFormState;
  isNew: boolean;
  onSave: (form: WorkerFormState) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  serverError: string;
}) {
  const [form, setForm] = useState<WorkerFormState>(initial);
  const [errors, setErrors] = useState<{ documentId?: string; name?: string }>({});

  useEffect(() => {
    setForm(initial);
    setErrors({});
  }, [initial]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const documentIdErr = isNew ? validateDocumentId(form.documentId) : null;
    const nameErr = validateName(form.name);
    if (documentIdErr || nameErr) {
      setErrors({ documentId: documentIdErr ?? undefined, name: nameErr ?? undefined });
      return;
    }
    setErrors({});
    await onSave(form);
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Field label="Cédula / RIF" error={errors.documentId}>
        {isNew ? (
          <Input
            value={form.documentId}
            onChange={(e) => setForm((p) => ({ ...p, documentId: e.target.value }))}
            placeholder="V-12345678 · E-84123456 · J-12345678-9"
            maxLength={FIELD_MAX.documentId}
            autoCapitalize="characters"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', textTransform: 'uppercase' }}
            autoFocus
          />
        ) : (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', color: 'var(--color-ink)', padding: '10px 12px', background: 'rgba(138,131,113,0.08)', borderRadius: '6px', border: '1.5px solid var(--color-thread)' }}>
            {form.documentId}
          </div>
        )}
      </Field>

      <Field label="Nombre" error={errors.name}>
        <Input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="Nombre completo"
          maxLength={FIELD_MAX.name}
          autoCapitalize="characters"
          style={{ textTransform: 'uppercase' }}
        />
      </Field>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '14px', color: 'var(--color-ink)' }}>
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
          style={{ width: '16px', height: '16px', accentColor: 'var(--color-dye)', cursor: 'pointer' }}
        />
        Activo
      </label>

      <div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-thread)', marginBottom: '8px' }}>
          Conceptos
        </div>
        <ConceptsEditor concepts={form.concepts} onChange={(c) => setForm((p) => ({ ...p, concepts: c }))} />
      </div>

      {serverError && (
        <p role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', margin: 0 }}>
          {serverError}
        </p>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Guardando…' : isNew ? 'Crear trabajador' : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  );
}

function conceptsSummary(worker: WorkerDoc): { weeklyUsd: number; monthlyUsd: number } {
  let weeklyUsd = 0;
  let monthlyUsd = 0;
  for (const c of worker.concepts) {
    if (c.frequency === 'WEEKLY') weeklyUsd += c.amountUsd;
    else monthlyUsd += c.amountUsd;
  }
  return { weeklyUsd: round2(weeklyUsd), monthlyUsd: round2(monthlyUsd) };
}

function WorkersSection({ workers, reload }: { workers: WorkerDoc[]; reload: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'new' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const selected = workers.find((w) => w._id === selectedId) ?? null;
  const showForm = mode === 'new' || mode === 'edit';
  const formInitial = mode === 'edit' && selected ? workerToForm(selected) : blankWorkerForm();

  async function handleSave(form: WorkerFormState) {
    setSaving(true);
    setServerError('');
    try {
      const saved = await saveWorker(nominaDb(), {
        documentId: form.documentId,
        name: form.name,
        active: form.active,
        concepts: form.concepts,
      });
      setSelectedId(saved._id);
      setMode('view');
      reload();
    } catch (err) {
      setServerError((err as Error).message ?? 'Error al guardar el trabajador.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="nomina-split" style={{ gap: '20px' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {workers.length === 0 ? (
          <EmptyState title="Sin trabajadores registrados" />
        ) : (
          workers.map((w) => {
            const { weeklyUsd, monthlyUsd } = conceptsSummary(w);
            return (
              <div
                key={w._id}
                role="option"
                aria-selected={w._id === selectedId}
                tabIndex={0}
                onClick={() => { setSelectedId(w._id); setMode('view'); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedId(w._id); setMode('view'); } }}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px',
                  padding: '12px 14px', borderRadius: '8px', cursor: 'pointer',
                  background: w._id === selectedId ? 'rgba(181,23,92,0.08)' : 'var(--color-cloth)',
                  border: `1.5px solid ${w._id === selectedId ? 'var(--color-dye)' : 'var(--color-thread)'}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600, color: 'var(--color-ink)' }}>
                      {w.name}
                    </span>
                    <Badge tone={w.active ? 'ok' : 'neutral'}>{w.active ? 'Activo' : 'Inactivo'}</Badge>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', marginTop: '2px' }}>
                    {w.documentId}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                    {w.concepts.map((c, i) => (
                      <Badge key={i} tone="neutral">{c.label} · {FREQ_LABEL[c.frequency]}</Badge>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)' }}>
                  {weeklyUsd > 0 && <div>Sem. {weeklyUsd.toFixed(2)}</div>}
                  {monthlyUsd > 0 && <div>Mes {monthlyUsd.toFixed(2)}</div>}
                </div>
              </div>
            );
          })
        )}
        <div>
          <Button variant="primary" onClick={() => { setSelectedId(null); setMode('new'); setServerError(''); }}>
            + Nuevo trabajador
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {showForm ? (
          <WorkerForm
            initial={formInitial}
            isNew={mode === 'new'}
            onSave={handleSave}
            onCancel={() => { setMode('view'); setServerError(''); }}
            saving={saving}
            serverError={serverError}
          />
        ) : selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <Button variant="ghost" onClick={() => { setMode('edit'); setServerError(''); }}>
              Editar trabajador
            </Button>
          </div>
        ) : (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)' }}>
            Selecciona un trabajador para ver o editar sus detalles.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── HISTORIAL ────────────────────────────────────────────────────────────

function HistorySection({ pays, workers }: { pays: PayrollPayDoc[]; workers: WorkerDoc[] }) {
  if (pays.length === 0) {
    return <EmptyState title="Sin pagos registrados" />;
  }
  const nameFor = (workerId: string) => workers.find((w) => w._id === workerId)?.name ?? workerId;
  return (
    <div style={{ background: 'var(--color-cloth)', border: '1px dashed var(--color-thread)', borderRadius: '10px', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-thread)' }}>
            {['Fecha', 'Trabajador', 'Conceptos', 'Método', 'Total'].map((h) => (
              <th key={h} style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-thread)', padding: '10px 14px', textAlign: h === 'Total' ? 'right' : 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pays.map((p, i) => (
            <tr key={p._id} style={{ borderBottom: i < pays.length - 1 ? '1px solid rgba(138,131,113,0.15)' : 'none' }}>
              <td style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', padding: '10px 14px' }}>
                {fmtDateTime(p.date)}
              </td>
              <td style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', padding: '10px 14px' }}>
                {nameFor(p.workerId)}
              </td>
              <td style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', padding: '10px 14px' }}>
                {p.lines.map((l) => `${l.label} (${periodLabel(l.periodKey)})`).join(', ')}
              </td>
              <td style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', padding: '10px 14px' }}>
                {p.entryMethod === 'CASH' ? 'Efectivo' : 'Transferencia'}
              </td>
              <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                {/* Own locked rate — never today's. */}
                <Money usd={p.totalUsd} rate={p.exchangeRateBCV} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── ADMIN SHELL ──────────────────────────────────────────────────────────

function NominaAdmin() {
  const { data, reload } = useNominaData();
  const [rate, setRate] = useState(0);
  const [payDialog, setPayDialog] = useState<WorkerDue | null>(null);

  // Re-read on every nómina data refresh too — cheap, and keeps the dues
  // display's Bs figures current without a second live subscription to the
  // main db (getConfig is a single doc read, same one-shot pattern
  // GastosIsland uses at submit time).
  useEffect(() => {
    getConfig(db).then((cfg) => setRate(cfg?.currentDailyRateBCV ?? 0)).catch(() => setRate(0));
  }, [data]);

  if (!data) {
    return null;
  }

  const dues = dueSummary(data.workers, data.duePays, new Date());

  return (
    <div style={{ maxWidth: '960px', display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <section>
        <h2 style={sectionTitleStyle}>Pagos pendientes</h2>
        <DueSection dues={dues} rate={rate} onPay={setPayDialog} />
      </section>

      <hr style={{ border: 'none', borderTop: '1px dashed var(--color-thread)' }} />

      <section>
        <h2 style={sectionTitleStyle}>Trabajadores</h2>
        <WorkersSection workers={data.workers} reload={reload} />
      </section>

      <hr style={{ border: 'none', borderTop: '1px dashed var(--color-thread)' }} />

      <section>
        <h2 style={sectionTitleStyle}>Historial de pagos</h2>
        <HistorySection pays={data.historyPays} workers={data.workers} />
      </section>

      {payDialog && (
        <PayDialog worker={payDialog.worker} due={payDialog.due} onClose={() => setPayDialog(null)} />
      )}
    </div>
  );
}

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '14px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--color-thread)',
  margin: '0 0 12px',
};

// ─── PAGE ─────────────────────────────────────────────────────────────────

export default function NominaIsland() {
  // Display-only gate — the real boundary is the nómina DB's own `_security`
  // (admins/members = APP_ROLE-admin only); a non-admin device never even
  // syncs this database.
  if (!isAdmin()) {
    return (
      <div style={{ maxWidth: '860px' }}>
        <PageHeader />
        <EmptyState title="Solo administradores pueden ver la nómina." />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '960px' }}>
      <PageHeader />
      <NominaAdmin />
    </div>
  );
}

function PageHeader() {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
        Nómina
      </h1>
      <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginTop: '4px' }}>
        Salarios y bonos del personal — solo administradores.{' '}
        <span className="kbd-hints"><Kbd>g n</Kbd> para volver aquí.</span>
      </p>
    </div>
  );
}
