// ClientsPage — master-detail clients view. Spanish UI, English code.
// client:only="react" (PouchDB browser-only).

import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../../lib/db';
import { useLiveQuery } from '../../lib/hooks';
import { getClients, getSales, saveClient } from '../../lib/queries';
import type { ClientDoc, SaleDoc, EntityType } from '../../lib/types';
import { fmtDate } from '../../lib/format';
import {
  Button,
  Input,
  Select,
  Field,
  Badge,
  EmptyState,
  Money,
  Kbd,
} from '../ui';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: 'Persona natural',
  COMPANY: 'Empresa',
};

const STATUS_LABELS: Record<string, string> = {
  PAID: 'Pagado',
  PARTIAL: 'Parcial',
  PENDING: 'Pendiente',
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger'> = {
  PAID: 'ok',
  PARTIAL: 'warn',
  PENDING: 'danger',
};

// ─── VALIDATION ──────────────────────────────────────────────────────────────

interface FormErrors {
  documentId?: string;
  name?: string;
  email?: string;
}

function validateForm(form: ClientFormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.documentId.trim()) errors.documentId = 'La cédula o RIF es obligatorio.';
  if (!form.name.trim()) errors.name = 'El nombre es obligatorio.';
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'El correo electrónico no es válido.';
  }
  return errors;
}

// ─── FORM STATE ──────────────────────────────────────────────────────────────

interface ClientFormState {
  documentId: string;
  entityType: EntityType;
  name: string;
  address: string;
  phoneNumber: string;
  email: string;
  specialty: string; // comma-separated input
}

function blankForm(): ClientFormState {
  return {
    documentId: '',
    entityType: 'PERSON',
    name: '',
    address: '',
    phoneNumber: '',
    email: '',
    specialty: '',
  };
}

function clientToForm(c: ClientDoc): ClientFormState {
  return {
    documentId: c.documentId,
    entityType: c.entityType,
    name: c.name,
    address: c.address,
    phoneNumber: c.phoneNumber,
    email: c.email,
    specialty: c.specialty.join(', '),
  };
}

// ─── OUTSTANDING BALANCE ─────────────────────────────────────────────────────

/** Sum of USD owed across unpaid/partial sales. Display-only; derived. */
function outstandingUsd(sales: SaleDoc[]): number {
  let total = 0;
  for (const s of sales) {
    if (s.paymentStatus === 'PAID') continue;
    const paidUsd =
      s.paidUsdCash +
      s.paidUsdTransfer +
      (s.exchangeRateBCV > 0 ? s.paidBs / s.exchangeRateBCV : 0);
    total += Math.max(0, s.totalUsd - paidUsd);
  }
  return total;
}

// ─── DETAIL PANEL ────────────────────────────────────────────────────────────

interface DetailPanelProps {
  client: ClientDoc | null;
  onEdit: () => void;
}

