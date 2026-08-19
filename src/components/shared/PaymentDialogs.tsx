// Cobro + vuelto dialogs, shared by the Panel and the client card.
// Moved verbatim from Dashboard.tsx when /clientes gained direct collection.
// UI: SPANISH. Code/fields: ENGLISH.

import { useEffect, useRef, useState } from 'react';
import { db } from '../../lib/db';
import { usdPaid, SETTLED_EPSILON, uuidv4 } from '../../lib/queries';
import { recordPayment, recordRefund } from '../../lib/payments';
import { cachedUser } from '../../lib/auth';
import { fmtUsd, fmtBs, fmtDateTime, toBs, round2 } from '../../lib/format';
import { Button, Field, Input, NumberInput } from '../ui';
import type { SaleDoc } from '../../lib/types';

/**
 * Records a collection against a sale. Native <dialog>.showModal() — backdrop,
 * Esc-to-close and the focus trap come free, so there is no overlay CSS here.
 */
export function CollectDialog({
  sale,
  owedUsd,
  rate,
  clientName,
  onClose,
}: {
  sale: SaleDoc;
  owedUsd: number;
  rate: number | undefined;
  clientName: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Minted once when the dialog opens — every submit (including a retry after a
  // dropped connection) carries the same paymentUid, so recordPayment is idempotent.
  const paymentMeta = useRef({ date: new Date().toISOString(), paymentUid: uuidv4() });
  // The balance is the usual collection — prefill cash, let the operator split it.
  const [cash, setCash] = useState(owedUsd.toFixed(2));
  const [transfer, setTransfer] = useState('');
  const [bs, setBs] = useState('');
  const [note, setNote] = useState('');
  const [allowOverpayment, setAllowOverpayment] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const num = (s: string) => Number(s) || 0;
  const enteredUsd = rate ? usdPaid(num(cash), num(transfer), num(bs), rate) : 0;
  const overpaid = enteredUsd > owedUsd + SETTLED_EPSILON;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!rate) {
      setError('No hay tasa del día registrada. Actualízala en Ajustes antes de registrar un cobro.');
      return;
    }
    setSaving(true);
    try {
      await recordPayment(db, {
        saleId: sale._id,
        exchangeRateBCV: rate,
        paidUsdCash: num(cash),
        paidUsdTransfer: num(transfer),
        paidBs: num(bs),
        note,
        operatorId: cachedUser()?.name ?? 'desconocido',
        allowOverpayment,
        date: paymentMeta.current.date,
        paymentUid: paymentMeta.current.paymentUid,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Error desconocido.');
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Registrar cobro"
      style={{
        border: '1px solid var(--color-thread)',
        borderRadius: '8px',
        background: 'var(--color-cloth)',
        padding: '20px 24px',
        width: 'min(420px, calc(100vw - 32px))',
        color: 'var(--color-ink)',
      }}
    >
      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <h2
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: 'var(--color-thread)',
              margin: '0 0 6px',
            }}
          >
            Registrar cobro
          </h2>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', margin: 0 }}>
            {clientName} · saldo <strong>{fmtUsd(owedUsd)}</strong>
            {rate ? ` · ${fmtBs(toBs(owedUsd, rate))}` : ''}
          </p>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)', margin: '4px 0 0' }}>
            {fmtDateTime(sale.date)}
          </p>
        </div>

        <div className="form-grid-2">
          <Field label="Efectivo $">
            <NumberInput value={cash} min="0" step="0.01" placeholder="0.00" autoFocus onChange={(e) => setCash(e.target.value)} />
          </Field>
          <Field label="Transferencia $">
            <NumberInput value={transfer} min="0" step="0.01" placeholder="0.00" onChange={(e) => setTransfer(e.target.value)} />
          </Field>
        </div>
        <Field label="Bolívares" hint={rate ? `A la tasa de hoy: ${fmtBs(rate)}/$` : 'Sin tasa del día'}>
          <NumberInput value={bs} min="0" step="0.01" placeholder="0,00" onChange={(e) => setBs(e.target.value)} />
        </Field>
        <Field label="Referencia">
          <Input value={note} placeholder="Nº de transferencia, recibo…" onChange={(e) => setNote(e.target.value)} />
        </Field>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', margin: 0 }}>
          Total del cobro: <strong style={{ color: 'var(--color-ink)' }}>{fmtUsd(round2(enteredUsd))}</strong>
          {overpaid
            ? ` · Quedará ${fmtUsd(round2(enteredUsd - owedUsd))} a favor del cliente`
            : ` · queda ${fmtUsd(round2(Math.max(0, owedUsd - enteredUsd)))}`}
        </p>

        {overpaid && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-ink)' }}>
            <input
              type="checkbox"
              checked={allowOverpayment}
              onChange={(e) => setAllowOverpayment(e.target.checked)}
            />
            Registrar el excedente como saldo a favor (sin vuelto ahora)
          </label>
        )}

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
            {saving ? 'Registrando…' : 'Registrar cobro'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Records change handed back to the client. Structural copy of CollectDialog —
 * same open/close/saving pattern, opposite direction of money.
 */
export function RefundDialog({
  sale,
  creditUsd,
  rate,
  clientName,
  onClose,
}: {
  sale: SaleDoc;
  creditUsd: number;
  rate: number | undefined;
  clientName: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Minted once when the dialog opens — every submit (including a retry after a
  // dropped connection) carries the same refundUid, so recordRefund is idempotent.
  const refundMeta = useRef({ date: new Date().toISOString(), refundUid: uuidv4() });
  const [cash, setCash] = useState(creditUsd.toFixed(2));
  const [transfer, setTransfer] = useState('');
  const [bs, setBs] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const num = (s: string) => Number(s) || 0;
  const enteredUsd = rate ? usdPaid(num(cash), num(transfer), num(bs), rate) : 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!rate) {
      setError('No hay tasa del día registrada. Actualízala en Ajustes antes de entregar un vuelto.');
      return;
    }
    setSaving(true);
    try {
      await recordRefund(db, {
        saleId: sale._id,
        exchangeRateBCV: rate,
        givenUsdCash: num(cash),
        givenUsdTransfer: num(transfer),
        givenBs: num(bs),
        note,
        operatorId: cachedUser()?.name ?? 'desconocido',
        date: refundMeta.current.date,
        refundUid: refundMeta.current.refundUid,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Error desconocido.');
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Entregar vuelto"
      style={{
        border: '1px solid var(--color-thread)',
        borderRadius: '8px',
        background: 'var(--color-cloth)',
        padding: '20px 24px',
        width: 'min(420px, calc(100vw - 32px))',
        color: 'var(--color-ink)',
      }}
    >
      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <h2
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: 'var(--color-thread)',
              margin: '0 0 6px',
            }}
          >
            Entregar vuelto
          </h2>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', margin: 0 }}>
            {clientName} · a favor <strong>{fmtUsd(creditUsd)}</strong>
            {rate ? ` · ${fmtBs(toBs(creditUsd, rate))}` : ''}
          </p>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)', margin: '4px 0 0' }}>
            {fmtDateTime(sale.date)}
          </p>
        </div>

        <div className="form-grid-2">
          <Field label="Efectivo $">
            <NumberInput value={cash} min="0" step="0.01" placeholder="0.00" autoFocus onChange={(e) => setCash(e.target.value)} />
          </Field>
          <Field label="Transferencia $">
            <NumberInput value={transfer} min="0" step="0.01" placeholder="0.00" onChange={(e) => setTransfer(e.target.value)} />
          </Field>
        </div>
        <Field label="Bolívares" hint={rate ? `A la tasa de hoy: ${fmtBs(rate)}/$` : 'Sin tasa del día'}>
          <NumberInput value={bs} min="0" step="0.01" placeholder="0,00" onChange={(e) => setBs(e.target.value)} />
        </Field>
        <Field label="Referencia">
          <Input value={note} placeholder="Nº de transferencia, recibo…" onChange={(e) => setNote(e.target.value)} />
        </Field>

        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', margin: 0 }}>
          Total del vuelto: <strong style={{ color: 'var(--color-ink)' }}>{fmtUsd(round2(enteredUsd))}</strong>
          {' · '}Quedará a favor: {fmtUsd(round2(Math.max(0, creditUsd - enteredUsd)))}
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
            {saving ? 'Entregando…' : 'Entregar vuelto'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
