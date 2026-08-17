// Devoluciones pane — a client brings fabric back, optionally exchanging it for
// another roll ("cambio por garantía").
//
// Two rules that shape the whole screen:
//  · The roll is PICKED, never typed. Three plausible typings of "R1" normalize
//    to two different documents, and the wrong one is a silent stock error.
//  · Returned fabric defaults to Fallado. That WARNS — it never blocks the
//    resale (client decision, casilla 6), so there is no quarantine here.

import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { db } from '../../lib/db';
import { cachedUser } from '../../lib/auth';
import { getBatchProducts, getProductsWithBatch } from '../../lib/queries';
import { getColorChart } from '../../lib/catalog';
import { returnStock, returnPieceId } from '../../lib/inventory';
import { useLiveQuery } from '../../lib/hooks';
import {
  batchIdOf, hasRollStock, norm,
  type ConditionTag, type BatchDoc, type ProductDoc,
} from '../../lib/types';
import {
  fmtKg, fmtLot, fmtPiece, fmtUsd, CONDITION_LABEL, CONDITION_SHORT, CONDITION_TONE, NM_LABEL,
} from '../../lib/format';
import { Button, Input, NumberInput, Select, Field, Kbd, SwatchChip, Badge, Combobox } from '../ui';
import {
  sectionStyle, sectionTitle, alertOk, alertErr, bannerNew,
  rollListBox, rollRowStyle,
} from './styles';

const CONDITIONS = (Object.keys(CONDITION_LABEL) as ConditionTag[]).map((value) => ({
  value,
  label: CONDITION_LABEL[value],
}));

/** A stocked roll offered as a replacement, with the article it belongs to. */
interface Candidate {
  batch: BatchDoc;
  product: ProductDoc;
}

interface ReturnsPaneProps {
  /** Told after every successful return so the shell can refresh the ledger. */
  onDone?: () => void;
}

