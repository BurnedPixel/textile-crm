// Buscar y corregir — find a roll (usually by its lot number) and fix what is
// written on it.
//
// Two kinds of edit, kept apart on purpose:
//   · DETAILS (lot, pantone, composición, prices, condition) are plain fields
//     on the roll. Correcting a mistyped lot is an ordinary write precisely
//     because the lot was never put in the _id.
//   · WEIGHT is never edited directly. It moves through adjustStock, which
//     writes an ADJUST movement — the ledger is the truth the cached counters
//     are recomputed from, so a direct write here would be invisible to the
//     recompute and silently undone by the next conflict.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../../lib/db';
import { cachedUser } from '../../lib/auth';
import { getProductsWithBatch } from '../../lib/queries';
import { getCatalog } from '../../lib/catalog';
import { updateRollDetails, adjustStock } from '../../lib/inventory';
import { useLiveQuery } from '../../lib/hooks';
import { hasRollStock, type BatchDoc, type ConditionTag, type ProductDoc } from '../../lib/types';
import {
  fmtKg, fmtUnits, fmtLot, fmtPiece, fmtUsd, CONDITION_LABEL, CONDITION_SHORT, CONDITION_TONE,
  NM_LABEL,
} from '../../lib/format';
import { Button, Input, NumberInput, Select, Field, Kbd, SwatchChip, Badge, EmptyState } from '../ui';
import {
  sectionStyle, sectionTitle, alertOk, alertErr, rollListBox, rollRowStyle,
} from './styles';

const CONDITIONS = (Object.keys(CONDITION_LABEL) as ConditionTag[]).map((value) => ({
  value,
  label: CONDITION_LABEL[value],
}));

/** Accent- and case-insensitive fold, same rule the rest of the app searches by. */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

interface Row {
  batch: BatchDoc;
  product: ProductDoc;
}

interface EditPaneProps {
  /** Told after every write so the shell can refresh the ledger. */
  onDone?: () => void;
}