function ClientSales({ clientId }: { clientId: string }) {
  const { data: sales } = useLiveQuery<SaleDoc[]>(
    (database) => getSales(database, { descending: true }),
    [clientId],
  );

  const clientSales = (sales ?? []).filter((s) => s.clientId === clientId);
  const owed = outstandingUsd(clientSales);

  if (clientSales.length === 0) {
    return (
      <p
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          color: 'var(--color-thread)',
          margin: 0,
        }}
      >
        Sin ventas registradas.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {owed > 0.005 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(163,46,46,0.08)',
            border: '1px solid rgba(163,46,46,0.20)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--color-danger)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            Saldo pendiente
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--color-danger)',
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            <Money usd={owed} />
          </span>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr
            style={{
              borderBottom: '1px solid var(--color-thread)',
            }}
          >
            {(['Fecha', 'Total', 'Estado'] as const).map((h) => (
              <th
                key={h}
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: 'var(--color-thread)',
                  padding: '6px 0',
                  textAlign: h === 'Total' || h === 'Estado' ? 'right' : 'left',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clientSales.map((sale) => (
            <tr
              key={sale._id}
              style={{ borderBottom: '1px solid rgba(138,131,113,0.12)' }}
            >
              <td
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '13px',
                  color: 'var(--color-ink)',
                  padding: '8px 0',
                }}
              >
                {fmtDate(sale.date)}
              </td>
              <td style={{ textAlign: 'right', padding: '8px 0' }}>
                <Money usd={sale.totalUsd} />
              </td>
              <td style={{ textAlign: 'right', padding: '8px 0' }}>
                <Badge tone={STATUS_TONE[sale.paymentStatus]}>
                  {STATUS_LABELS[sale.paymentStatus]}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailPanel({ client, onEdit }: DetailPanelProps) {
  if (!client) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--color-thread)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
        }}
      >
        Selecciona un cliente para ver los detalles.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '4px 0' }}>
      {/* Client card */}
      <div
        style={{
          background: 'var(--color-cloth)',
          border: '1px dashed var(--color-thread)',
          borderRadius: '8px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '18px',
                fontWeight: 700,
                color: 'var(--color-ink)',
                lineHeight: 1.2,
              }}
            >
              {client.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                color: 'var(--color-thread)',
                marginTop: '4px',
              }}
            >
              {client.documentId}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <Badge tone="neutral">{ENTITY_LABELS[client.entityType]}</Badge>
            <Button variant="ghost" size="md" onClick={onEdit}>
              Editar
            </Button>
          </div>
        </div>

        <div className="form-grid-2">
          {client.phoneNumber && (
            <InfoRow label="Teléfono" value={client.phoneNumber} />
          )}
          {client.email && (
            <InfoRow label="Correo" value={client.email} />
          )}
          {client.address && (
            <InfoRow label="Dirección" value={client.address} span />
          )}
          {client.specialty.length > 0 && (
            <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: 'var(--color-thread)',
                }}
              >
                Especialidad
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {client.specialty.map((s) => (
                  <Badge key={s} tone="neutral">{s}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sales */}
      <div>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: 'var(--color-thread)',
            marginBottom: '12px',
          }}
        >
          Ventas del cliente
        </div>
        <ClientSales clientId={client._id} />
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  span,
}: {
  label: string;
  value: string;
  span?: boolean;
}) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : undefined, display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--color-thread)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '14px',
          color: 'var(--color-ink)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── CLIENT FORM ─────────────────────────────────────────────────────────────

interface ClientFormProps {
  initial: ClientFormState;
  isNew: boolean;
  onSave: (form: ClientFormState) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  serverError: string;
}