export default function ReturnsPane({ onDone }: ReturnsPaneProps) {
  // ─ article cascade ─
  const [color, setColor] = useState('');
  const [nm, setNm] = useState('');
  const [fabricType, setFabricType] = useState('');
  // Refines the roll list within the matched article — never a substitute for
  // color/NM/fabric, since the same supplier lot recurs across colors.
  const [lotFilter, setLotFilter] = useState('');

  // ─ selection ─
  const [selRoll, setSelRoll] = useState<ProductDoc | null>(null);
  const [rollActiveIdx, setRollActiveIdx] = useState(0);

  // ─ the return itself ─
  const [weightKg, setWeightKg] = useState('');
  const [conditionTag, setConditionTag] = useState<ConditionTag>('DEFECT');
  const [saleRef, setSaleRef] = useState('');

  // ─ exchange leg ─
  const [wantsExchange, setWantsExchange] = useState(false);
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const [replacementKg, setReplacementKg] = useState('');

  // ─ feedback ─
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  // Which specific field is wrong, so the message lands on it.
  const [fieldErr, setFieldErr] = useState<{ weight?: string; replacement?: string }>({});

  const colorRef = useRef<HTMLInputElement>(null);
  const nmRef = useRef<HTMLInputElement>(null);
  const fabricRef = useRef<HTMLInputElement>(null);
  const lotRef = useRef<HTMLInputElement>(null);
  const rollListRef = useRef<HTMLDivElement>(null);

  /**
   * The idempotency key, minted on the FIRST submit attempt and kept until that
   * submission succeeds. A retry after a failed/flaky write therefore rebuilds
   * the identical movement _id and returnStock returns the existing movement
   * instead of crediting the stock a second time — returns are exactly the flow
   * where an unsure operator taps twice.
   */
  const submissionRef = useRef<{ returnId: string; date: string } | null>(null);
  function submissionKey() {
    if (!submissionRef.current) {
      submissionRef.current = {
        returnId: crypto.randomUUID(),
        date: new Date().toISOString(),
      };
    }
    return submissionRef.current;
  }

  // ─── Data ────────────────────────────────────────────────────────────────────

  // ONE product+batch join covers both the article cascade and the same-lot
  // availability list below — was a separate getBatches + getStockedBatches
  // (3 prefix scans; now 2). ponytail caveat: getProductsWithBatch only sees
  // batches with at least one product doc, which is every batch in practice —
  // validateIngressForm requires a weight on at least one roll.
  const { data: productRows } = useLiveQuery(() => getProductsWithBatch(db), []);
  const rows = productRows ?? [];
  // Every ROLL article, including ones with nothing on the shelf: a roll sold to
  // zero is precisely the one most likely to come back.
  const rollBatches = [...new Map(
    rows.filter((r) => r.batch.productType === 'ROLL').map((r) => [r.batch._id, r.batch]),
  ).values()];
  // «405» finds «Azul rey» — same one-field name-or-code rule as Tela nueva.
  const { data: chart = null } = useLiveQuery(() => getColorChart(db), []);
  const codeByColorName = new Map((chart?.colors ?? []).map((c) => [norm(c.name), c.code]));

  const cascadeComplete = Boolean(color.trim() && nm.trim() && fabricType.trim());
  const matchedBatch: BatchDoc | null | undefined = cascadeComplete
    ? (rollBatches.find((b) => b._id === batchIdOf(color, nm, fabricType)) ?? null)
    : undefined;

  const { data: batchRolls } = useLiveQuery(
    () => (matchedBatch ? getBatchProducts(db, matchedBatch._id) : Promise.resolve([])),
    [matchedBatch?._id],
  );
  // Newest roll first — a return is usually of something recently shipped.
  const articleRolls = [...(batchRolls ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Lot options are scoped to the CURRENT article (color+NM+fabric already
  // picked) — the facet refines, it never substitutes.
  const lotOptions = [...new Set(
    articleRolls.map((r) => r.lotNumber?.trim()).filter((v): v is string => Boolean(v)),
  )].sort();
  const rolls = lotFilter.trim()
    ? articleRolls.filter((r) => (r.lotNumber ?? '').trim() === lotFilter.trim())
    : articleRolls;

  const colorOptions = [...new Set(rollBatches.map((b) => b.color))].sort();
  const nmOptions = color
    ? [...new Set(rollBatches.filter((b) => norm(b.color) === norm(color)).map((b) => b.nm))].sort()
    : [...new Set(rollBatches.map((b) => b.nm))].sort();
  const fabricOptions = color && nm
    ? [...new Set(rollBatches
        .filter((b) => norm(b.color) === norm(color) && norm(b.nm) === norm(nm))
        .map((b) => b.fabricType))].sort()
    : [...new Set(rollBatches.map((b) => b.fabricType))].sort();

  // ─── Same-lot availability ───────────────────────────────────────────────────

  const everyStockedRoll: Candidate[] = rows
    .filter((r) => r.batch.productType === 'ROLL' && r.batch.currentUnits > 0 && hasRollStock(r.product.currentWeightKg))
    .map((r) => ({ batch: r.batch, product: r.product }));

  const lot = selRoll?.lotNumber?.trim();
  const sameLot = lot ? everyStockedRoll.filter((c) => c.product.lotNumber?.trim() === lot) : [];
  // A roll with no lot recorded (S/L) has no lot to match, and a lot with
  // nothing left on the shelf has to fall back to something the seller can
  // actually hand over — the rest of the same article.
  const sameArticle = everyStockedRoll.filter((c) => c.batch._id === matchedBatch?._id);
  const usingSameLot = sameLot.length > 0;
  const candidates = usingSameLot ? sameLot : sameArticle;
  const replacement = candidates.find((c) => c.product._id === replacementId) ?? null;

  // Drop a replacement that is no longer offered (article changed, stock ran out).
  useEffect(() => {
    if (replacementId && !candidates.some((c) => c.product._id === replacementId)) {
      setReplacementId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.map((c) => c.product._id).join('|'), replacementId]);

  // Reset the roll pick whenever the article changes or the lot filter
  // narrows the list to something the current selection isn't in.
  useEffect(() => {
    setSelRoll(null);
    setRollActiveIdx(0);
  }, [matchedBatch?._id]);

  useEffect(() => {
    if (selRoll && !rolls.some((r) => r._id === selRoll._id)) {
      setSelRoll(null);
      setRollActiveIdx(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotFilter]);

  // Clear the lot filter when the article changes — a lot left over from the
  // previous article would silently narrow (or empty) the new one.
  useEffect(() => {
    setLotFilter('');
  }, [matchedBatch?._id]);

  useEffect(() => {
    const el = rollListRef.current?.querySelector(`[data-ridx="${rollActiveIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [rollActiveIdx]);

  // ─── Keyboard ────────────────────────────────────────────────────────────────

  function advanceCascade(e: KeyboardEvent<HTMLInputElement>, next: React.RefObject<HTMLInputElement | null>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      next.current?.focus();
    }
  }

  function handleRollKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(rolls.length - 1, Math.max(0, rollActiveIdx + dir));
      setRollActiveIdx(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rolls[rollActiveIdx];
      if (r) pickRoll(r);
    }
  }

  function pickRoll(roll: ProductDoc) {
    setSelRoll(roll);
    setError('');
    setTimeout(() => document.getElementById('devolucion-peso')?.focus(), 20);
  }

  // ─── Submit ──────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setFieldErr({});

    if (!cascadeComplete || !matchedBatch) {
      setError('Selecciona un artículo existente de rollos.');
      return;
    }
    if (!selRoll) {
      setError('Selecciona el rollo que se está devolviendo.');
      return;
    }
    // Number(), not parseFloat(): parseFloat reads "12abc" as 12 and "1e999"
    // as Infinity, and Infinity passes a bare > 0.
    const kg = Number(weightKg.trim());
    if (!weightKg.trim() || !Number.isFinite(kg) || kg <= 0) {
      setFieldErr({ weight: 'Indica un peso mayor que cero.' });
      setError('Faltan datos — revisa los campos marcados en rojo.');
      document.getElementById('devolucion-peso')?.focus();
      return;
    }
    let replacementLeg: { productId: string; weightKg: number } | undefined;
    if (wantsExchange) {
      if (!replacement) {
        setError('Selecciona el rollo de reposición.');
        return;
      }
      const outKg = Number(replacementKg.trim());
      if (!replacementKg.trim() || !Number.isFinite(outKg) || outKg <= 0) {
        setFieldErr({ replacement: 'Indica un peso mayor que cero.' });
        setError('Faltan datos — revisa los campos marcados en rojo.');
        return;
      }
      replacementLeg = { productId: replacement.product._id, weightKg: outKg };
    }

    setSubmitting(true);
    try {
      const key = submissionKey();
      await returnStock(db, {
        returnId: key.returnId,
        date: key.date,
        productId: selRoll._id,
        weightKg: kg,
        conditionTag,
        operatorId: cachedUser()?.name ?? 'desconocido',
        referenceId: saleRef.trim() || undefined,
        replacement: replacementLeg,
      });

      const newPiece = returnPieceId(selRoll.pieceId, key.returnId);
      setSuccess(
        replacementLeg
          ? `Cambio registrado — entra ${fmtKg(kg)} como ${fmtPiece(newPiece)}, sale ${fmtKg(replacementLeg.weightKg)} de ${replacement!.product.pieceId}.`
          : `Devolución registrada — ${fmtKg(kg)} como ${fmtPiece(newPiece)}.`,
      );
      submissionRef.current = null; // the next return is a different submission
      setSelRoll(null);
      setWeightKg('');
      setSaleRef('');
      setWantsExchange(false);
      setReplacementId(null);
      setReplacementKg('');
      onDone?.();
    } catch (err) {
      setError((err as Error).message ?? 'Error desconocido.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleFullReset() {
    setColor('');
    setNm('');
    setFabricType('');
    setLotFilter('');
    setSelRoll(null);
    setWeightKg('');
    setConditionTag('DEFECT');
    setSaleRef('');
    setWantsExchange(false);
    setReplacementId(null);
    setReplacementKg('');
    setSuccess('');
    setError('');
    submissionRef.current = null;
    colorRef.current?.focus();
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
        <p className="kbd-hints" style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-thread)', margin: 0 }}>
          Presiona <Kbd>/</Kbd> para enfocar Color · <Kbd>↑↓</Kbd> elige rollo · <Kbd>↵</Kbd> confirma
        </p>
        <Button variant="ghost" size="md" onClick={handleFullReset} type="button">
          Limpiar todo
        </Button>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ─── ARTICLE ─────────────────────────────────────────────────── */}
        <section style={sectionStyle} className="card">
          <h2 style={sectionTitle}>Artículo devuelto</h2>

          <div className="form-grid-3">
            <Field label="Color" hint={codeByColorName.get(norm(color)) ? `Código ${codeByColorName.get(norm(color))}` : undefined}>
              <Combobox
                ref={colorRef}
                data-hotkey-search=""
                value={color}
                placeholder="Azul rey · 405"
                options={colorOptions}
                searchText={(c) => codeByColorName.get(norm(c)) ?? ''}
                onChange={(v) => {
                  // Typed a bare chart code? Swap it for the colour it names —
                  // batchIdOf norm()s, so chart casing still matches the batch.
                  const byCode = chart?.colors.find((c) => c.code === v.trim());
                  setColor(byCode ? byCode.name : v);
                }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setColor(''); return; } advanceCascade(e, nmRef); }}
                renderOption={(c) => (
                  <>
                    <SwatchChip color={c} size="sm" />
                    {codeByColorName.get(norm(c)) && (
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--color-thread)' }}>
                        {codeByColorName.get(norm(c))}
                      </span>
                    )}
                  </>
                )}
              />
            </Field>
            <Field label={`${NM_LABEL} (métrica aguja)`}>
              <Combobox
                ref={nmRef}
                value={nm}
                placeholder="30"
                options={nmOptions}
                onChange={setNm}
                onKeyDown={(e) => { if (e.key === 'Escape') { setNm(''); return; } advanceCascade(e, fabricRef); }}
              />
            </Field>
            <Field label="Tipo de tela">
              <Combobox
                ref={fabricRef}
                value={fabricType}
                placeholder="Jersey"
                options={fabricOptions}
                onChange={setFabricType}
                onKeyDown={(e) => { if (e.key === 'Escape') { setFabricType(''); return; } advanceCascade(e, lotRef); }}
              />
            </Field>
            <Field label="Nº de lote" hint="Refina la lista de rollos — nunca sustituye color, NM o tela">
              <Combobox
                ref={lotRef}
                value={lotFilter}
                placeholder="4471"
                options={lotOptions}
                onChange={setLotFilter}
                onKeyDown={(e) => { if (e.key === 'Escape') setLotFilter(''); }}
              />
            </Field>
          </div>

          {cascadeComplete && matchedBatch === null && (
            <div style={bannerNew}>
              <strong>Ese artículo no existe</strong> — una devolución solo puede entrar contra un
              artículo de rollos ya registrado.
            </div>
          )}
        </section>

        {/* ─── ROLL PICKER ─────────────────────────────────────────────── */}
        {matchedBatch && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>Rollo que se devuelve</h2>

            {rolls.length === 0 ? (
              <p style={mutedText}>Este artículo todavía no tiene rollos registrados.</p>
            ) : (
              <>
                <div
                  ref={rollListRef}
                  tabIndex={0}
                  role="listbox"
                  aria-label="Rollos del artículo"
                  onKeyDown={handleRollKey}
                  style={rollListBox}
                >
                  {rolls.map((roll, i) => (
                    <div
                      key={roll._id}
                      data-ridx={i}
                      role="option"
                      aria-selected={selRoll?._id === roll._id}
                      onClick={() => { setRollActiveIdx(i); pickRoll(roll); }}
                      style={rollRowStyle(i === rollActiveIdx)}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-ink)', minWidth: 90 }}>
                        {fmtPiece(roll.pieceId)}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-thread)', minWidth: 74 }}>
                        {fmtKg(roll.currentWeightKg)}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-thread)' }}>
                        {fmtLot(roll.lotNumber)}
                      </span>
                      <Badge tone={CONDITION_TONE[roll.conditionTag]}>{CONDITION_SHORT[roll.conditionTag]}</Badge>
                      {!hasRollStock(roll.currentWeightKg) && <Badge tone="neutral">VENDIDO</Badge>}
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-ink)' }}>
                        {fmtUsd(roll.salePriceUsd)}/kg
                      </span>
                    </div>
                  ))}
                </div>
                <p className="kbd-hints" style={{ ...mutedText, marginTop: 8 }}>
                  El rollo se elige de la lista — nunca se escribe. La devolución entra como un
                  rollo aparte, con el lote y los precios del rollo del que salió.
                </p>
              </>
            )}
          </section>
        )}

        {/* ─── RETURN DETAIL ───────────────────────────────────────────── */}
        {selRoll && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>
              Datos de la devolución — {fmtPiece(selRoll.pieceId)} · {fmtLot(selRoll.lotNumber)}
            </h2>
            <div className="form-grid-3 form-grid-compact">
              <Field label="Peso devuelto (Kg)" error={fieldErr.weight}>
                <NumberInput
                  id="devolucion-peso"
                  aria-invalid={Boolean(fieldErr.weight)}
                  value={weightKg}
                  placeholder="0.000"
                  min="0.001"
                  step="0.001"
                  onChange={(e) => { setFieldErr((p) => ({ ...p, weight: undefined })); setWeightKg(e.target.value); }}
                  required
                />
              </Field>
              <Field label="Condición" hint="Fallado advierte; el rollo sigue siendo vendible">
                <Select
                  value={conditionTag}
                  onChange={(e) => setConditionTag(e.target.value as ConditionTag)}
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Referencia de venta" hint="Opcional — nº de la venta original">
                <Input
                  value={saleRef}
                  placeholder="Nº de venta"
                  onChange={(e) => setSaleRef(e.target.value)}
                />
              </Field>
            </div>

            <label style={checkboxRow}>
              <input
                type="checkbox"
                checked={wantsExchange}
                onChange={(e) => {
                  setWantsExchange(e.target.checked);
                  if (e.target.checked && !replacementKg) setReplacementKg(weightKg);
                }}
                style={{ width: 18, height: 18, accentColor: 'var(--color-dye)' }}
              />
              <span>Entregar tela de reposición (cambio por garantía)</span>
            </label>
          </section>
        )}

        {/* ─── EXCHANGE / SAME-LOT AVAILABILITY ────────────────────────── */}
        {selRoll && wantsExchange && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>
              {usingSameLot
                ? `Disponible del ${fmtLot(selRoll.lotNumber)}`
                : 'Disponible de este artículo'}
            </h2>

            {!usingSameLot && (
              <p style={{ ...mutedText, marginTop: 0, marginBottom: 12 }}>
                {lot
                  ? `No queda stock del ${fmtLot(selRoll.lotNumber)}. Estos son los demás rollos del artículo — el tono puede no coincidir.`
                  : 'Ese rollo no tiene lote registrado (S/L), así que no hay lote con el que emparejar. Estos son los rollos con stock del artículo.'}
              </p>
            )}

            {candidates.length === 0 ? (
              <p style={mutedText}>No hay rollos con stock para entregar en reposición.</p>
            ) : (
              <>
                <div role="listbox" aria-label="Rollos de reposición" style={rollListBox}>
                  {candidates.map((c) => {
                    const active = c.product._id === replacementId;
                    return (
                      <div
                        key={c.product._id}
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          setReplacementId(c.product._id);
                          if (!replacementKg) setReplacementKg(weightKg);
                        }}
                        style={rollRowStyle(active)}
                      >
                        <SwatchChip color={c.batch.color} size="sm" />
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-ink)', minWidth: 90 }}>
                          {fmtPiece(c.product.pieceId)}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-thread)' }}>
                          {fmtKg(c.product.currentWeightKg)}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-thread)' }}>
                          {fmtLot(c.product.lotNumber)}
                        </span>
                        {c.batch._id !== matchedBatch?._id && (
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--color-thread)' }}>
                            {NM_LABEL} {c.batch.nm} · {c.batch.fabricType}
                          </span>
                        )}
                        <Badge tone={CONDITION_TONE[c.product.conditionTag]}>
                          {CONDITION_SHORT[c.product.conditionTag]}
                        </Badge>
                      </div>
                    );
                  })}
                </div>

                {replacement && (
                  <div style={{ maxWidth: 220, marginTop: 16 }}>
                    <Field
                      label="Kg de reposición"
                      hint={`Quedan ${fmtKg(replacement.product.currentWeightKg)} en ${replacement.product.pieceId}`}
                      error={fieldErr.replacement}
                    >
                      <NumberInput
                        data-replacement-kg
                        aria-invalid={Boolean(fieldErr.replacement)}
                        value={replacementKg}
                        placeholder="0.000"
                        min="0.001"
                        step="0.001"
                        max={replacement.product.currentWeightKg}
                        onChange={(e) => { setFieldErr((p) => ({ ...p, replacement: undefined })); setReplacementKg(e.target.value); }}
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {success && <div role="status" style={alertOk}>{success}</div>}
        {error && <div role="alert" style={alertErr}>{error}</div>}

        {selRoll && (
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <Button type="submit" variant="primary" size="lg" disabled={submitting}>
              {submitting
                ? 'Registrando…'
                : wantsExchange ? 'Registrar cambio' : 'Registrar devolución'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}

const mutedText: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  color: 'var(--color-thread)',
  margin: 0,
};

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 18,
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--color-ink)',
  cursor: 'pointer',
};