export default function EditPane({ onDone }: EditPaneProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // details form
  const [form, setForm] = useState({
    lotNumber: '', pantone: '', fiberComposition: '',
    purchaseValueUsd: '', salePriceUsd: '', conditionTag: 'FIRST' as ConditionTag,
  });
  // weight correction
  const [realWeight, setRealWeight] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [fieldErr, setFieldErr] = useState<{ weight?: string; reason?: string }>({});

  const { data: rows } = useLiveQuery(() => getProductsWithBatch(db), []);
  const { data: catalog = null } = useLiveQuery(() => getCatalog(db), []);
  const all = useMemo<Row[]>(() => rows ?? [], [rows]);

  const selected = all.find((r) => r.product._id === selectedId) ?? null;

  // Lot number first — it is the number printed on the bundle and the one the
  // operator has in hand. Everything else on the row is searchable too so the
  // same box works when they only remember the colour.
  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return [];
    return all
      .filter(({ batch, product }) =>
        [
          product.lotNumber ?? '',
          product.pieceId,
          batch.color,
          batch.colorCode ?? '',
          batch.nm,
          batch.fabricType,
          product.pantone ?? '',
          // «65» finds every 65/35 roll — the blends are standard, so the
          // polyester percentage is a real search key (client, 2026-08-15).
          product.fiberComposition ?? '',
        ].some((field) => fold(field).includes(q)),
      )
      .sort((a, b) => {
        // Exact lot matches first — that is what was typed.
        const aLot = fold(a.product.lotNumber ?? '') === q ? 0 : 1;
        const bLot = fold(b.product.lotNumber ?? '') === q ? 0 : 1;
        return aLot - bLot || a.batch.color.localeCompare(b.batch.color);
      })
      .slice(0, 60);
  }, [all, query]);

  // Seed the form from the roll the operator picked. Keyed on the id, not the
  // document: the live query refreshes on every DB change and re-seeding then
  // would overwrite what is being typed.
  useEffect(() => {
    const picked = all.find((r) => r.product._id === selectedId);
    if (!picked) return;
    const p = picked.product;
    setForm({
      lotNumber: p.lotNumber ?? '',
      pantone: p.pantone ?? '',
      fiberComposition: p.fiberComposition ?? '',
      purchaseValueUsd: String(p.purchaseValueUsd),
      salePriceUsd: String(p.salePriceUsd),
      conditionTag: p.conditionTag,
    });
    setRealWeight('');
    setAdjustReason('');
    setError('');
    setSuccess('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const isRoll = selected?.batch.productType === 'ROLL';

  async function handleSaveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      await updateRollDetails(db, {
        productId: selected.product._id,
        lotNumber: form.lotNumber,
        pantone: form.pantone,
        fiberComposition: form.fiberComposition,
        purchaseValueUsd: parseFloat(form.purchaseValueUsd),
        salePriceUsd: parseFloat(form.salePriceUsd),
        conditionTag: form.conditionTag,
      });
      setSuccess(`Datos actualizados — ${fmtPiece(selected.product.pieceId)} · ${fmtLot(form.lotNumber)}.`);
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAdjustWeight(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError('');
    setSuccess('');
    setFieldErr({});
    const measured = Number(realWeight.trim());
    if (!realWeight.trim() || !Number.isFinite(measured) || measured < 0) {
      setFieldErr({ weight: 'Indica el peso real medido.' });
      setError('Faltan datos — revisa los campos marcados en rojo.');
      return;
    }
    if (!adjustReason.trim()) {
      setFieldErr({ reason: 'Obligatorio — queda en el historial.' });
      setError('Faltan datos — revisa los campos marcados en rojo.');
      return;
    }
    const delta = Math.round((measured - selected.product.currentWeightKg) * 1000) / 1000;
    if (delta === 0) {
      setError('El peso indicado es el mismo que ya tiene el rollo.');
      return;
    }
    setSaving(true);
    try {
      await adjustStock(db, {
        batchId: selected.batch._id,
        productId: selected.product._id,
        quantityChanged: delta,
        operatorId: cachedUser()?.name ?? 'desconocido',
        reason: adjustReason.trim(),
      });
      setSuccess(
        `Peso ajustado — ${fmtKg(selected.product.currentWeightKg)} → ${fmtKg(measured)} (${delta > 0 ? '+' : ''}${delta} kg).`,
      );
      setRealWeight('');
      setAdjustReason('');
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="kbd-hints" style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-thread)', margin: '0 0 20px' }}>
        Presiona <Kbd>/</Kbd> para buscar · escribe el nº de lote impreso en el bulto
      </p>

      <section style={sectionStyle} className="card">
        <h2 style={sectionTitle}>Buscar rollo</h2>
        <Field label="Nº de lote, color, código, NM/Dtex, tela o composición">
          <Input
            data-hotkey-search=""
            type="search"
            value={query}
            placeholder="4471 · Azul rey · 405 · 65%…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>

        {query.trim() && (
          results.length === 0 ? (
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', marginTop: 12, marginBottom: 0 }}>
              Ningún rollo coincide con «{query.trim()}».
            </p>
          ) : (
            <div role="listbox" aria-label="Resultados" style={{ ...rollListBox, marginTop: 12 }}>
              {results.map(({ batch, product }) => {
                const active = product._id === selectedId;
                return (
                  <div
                    key={product._id}
                    role="option"
                    aria-selected={active}
                    data-result-row
                    onClick={() => setSelectedId(product._id)}
                    style={rollRowStyle(active)}
                  >
                    <SwatchChip color={batch.color} size="sm" />
                    {batch.colorCode && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-thread)' }}>
                        {batch.colorCode}
                      </span>
                    )}
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-ink)', minWidth: 150 }}>
                      {NM_LABEL} {batch.nm} · {batch.fabricType}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, minWidth: 90 }}>
                      {fmtPiece(product.pieceId)}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-thread)' }}>
                      {batch.productType === 'ROLL' ? fmtKg(product.currentWeightKg) : fmtUnits(batch.currentUnits)}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-dye)' }}>
                      {fmtLot(product.lotNumber)}
                    </span>
                    <Badge tone={CONDITION_TONE[product.conditionTag]}>{CONDITION_SHORT[product.conditionTag]}</Badge>
                    {batch.productType === 'ROLL' && !hasRollStock(product.currentWeightKg) && (
                      <Badge tone="neutral">VACÍO</Badge>
                    )}
                    <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {fmtUsd(product.salePriceUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
          )
        )}
        {!query.trim() && <EmptyState title="Escribe un nº de lote para empezar" />}
      </section>

      {selected && (
        <>
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>
              Corregir datos — {selected.batch.color}
              {selected.batch.colorCode ? ` (${selected.batch.colorCode})` : ''} · {NM_LABEL} {selected.batch.nm} ·{' '}
              {selected.batch.fabricType} · {fmtPiece(selected.product.pieceId)}
            </h2>
            <form onSubmit={handleSaveDetails} noValidate>
              <div className="form-grid-3 form-grid-compact">
                <Field label="Nº de lote" hint="Vacío = S/L">
                  <Input
                    data-edit-lot
                    value={form.lotNumber}
                    placeholder="Impreso en el bulto"
                    onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
                  />
                </Field>
                <Field label="Pantone">
                  <Input
                    value={form.pantone}
                    placeholder="19-4052 TCX"
                    onChange={(e) => setForm({ ...form, pantone: e.target.value })}
                  />
                </Field>
                <Field label="Composición">
                  {/* Same closed list as ingress; a stored legacy blend stays
                      selectable so the correction form never lies. */}
                  {catalog?.compositions?.length ? (
                    <Select
                      value={form.fiberComposition}
                      onChange={(e) => setForm({ ...form, fiberComposition: e.target.value })}
                    >
                      <option value="">—</option>
                      {catalog.compositions.map((blend) => (
                        <option key={blend} value={blend}>{blend}</option>
                      ))}
                      {form.fiberComposition && !catalog.compositions.includes(form.fiberComposition) && (
                        <option value={form.fiberComposition}>{form.fiberComposition} (legado)</option>
                      )}
                    </Select>
                  ) : (
                    <Input
                      value={form.fiberComposition}
                      placeholder="95% algodón / 5% elastano"
                      onChange={(e) => setForm({ ...form, fiberComposition: e.target.value })}
                    />
                  )}
                </Field>
                <Field label={isRoll ? 'Costo · $/kg' : 'Costo unitario $'}>
                  <NumberInput
                    value={form.purchaseValueUsd}
                    min="0"
                    step="0.01"
                    onChange={(e) => setForm({ ...form, purchaseValueUsd: e.target.value })}
                  />
                </Field>
                <Field label={isRoll ? 'Venta · $/kg' : 'Precio unitario $'}>
                  <NumberInput
                    data-edit-price
                    value={form.salePriceUsd}
                    min="0"
                    step="0.01"
                    onChange={(e) => setForm({ ...form, salePriceUsd: e.target.value })}
                  />
                </Field>
                <Field label="Condición">
                  <Select
                    value={form.conditionTag}
                    onChange={(e) => setForm({ ...form, conditionTag: e.target.value as ConditionTag })}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div style={{ marginTop: 16 }}>
                <Button type="submit" variant="primary" size="md" disabled={saving}>
                  {saving ? 'Guardando…' : 'Guardar datos'}
                </Button>
              </div>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', margin: '12px 0 0' }}>
                Los precios se aplican a ventas futuras. Las ventas ya registradas conservan
                el precio que tenían — son inmutables.
              </p>
            </form>
          </section>

          {isRoll && (
            <section style={sectionStyle} className="card">
              <h2 style={sectionTitle}>
                Ajustar peso — hoy tiene {fmtKg(selected.product.currentWeightKg)}
              </h2>
              <form onSubmit={handleAdjustWeight} noValidate>
                <div className="form-grid-2 form-grid-compact">
                  <Field label="Peso real medido (Kg)" error={fieldErr.weight}>
                    <NumberInput
                      data-adjust-weight
                      aria-invalid={Boolean(fieldErr.weight)}
                      value={realWeight}
                      placeholder="0.000"
                      min="0"
                      step="0.001"
                      onChange={(e) => { setFieldErr((p) => ({ ...p, weight: undefined })); setRealWeight(e.target.value); }}
                    />
                  </Field>
                  <Field label="Motivo" hint="Queda en el historial de movimientos" error={fieldErr.reason}>
                    <Input
                      data-adjust-reason
                      aria-invalid={Boolean(fieldErr.reason)}
                      value={adjustReason}
                      placeholder="Reconteo, merma, error de tipeo…"
                      onChange={(e) => { setFieldErr((p) => ({ ...p, reason: undefined })); setAdjustReason(e.target.value); }}
                    />
                  </Field>
                </div>
                <div style={{ marginTop: 16 }}>
                  <Button type="submit" variant="primary" size="md" disabled={saving}>
                    {saving ? 'Ajustando…' : 'Ajustar peso'}
                  </Button>
                </div>
                <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', margin: '12px 0 0' }}>
                  El peso nunca se sobrescribe: se registra un movimiento de ajuste con la
                  diferencia, y el historial sigue siendo la verdad.
                </p>
              </form>
            </section>
          )}
        </>
      )}

      {success && <div role="status" style={alertOk}>{success}</div>}
      {error && <div role="alert" style={alertErr}>{error}</div>}
    </div>
  );
}