function ClientForm({ initial, isNew, onSave, onCancel, saving, serverError }: ClientFormProps) {
  const [form, setForm] = useState<ClientFormState>(initial);
  const [errors, setErrors] = useState<FormErrors>({});

  // Sync initial when it changes (switching selected client)
  useEffect(() => {
    setForm(initial);
    setErrors({});
  }, [initial]);

  const set = (field: keyof ClientFormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateForm(form);
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    setErrors({});
    await onSave(form);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <Field label="Cédula / RIF" error={errors.documentId}>
        {isNew ? (
          <Input
            value={form.documentId}
            onChange={set('documentId')}
            placeholder="V-12345678 / J-12345678-9"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '14px' }}
            autoFocus
          />
        ) : (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
              color: 'var(--color-ink)',
              padding: '10px 12px',
              background: 'rgba(138,131,113,0.08)',
              borderRadius: '6px',
              border: '1.5px solid var(--color-thread)',
            }}
          >
            {form.documentId}
          </div>
        )}
      </Field>

      <Field label="Tipo de entidad">
        <Select value={form.entityType} onChange={set('entityType')}>
          <option value="PERSON">Persona natural</option>
          <option value="COMPANY">Empresa</option>
        </Select>
      </Field>

      <Field label="Nombre" error={errors.name}>
        <Input value={form.name} onChange={set('name')} placeholder="Nombre completo o razón social" />
      </Field>

      <Field label="Teléfono">
        <Input value={form.phoneNumber} onChange={set('phoneNumber')} placeholder="+58 412-000-0000" type="tel" />
      </Field>

      <Field label="Correo electrónico" error={errors.email}>
        <Input value={form.email} onChange={set('email')} placeholder="correo@ejemplo.com" type="email" />
      </Field>

      <Field label="Dirección">
        <Input value={form.address} onChange={set('address')} placeholder="Dirección completa" />
      </Field>

      <Field label="Especialidad" hint="Separado por comas: telas, confección, etc.">
        <Input value={form.specialty} onChange={set('specialty')} placeholder="telas, confección, exportación" />
      </Field>

      {serverError && (
        <p
          role="alert"
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            color: 'var(--color-danger)',
            margin: 0,
          }}
        >
          {serverError}
        </p>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancelar
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Guardando…' : isNew ? 'Crear cliente' : 'Guardar cambios'}
        </Button>
      </div>
    </form>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const { data: clients } = useLiveQuery<ClientDoc[]>((database) => getClients(database));

  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'new' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  // Filter clients
  const q = filter.toLowerCase();
  const filtered = (clients ?? []).filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.documentId.toLowerCase().includes(q),
  );

  const selectedClient = (clients ?? []).find((c) => c._id === selectedId) ?? null;
  const selectedIdx = filtered.findIndex((c) => c._id === selectedId);

  // Keyboard navigation: ArrowUp/Down moves selection; Enter selects; "n" opens new form
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTypingInForm =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Allow navigation even when filter input is focused
        if (isTypingInForm && target !== searchRef.current) return;
        e.preventDefault();
        const next =
          e.key === 'ArrowDown'
            ? Math.min(selectedIdx + 1, filtered.length - 1)
            : Math.max(selectedIdx - 1, 0);
        if (filtered[next]) {
          setSelectedId(filtered[next]._id);
          setMode('view');
          rowRefs.current[next]?.focus();
        }
        return;
      }

      if (e.key === 'Enter' && !isTypingInForm && selectedId) {
        e.preventDefault();
        setMode('view');
        return;
      }

      if (e.key === 'Escape') {
        // Close form if open (mode is in deps so this reads current value)
        e.preventDefault();
        setMode('view');
        setServerError('');
        return;
      }

      if (e.key.toLowerCase() === 'n' && !isTypingInForm) {
        e.preventDefault();
        openNew();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selectedIdx, selectedId]);

  const openNew = () => {
    setSelectedId(null);
    setMode('new');
    setServerError('');
  };

  const openEdit = () => {
    setMode('edit');
    setServerError('');
  };

  const handleSave = useCallback(
    async (form: ClientFormState) => {
      setSaving(true);
      setServerError('');
      try {
        const saved = await saveClient(db, {
          documentId: form.documentId,
          entityType: form.entityType,
          name: form.name,
          address: form.address,
          phoneNumber: form.phoneNumber,
          email: form.email,
          specialty: form.specialty
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        });
        setSelectedId(saved._id);
        setMode('view');
      } catch (err) {
        setServerError((err as Error).message ?? 'Error al guardar el cliente.');
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleCancel = () => {
    setMode('view');
    setServerError('');
  };

  // Form initial state derives from selected client (edit) or blank (new)
  const formInitial: ClientFormState =
    mode === 'edit' && selectedClient
      ? clientToForm(selectedClient)
      : blankForm();

  const showForm = mode === 'new' || mode === 'edit';

  if (clients !== undefined && clients.length === 0 && mode === 'view') {
    return (
      <div>
        <PageHeader onNew={openNew} />
        <EmptyState
          title="Sin clientes todavía"
          action={
            <Button variant="primary" onClick={openNew}>
              Nuevo cliente
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0', height: '100%' }}>
      <PageHeader onNew={openNew} />

      {/* Master-detail split */}
      <div className="clients-split">
        {/* LEFT — list */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            overflowY: 'auto',
            paddingRight: '16px',
          }}
        >
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Input
              ref={searchRef}
              data-hotkey-search
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // Esc clears the search text; a second Esc bubbles up to the
                // page handler (closes the edit form).
                if (e.key === 'Escape' && filter) {
                  e.stopPropagation();
                  setFilter('');
                }
              }}
              placeholder="Buscar… (nombre o documento)"
              aria-label="Filtrar clientes"
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

          {/* Table */}
          {filtered.length === 0 ? (
            <p
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                color: 'var(--color-thread)',
                margin: 0,
                padding: '12px 0',
              }}
            >
              No hay clientes con ese criterio.
            </p>
          ) : (
            <div
              role="listbox"
              aria-label="Lista de clientes"
              style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
            >
              {filtered.map((client, idx) => {
                const isSelected = client._id === selectedId;
                return (
                  <div
                    key={client._id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    ref={(el) => { rowRefs.current[idx] = el as HTMLTableRowElement | null; }}
                    onClick={() => {
                      setSelectedId(client._id);
                      setMode('view');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(client._id);
                        setMode('view');
                      }
                    }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: '6px',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: isSelected
                        ? 'rgba(181,23,92,0.08)'
                        : 'transparent',
                      border: `1.5px solid ${isSelected ? 'var(--color-dye)' : 'transparent'}`,
                      outline: 'none',
                      transition: 'background 0.1s, border-color 0.1s',
                      alignItems: 'start',
                    }}
                    onFocus={(e) => {
                      if (e.target === e.currentTarget) {
                        (e.target as HTMLElement).style.boxShadow = '0 0 0 2px var(--color-dye)';
                      }
                    }}
                    onBlur={(e) => {
                      (e.target as HTMLElement).style.boxShadow = '';
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: 'var(--font-sans)',
                          fontSize: '14px',
                          fontWeight: 600,
                          color: 'var(--color-ink)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {client.name}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '12px',
                          color: 'var(--color-thread)',
                          marginTop: '2px',
                        }}
                      >
                        {client.documentId}
                      </div>
                      {client.specialty.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                          {client.specialty.slice(0, 3).map((s) => (
                            <Badge key={s} tone="neutral">{s}</Badge>
                          ))}
                          {client.specialty.length > 3 && (
                            <Badge tone="neutral">+{client.specialty.length - 3}</Badge>
                          )}
                        </div>
                      )}
                    </div>
                    <Badge tone="neutral">{client.entityType === 'PERSON' ? 'Natural' : 'Jurídica'}</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div
          aria-hidden="true"
          style={{
            background: 'var(--color-thread)',
            opacity: 0.25,
            margin: '0 20px',
          }}
        />

        {/* RIGHT — detail / form */}
        <div style={{ overflowY: 'auto', paddingLeft: '4px' }}>
          {showForm ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <h2
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '16px',
                  fontWeight: 700,
                  color: 'var(--color-ink)',
                  margin: 0,
                }}
              >
                {mode === 'new' ? 'Nuevo cliente' : 'Editar cliente'}
              </h2>
              <ClientForm
                initial={formInitial}
                isNew={mode === 'new'}
                onSave={handleSave}
                onCancel={handleCancel}
                saving={saving}
                serverError={serverError}
              />
            </div>
          ) : (
            <DetailPanel client={selectedClient} onEdit={openEdit} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PAGE HEADER ─────────────────────────────────────────────────────────────

function PageHeader({ onNew }: { onNew: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '20px',
      }}
    >
      <div>
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
          Clientes
        </h1>
        <p
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            color: 'var(--color-thread)',
            margin: '2px 0 0',
          }}
          className="kbd-hints"
        >
          <Kbd>/</Kbd> buscar &nbsp;·&nbsp; <Kbd>↑↓</Kbd> navegar &nbsp;·&nbsp; <Kbd>n</Kbd> nuevo cliente
        </p>
      </div>
      <Button variant="primary" onClick={onNew}>
        + Nuevo cliente
      </Button>
    </div>
  );
}
