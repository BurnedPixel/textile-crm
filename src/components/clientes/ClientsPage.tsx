// ClientsPage — master-detail clients view. Spanish UI, English code.
// client:only="react" (PouchDB browser-only).

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { db } from '../../lib/db';
import { useLiveQuery } from '../../lib/hooks';
import { getClients, getSales, saveClient, usdPaid, grandTotalUsd, getFiscalConfig, getConfig } from '../../lib/queries';
import { CollectDialog, RefundDialog } from '../shared/PaymentDialogs';
import { waLink, buildDunningText, toWaNumber } from '../../lib/whatsapp';
import {
  getPayments, paymentsBySale, saleBalance,
  getRefunds, refundsBySale, clientBalance,
} from '../../lib/payments';
import { SETTLED_EPSILON } from '../../lib/queries';
import {
  FIELD_MAX, validateDocumentId, validateEmail, validateName, validatePhone, normalizePhone,
  type ClientDoc, type SaleDoc, type PaymentDoc, type RefundDoc, type EntityType,
} from '../../lib/types';
import { fmtDate, fmtUsd, PAYMENT_LABEL, PAYMENT_TONE } from '../../lib/format';
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

// ─── VALIDATION ──────────────────────────────────────────────────────────────

interface FormErrors {
  documentId?: string;
  name?: string;
  phoneNumber?: string;
  email?: string;
}

/**
 * The same functions `saveClient` enforces — this only decides WHERE the message
 * appears. Duplicating the rules here is how the two client forms drifted apart
 * in the first place.
 */
function validateForm(form: ClientFormState): FormErrors {
  const errors: FormErrors = {};
  const documentId = validateDocumentId(form.documentId);
  const name = validateName(form.name);
  const phoneNumber = validatePhone(form.phoneNumber);
  const email = validateEmail(form.email);
  if (documentId) errors.documentId = documentId;
  if (name) errors.name = name;
  if (phoneNumber) errors.phoneNumber = phoneNumber;
  if (email) errors.email = email;
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
    phoneNumber: '+58 ',
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
    // Legacy numbers display canonically; un-normalizable ones show raw so the
    // operator can fix them (normalizePhone returns null, not '', on those).
    phoneNumber: normalizePhone(c.phoneNumber) ?? c.phoneNumber,
    email: c.email,
    specialty: c.specialty.join(', '),
  };
}

// ─── DETAIL PANEL ────────────────────────────────────────────────────────────

interface DetailPanelProps {
  client: ClientDoc | null;
  ledger: Ledger;
  onEdit: () => void;
  /** Razón social, so the WhatsApp message says who is writing. */
  businessName?: string;
}

/** The sale + payment + refund ledgers, scanned ONCE for the page (see ClientsPage). */
interface Ledger {
  sales: SaleDoc[];
  payments: PaymentDoc[];
  refunds: RefundDoc[];
}

/**
 * Presentational. The ledgers are scanned once by the page and filtered here —
 * this component used to run its own two unbounded scans keyed on `clientId`, so
 * every click on the client list re-read every sale and every payment ever made.
 */
function ClientSales({ client, ledger, businessName }: { client: ClientDoc; ledger: Ledger; businessName?: string }) {
  const clientId = client._id;
  // Settle debts (and hand back vueltos) right here — before this, the only
  // path was hunting the sale down on the Panel, whose lists cap at 90 days.
  const { data: config } = useLiveQuery((d) => getConfig(d));
  const [action, setAction] = useState<{ kind: 'collect' | 'refund'; sale: SaleDoc; amountUsd: number } | null>(null);
  const clientSales = ledger.sales.filter((s) => s.clientId === clientId);
  const paymentsFor = paymentsBySale(ledger.payments);
  const refundsFor = refundsBySale(ledger.refunds);
  const { owedToBusinessUsd: owed, owedToClientUsd: credit } = clientBalance(clientSales, paymentsFor, refundsFor);
  // Payments/refunds belong to a sale, not a client — reach the client's through their sales.
  const saleIds = new Set(clientSales.map((s) => s._id));
  const clientPayments = ledger.payments.filter((p) => saleIds.has(p.saleId));
  const clientRefunds = ledger.refunds.filter((r) => saleIds.has(r.saleId));

  // null when the stored number cannot become a wa.me number — passing
  // validatePhone says nothing about that (a 7-digit local number is a valid
  // phone and an undiallable link).
  const unpaidCount = clientSales.filter(
    (s) => saleBalance(s, paymentsFor.get(s._id) ?? [], refundsFor.get(s._id) ?? []).owedUsd > 0.005,
  ).length;
  // Dunning is gated ONLY on owed-to-business — a saldo a favor never blocks it.
  const dunningLink = owed > 0.005
    ? waLink(client.phoneNumber, buildDunningText({
        clientName: client.name, owedUsd: owed, saleCount: unpaidCount, businessName,
      }))
    : null;

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

      {credit > SETTLED_EPSILON && (
        <div
          data-credit-banner
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(62,107,58,0.08)',
            border: '1px solid rgba(62,107,58,0.20)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--color-ok)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            A favor del cliente
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--color-ok)',
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            <Money usd={credit} />
          </span>
        </div>
      )}

      {/* Cobro por WhatsApp — human-pressed. Hidden when the stored number
          cannot be dialled: better no button than a chat with nobody. This is
          the client card and not the Panel's pending list on purpose — that one
          is per SALE (three unpaid sales would mean three buttons and three
          messages) and capped at 90 days, so the oldest debts have no button at
          all. Here the balance is already the client's whole ledger. */}
      {dunningLink && (
        <a
          data-wa-dunning
          href={dunningLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            alignSelf: 'flex-start', minHeight: '44px', padding: '0 16px', borderRadius: '6px',
            border: '1.5px solid var(--color-ok)', color: 'var(--color-ok)',
            fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
            textDecoration: 'none', backgroundColor: 'transparent',
          }}
        >
          Recordar por WhatsApp
        </a>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr
            style={{
              borderBottom: '1px solid var(--color-thread)',
            }}
          >
            {(['Fecha', 'Total', 'Estado', ''] as const).map((h) => (
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
          {clientSales.map((sale) => {
            // Derived — never sale.paymentStatus, which is the checkout snapshot.
            const b = saleBalance(sale, paymentsFor.get(sale._id) ?? [], refundsFor.get(sale._id) ?? []);
            const status = b.status;
            return (
              <tr
                key={sale._id}
                data-sale-row={sale._id}
                role="button"
                tabIndex={0}
                onClick={() => { window.location.href = `/ventas?${new URLSearchParams({ sale: sale._id })}`; }}
                onKeyDown={(e) => { if (e.key === 'Enter') window.location.href = `/ventas?${new URLSearchParams({ sale: sale._id })}`; }}
                style={{ borderBottom: '1px solid rgba(138,131,113,0.12)', cursor: 'pointer' }}
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
                  <Money usd={grandTotalUsd(sale)} />
                </td>
                <td style={{ textAlign: 'right', padding: '8px 0' }}>
                  <Badge tone={PAYMENT_TONE[status]}>{PAYMENT_LABEL[status]}</Badge>
                </td>
                <td
                  style={{ textAlign: 'right', padding: '8px 0' }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {b.owedUsd > SETTLED_EPSILON ? (
                    <Button
                      variant="ghost"
                      size="md"
                      data-collect-sale={sale._id}
                      onClick={(e) => { e.stopPropagation(); setAction({ kind: 'collect', sale, amountUsd: b.owedUsd }); }}
                    >
                      Cobrar
                    </Button>
                  ) : b.creditUsd > SETTLED_EPSILON ? (
                    <Button
                      variant="ghost"
                      size="md"
                      data-refund-sale={sale._id}
                      onClick={(e) => { e.stopPropagation(); setAction({ kind: 'refund', sale, amountUsd: b.creditUsd }); }}
                    >
                      Vuelto
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {action?.kind === 'collect' && (
        <CollectDialog
          sale={action.sale}
          owedUsd={action.amountUsd}
          rate={config?.currentDailyRateBCV}
          clientName={client.name}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'refund' && (
        <RefundDialog
          sale={action.sale}
          creditUsd={action.amountUsd}
          rate={config?.currentDailyRateBCV}
          clientName={client.name}
          onClose={() => setAction(null)}
        />
      )}

      {/* Collections + refunds recorded after checkout — otherwise the note
          captured with each one would be written and never readable anywhere.
          Merged into one list, oldest note first stays newest-first here (dates
          are ISO, so string sort matches time order). */}
      {(clientPayments.length > 0 || clientRefunds.length > 0) && (
        <div style={{ marginTop: '4px' }}>
          <h3
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--color-thread)',
              margin: '8px 0 6px',
            }}
          >
            Cobros y vueltos
          </h3>
          {[
            ...clientPayments.map((p) => ({
              kind: 'payment' as const,
              id: p._id,
              date: p.date,
              note: p.note,
              amountUsd: usdPaid(p.paidUsdCash, p.paidUsdTransfer, p.paidBs, p.exchangeRateBCV),
            })),
            ...clientRefunds.map((r) => ({
              kind: 'refund' as const,
              id: r._id,
              date: r.date,
              note: r.note,
              amountUsd: usdPaid(r.givenUsdCash, r.givenUsdTransfer, r.givenBs, r.exchangeRateBCV),
            })),
          ]
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((entry) => (
              <div
                key={entry.id}
                data-ledger-entry={entry.kind}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: '10px',
                  padding: '5px 0',
                  borderBottom: '1px solid rgba(138,131,113,0.12)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    color: entry.kind === 'refund' ? 'var(--color-ok)' : 'var(--color-ink)',
                  }}
                >
                  {fmtDate(entry.date)}
                  {entry.kind === 'refund' ? ' · Vuelto entregado' : ''}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '12px',
                    color: 'var(--color-thread)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.note}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '13px',
                    fontFeatureSettings: '"tnum" 1',
                    color: entry.kind === 'refund' ? 'var(--color-ok)' : undefined,
                  }}
                >
                  {entry.kind === 'refund' ? '− ' : ''}
                  {fmtUsd(entry.amountUsd)}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DetailPanel({ client, ledger, onEdit, businessName }: DetailPanelProps) {
  if (!client) {
    return (
      <div
        className="clients-empty-hint"
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
          className="client-card-head"
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
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0, alignItems: 'center' }}>
            <Badge tone="neutral">{ENTITY_LABELS[client.entityType]}</Badge>
            {/* Plain chat, no pre-written text — hidden when the stored number
                cannot become a wa.me link, same rule as the dunning button. */}
            {toWaNumber(client.phoneNumber) && (
              <a
                data-wa-chat
                href={`https://wa.me/${toWaNumber(client.phoneNumber)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: '36px', padding: '0 12px', borderRadius: '6px',
                  border: '1.5px solid var(--color-ok)', color: 'var(--color-ok)',
                  fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
                  textDecoration: 'none', backgroundColor: 'transparent', whiteSpace: 'nowrap',
                }}
              >
                Chat
              </a>
            )}
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
        <ClientSales client={client} ledger={ledger} businessName={businessName} />
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
      // noValidate: the browser's own constraint bubbles are in ITS language,
      // not the app's, and they fire before our Spanish messages can render.
      // Every other form here does the same. `type=email/tel` stays — it picks
      // the right mobile keyboard, which is all we want from it.
      noValidate
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      <Field label="Cédula / RIF" error={errors.documentId}>
        {isNew ? (
          <Input
            value={form.documentId}
            onChange={set('documentId')}
            placeholder="V-12345678 · E-84123456 · J-12345678-9"
            maxLength={FIELD_MAX.documentId}
            autoCapitalize="characters"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', textTransform: 'uppercase' }}
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
        <Input
          value={form.name}
          onChange={set('name')}
          placeholder="Nombre completo o razón social"
          maxLength={FIELD_MAX.name}
          autoComplete="name"
          autoCapitalize="characters"
          style={{ textTransform: 'uppercase' }}
        />
      </Field>

      <Field label="Teléfono" error={errors.phoneNumber}>
        <Input
          value={form.phoneNumber}
          onChange={set('phoneNumber')}
          placeholder="+58 412-1234567"
          type="tel"
          inputMode="tel"
          maxLength={FIELD_MAX.phoneNumber}
          autoComplete="tel"
        />
      </Field>

      <Field label="Correo electrónico" error={errors.email}>
        <Input
          value={form.email}
          onChange={set('email')}
          placeholder="correo@ejemplo.com"
          type="email"
          inputMode="email"
          maxLength={FIELD_MAX.email}
          autoComplete="email"
          autoCapitalize="none"
        />
      </Field>

      <Field label="Dirección">
        <Input
          value={form.address}
          onChange={set('address')}
          placeholder="Dirección completa"
          maxLength={FIELD_MAX.address}
          autoComplete="street-address"
        />
      </Field>

      <Field label="Especialidad" hint="Separado por comas: telas, confección, etc.">
        <Input value={form.specialty} onChange={set('specialty')} placeholder="telas, confección, exportación" maxLength={400} />
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
  const { data: fiscal } = useLiveQuery((database) => getFiscalConfig(database));
  // Scanned ONCE for the page, with no deps — selecting a client filters this in
  // memory instead of re-reading both ledgers. Refreshes on DB change like every
  // other live query.
  const { data: ledgerData } = useLiveQuery<Ledger>(async (database) => {
    const [sales, payments, refunds] = await Promise.all([
      getSales(database, { descending: true }),
      getPayments(database),
      getRefunds(database),
    ]);
    return { sales, payments, refunds };
  });
  const ledger: Ledger = ledgerData ?? { sales: [], payments: [], refunds: [] };

  // Per-client balance, computed once per ledger change — walk-in sales
  // (clientId null) have no client to attribute the balance to.
  const balances = useMemo(() => {
    const paymentsFor = paymentsBySale(ledger.payments);
    const refundsFor = refundsBySale(ledger.refunds);
    const salesByClient = new Map<string, SaleDoc[]>();
    for (const sale of ledger.sales) {
      if (!sale.clientId) continue;
      const list = salesByClient.get(sale.clientId);
      if (list) list.push(sale);
      else salesByClient.set(sale.clientId, [sale]);
    }
    const map = new Map<string, { owed: number; credit: number }>();
    for (const [clientId, sales] of salesByClient) {
      const { owedToBusinessUsd, owedToClientUsd } = clientBalance(sales, paymentsFor, refundsFor);
      map.set(clientId, { owed: owedToBusinessUsd, credit: owedToClientUsd });
    }
    return map;
  }, [ledger.sales, ledger.payments, ledger.refunds]);

  const [filter, setFilter] = useState('');
  const [balanceFilter, setBalanceFilter] = useState<'all' | 'debt' | 'credit'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'new' | 'edit'>('view');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  // Filter clients — text search AND balance filter
  const q = filter.toLowerCase();
  const filtered = (clients ?? []).filter((c) => {
    if (q && !c.name.toLowerCase().includes(q) && !c.documentId.toLowerCase().includes(q)) return false;
    const bal = balances.get(c._id);
    if (balanceFilter === 'debt') return (bal?.owed ?? 0) > SETTLED_EPSILON;
    if (balanceFilter === 'credit') return (bal?.credit ?? 0) > SETTLED_EPSILON;
    return true;
  });

  const debtCount = (clients ?? []).filter((c) => (balances.get(c._id)?.owed ?? 0) > SETTLED_EPSILON).length;
  const creditCount = (clients ?? []).filter((c) => (balances.get(c._id)?.credit ?? 0) > SETTLED_EPSILON).length;

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
      <div className={`clients-split${showForm ? ' form-open' : ''}`}>
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

          {/* Balance filter */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div
              data-balance-filter
              role="group"
              aria-label="Filtrar por saldo"
              style={{ display: 'flex', gap: '4px' }}
            >
              {([
                ['all', 'Todos'],
                ['debt', 'Con deuda'],
                ['credit', 'A favor'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-balance-filter-option={value}
                  aria-pressed={balanceFilter === value}
                  onClick={() => setBalanceFilter(value)}
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '11px',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    padding: '5px 10px',
                    borderRadius: '5px',
                    border: `1px solid ${balanceFilter === value ? 'var(--color-dye)' : 'var(--color-thread)'}`,
                    background: balanceFilter === value ? 'rgba(181,23,92,0.08)' : 'transparent',
                    color: balanceFilter === value ? 'var(--color-dye)' : 'var(--color-thread)',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {(debtCount > 0 || creditCount > 0) && (
              <div
                data-balance-summary
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  color: 'var(--color-thread)',
                }}
              >
                {[
                  debtCount > 0 ? `${debtCount} con deuda` : null,
                  creditCount > 0 ? `${creditCount} a favor` : null,
                ].filter(Boolean).join(' · ')}
              </div>
            )}
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
                const bal = balances.get(client._id);
                const rowOwed = bal?.owed ?? 0;
                const rowCredit = bal?.credit ?? 0;
                return (
                  <div
                    key={client._id}
                    role="option"
                    aria-selected={isSelected}
                    data-owed={rowOwed > SETTLED_EPSILON ? rowOwed : undefined}
                    data-credit={rowCredit > SETTLED_EPSILON ? rowCredit : undefined}
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
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                      <Badge tone="neutral">{client.entityType === 'PERSON' ? 'Natural' : 'Jurídica'}</Badge>
                      {rowOwed > SETTLED_EPSILON && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '11px',
                            fontWeight: 700,
                            color: 'var(--color-danger)',
                            fontFeatureSettings: '"tnum" 1',
                          }}
                        >
                          Debe {fmtUsd(rowOwed)}
                        </span>
                      )}
                      {rowCredit > SETTLED_EPSILON && (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: '11px',
                            fontWeight: 700,
                            color: 'var(--color-ok)',
                            fontFeatureSettings: '"tnum" 1',
                          }}
                        >
                          A favor {fmtUsd(rowCredit)}
                        </span>
                      )}
                    </div>
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
            <DetailPanel client={selectedClient} ledger={ledger} onEdit={openEdit} businessName={fiscal?.businessName} />
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
