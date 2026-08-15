// Inventory ingress pane ("Tela nueva"), mounted by InventarioPage.
// UX: Color → NM → Tipo cascade (free entry), then ROLL/COMBO/PIECE form.
// Language: labels SPANISH, code ENGLISH.

import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { db } from '../../lib/db';
import { cachedUser } from '../../lib/auth';
import { getBatches, getBatchProducts, getClients, getSales, getFiscalConfig } from '../../lib/queries';
import {
  ingressStock, validateIngressForm, ingressFormIsValid, type IngressFormErrors,
} from '../../lib/inventory';
import { useLiveQuery } from '../../lib/hooks';
import { clientsWhoBought, waLink, buildArrivalText } from '../../lib/whatsapp';
import { batchIdOf, norm, type ProductType, type ConditionTag, type BatchDoc, type ClientDoc, type ProductDoc } from '../../lib/types';
import { fmtKg, fmtUnits, fmtLotsLabel, CONDITION_LABEL, NM_LABEL } from '../../lib/format';
import {
  Button, Input, NumberInput, Select, Field, Kbd, SwatchChip, Combobox,
} from '../ui';
import {
  sectionStyle, sectionTitle, colLabel, deemphasizedInput,
  bannerExisting, bannerNew, alertOk, alertErr,
} from './styles';

// ─── CONDITION OPTIONS ────────────────────────────────────────────────────────

// Derived from the shared label map so the Select and the /venta badges can
// never describe the same tag differently.
const CONDITIONS = (Object.keys(CONDITION_LABEL) as ConditionTag[]).map((value) => ({
  value,
  label: CONDITION_LABEL[value],
}));

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface RollRow {
  pieceId: string;
  weightKg: string;
  purchaseValueUsd: string;
  salePriceUsd: string;
  conditionTag: ConditionTag;
}

// Batch-level defaults for ROLL ingress. `touched.*` prevents prefill from
// clobbering values the user has intentionally typed.
interface BatchDefaults {
  purchaseValueUsd: string;
  salePriceUsd: string;
  conditionTag: ConditionTag;
  pantone: string;
  fiberComposition: string;
  touched: { cost: boolean; price: boolean; condition: boolean; pantone: boolean; composition: boolean };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function emptyRoll(pieceId: string, defaults: BatchDefaults): RollRow {
  return {
    pieceId,
    weightKg: '',
    purchaseValueUsd: defaults.purchaseValueUsd,
    salePriceUsd: defaults.salePriceUsd,
    conditionTag: defaults.conditionTag,
  };
}

function freshDefaults(): BatchDefaults {
  return {
    purchaseValueUsd: '',
    salePriceUsd: '',
    conditionTag: 'FIRST',
    pantone: '',
    fiberComposition: '',
    touched: { cost: false, price: false, condition: false, pantone: false, composition: false },
  };
}

// How far back to look for clients who buy this cloth. Six months of a fabric
// they never came back for is not a lead.
const ARRIVAL_WINDOW_DAYS = 182;

// Stable identity for "no batches yet" — the cascade effect keys on `batches`,
// and a fresh [] every render would re-run it every render.
const NO_BATCHES: BatchDoc[] = [];

function nextPieceLabel(existingCount: number, rowIndex: number): string {
  return `R${existingCount + rowIndex + 1}`;
}

// Highest R{n} across a batch's roll pieceIds (0 if none). Used so new rolls
// continue past every roll ever created, not just the non-empty ones.
function maxRollNumber(pieceIds: string[]): number {
  return pieceIds.reduce((max, id) => {
    const n = parseInt(id.replace(/^R/i, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

interface IngressFormProps {
  /** Told after every successful ingress so the shell can refresh the ledger. */
  onDone?: () => void;
}

export default function IngressForm({ onDone }: IngressFormProps) {
  // ─ cascade state ─
  const [color, setColor]           = useState('');
  const [nm, setNm]                 = useState('');
  const [fabricType, setFabricType] = useState('');

  // ─ batch data ─
  // Through useLiveQuery, which awaits dbReady: reading the batches directly on
  // mount races the first-load seed/sync, and losing that race makes an existing
  // article look new — the form then offers roll id R1, which already exists.
  const { data: loadedBatches } = useLiveQuery(() => getBatches(db), []);
  const batches = loadedBatches ?? NO_BATCHES;

  // The matched article's products, kept so the banner can name the lots it
  // already holds — the operator needs to know whether this arrival is the same
  // lot as what is on the shelf before they type the number.
  const [batchProducts, setBatchProducts] = useState<ProductDoc[]>([]);

  // ─ new-batch fields ─
  const [productType, setProductType] = useState<ProductType>('ROLL');
  const [location, setLocation]       = useState('');

  // ─ colour-chart code: batch-level, optional ─
  // Prefilled from the matched article behind a touched guard, exactly like the
  // price/pantone defaults: the prefill must never overwrite what was just typed.
  const [colorCode, setColorCode] = useState('');
  const colorCodeTouched = useRef(false);

  // ─ batch-level defaults for ROLL mode ─
  const [batchDefaults, setBatchDefaults] = useState<BatchDefaults>(freshDefaults);

  // ─ lot number: the supplier's printed number, one per submission ─
  // Never prefilled and cleared after every ingress — a lot number left over from
  // the previous arrival would silently stamp the wrong lot onto the next rolls.
  const [lotNumber, setLotNumber] = useState('');

  // ─ roll rows ─
  const [rolls, setRolls] = useState<RollRow[]>(() => [emptyRoll('R1', freshDefaults())]);
  // Highest existing roll number for the matched ROLL batch. Sequencing new
  // pieceIds off currentUnits reuses ids of sold-out rolls (they drop out of the
  // count), silently refilling their doc — so we track the real max R{n} instead.
  const [maxExistingRoll, setMaxExistingRoll] = useState(0);

  // ─ combo/piece fields ─
  const [units, setUnits]                         = useState('');
  const [unitPurchaseValueUsd, setUnitPurchaseValueUsd] = useState('');
  const [unitSalePriceUsd, setUnitSalePriceUsd]   = useState('');
  const [unitConditionTag, setUnitConditionTag]   = useState<ConditionTag>('FIRST');
  // Tracks whether user has touched the combo/piece price fields (blocks prefill)
  const unitTouched = useRef({ cost: false, price: false, condition: false });

  // ─ "acaba de llegar" — offered AFTER a successful ingress, never before ─
  // Detected from this ingress, not from the batch's createdAt: refilling an
  // existing article preserves the original date, so a batch never looks new
  // again and the notice would only ever fire for brand-new articles.
  const [arrivals, setArrivals] = useState<
    { what: string; targets: Array<{ client: ClientDoc; link: string }> } | null
  >(null);

  // ─ per-field errors ─ the message belongs next to the field that is wrong,
  //   not in a banner at the bottom the operator has to go hunting through.
  const [fieldErrors, setFieldErrors] = useState<IngressFormErrors>({});
  const clearFieldError = (key: keyof IngressFormErrors) =>
    setFieldErrors((prev) => (key in prev ? { ...prev, [key]: undefined } : prev));

  // ─ feedback ─
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess]       = useState('');
  const [error, setError]           = useState('');

  // ─ refs for keyboard nav ─
  const colorRef      = useRef<HTMLInputElement>(null);
  const nmRef         = useRef<HTMLInputElement>(null);
  const fabricRef     = useRef<HTMLInputElement>(null);
  // Container ref for roll rows, used to focus weight inputs by row index.
  const rollsContainerRef = useRef<HTMLDivElement>(null);

  // ─── Datalist options ────────────────────────────────────────────────────────

  const colorOptions = [...new Set(batches.map((b) => b.color))].sort();

  const nmOptions = color
    ? [...new Set(batches.filter((b) => norm(b.color) === norm(color)).map((b) => b.nm))].sort()
    : [...new Set(batches.map((b) => b.nm))].sort();

  const fabricOptions = color && nm
    ? [...new Set(batches.filter((b) => norm(b.color) === norm(color) && norm(b.nm) === norm(nm)).map((b) => b.fabricType))].sort()
    : [...new Set(batches.map((b) => b.fabricType))].sort();

  // ─── Which article the cascade points at ────────────────────────────────────
  //
  // Derived during render, not held in state: `batches` refreshes on every DB
  // change, and a state copy would lag a sync by one render.
  // undefined = cascade incomplete; null = new article; BatchDoc = existing.

  const cascadeComplete = Boolean(color.trim() && nm.trim() && fabricType.trim());
  const matchedBatch: BatchDoc | null | undefined = cascadeComplete
    ? (batches.find((b) => b._id === batchIdOf(color, nm, fabricType)) ?? null)
    : undefined;
  // The effect below rewrites the roll rows, so it must fire when the ARTICLE
  // changes and at no other time. Both "no article yet" and "a new article"
  // resolve to no id, so they get their own keys.
  const matchKey = cascadeComplete ? (matchedBatch?._id ?? 'new') : 'none';

  useEffect(() => {
    const found = matchedBatch ?? null;

    // Batch-level, so it prefills off the batch itself — not off a product, and
    // for every productType (the price prefills below are ROLL/COMBO-specific).
    if (!colorCodeTouched.current) setColorCode(found?.colorCode ?? '');

    // Pre-fill rolls with next pieceId continuing past every roll ever created
    // (including sold-out ones), read from the actual product docs — not
    // currentUnits, which only counts non-empty rolls.
    if (!found) setBatchProducts([]);

    if (found?.productType === 'ROLL') {
      getBatchProducts(db, found._id)
        .then((products) => {
          setBatchProducts(products);
          const max = maxRollNumber(products.map((p) => p.pieceId));
          setMaxExistingRoll(max);

          // Prefill batch defaults from the most recent product (highest createdAt).
          // Only update fields the user hasn't touched.
          if (products.length > 0) {
            const latest = products.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
            setBatchDefaults((prev) => ({
              purchaseValueUsd: prev.touched.cost   ? prev.purchaseValueUsd : String(latest.purchaseValueUsd),
              salePriceUsd:     prev.touched.price  ? prev.salePriceUsd     : String(latest.salePriceUsd),
              conditionTag:     prev.touched.condition ? prev.conditionTag  : latest.conditionTag,
              pantone:          prev.touched.pantone ? prev.pantone : (latest.pantone ?? ''),
              fiberComposition: prev.touched.composition ? prev.fiberComposition : (latest.fiberComposition ?? ''),
              touched: prev.touched,
            }));
          }

          setRolls((prev) => {
            // Keep any rows the user has already typed into (non-empty weight).
            const filled = prev.filter((r) => r.weightKg !== '');
            if (filled.length === prev.length && prev.length > 0) {
              // All rows have content — just re-sequence piece IDs.
              return filled.map((r, i) => ({ ...r, pieceId: nextPieceLabel(max, i) }));
            }
            // Replace with a single fresh row using current defaults.
            return [emptyRoll(nextPieceLabel(max, 0), batchDefaults)];
          });
        })
        .catch(console.error);
    } else {
      setMaxExistingRoll(0);
      if (!found && productType === 'ROLL') {
        setRolls([emptyRoll('R1', batchDefaults)]);
      }

      // Prefill COMBO/PIECE prices from existing batch product.
      if (found && (found.productType === 'COMBO' || found.productType === 'PIECE')) {
        getBatchProducts(db, found._id)
          .then((products) => {
            setBatchProducts(products);
            if (products.length === 0) return;
            const latest = products.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
            if (!unitTouched.current.cost)      setUnitPurchaseValueUsd(String(latest.purchaseValueUsd));
            if (!unitTouched.current.price)     setUnitSalePriceUsd(String(latest.salePriceUsd));
            if (!unitTouched.current.condition) setUnitConditionTag(latest.conditionTag);
          })
          .catch(console.error);
      }
    }
    // Keyed on WHICH article is resolved, never on the `batches` array identity.
    // useLiveQuery hands back a fresh array on every DB change — including one
    // arriving over sync from another device — and this effect calls setRolls,
    // so an array-identity dep wipes the weights the operator is typing every
    // time anyone, anywhere, writes a document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  // ─── "/" hotkey focuses color ────────────────────────────────────────────────

  // Layout.astro global hotkey already handles "/" → [data-hotkey-search].
  // We just tag the color input.

  // ─── Focus weight input at a given row index ──────────────────────────────

  function focusWeightAt(idx: number) {
    if (!rollsContainerRef.current) return;
    const rows = rollsContainerRef.current.querySelectorAll<HTMLElement>('[data-roll-row]');
    const target = rows[idx];
    if (!target) return;
    (target.querySelector<HTMLElement>('[data-weight-input]') as HTMLElement | null)?.focus();
  }

  // ─── Roll row helpers ─────────────────────────────────────────────────────────

  const effectiveProductType = matchedBatch ? matchedBatch.productType : productType;
  const existingRollCount = matchedBatch?.productType === 'ROLL' ? maxExistingRoll : 0;

  function addRollRow() {
    setRolls((prev) => [
      ...prev,
      emptyRoll(nextPieceLabel(existingRollCount, prev.length), batchDefaults),
    ]);
  }

  function updateRoll(idx: number, patch: Partial<RollRow>) {
    setRolls((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function removeRoll(idx: number) {
    setRolls((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      // Recompute pieceIds after removal so they stay sequential.
      return next.map((r, i) => ({ ...r, pieceId: nextPieceLabel(existingRollCount, i) }));
    });
  }

  // Enter/Tab in a weight field hop weight-to-weight (the other cells are
  // mouse-only). Last row: append a new row — except Tab on an EMPTY last
  // weight, which falls through natively so the keyboard can leave the grid
  // (→ Registrar). Shift+Tab walks back up the weights.
  function onWeightKeyDown(e: KeyboardEvent<HTMLInputElement>, rowIdx: number) {
    if (e.key === 'Tab' && e.shiftKey) {
      if (rowIdx > 0) {
        e.preventDefault();
        focusWeightAt(rowIdx - 1);
      }
      return;
    }
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    const isLastRow = rowIdx === rolls.length - 1;
    if (isLastRow && e.key === 'Tab' && e.currentTarget.value.trim() === '') return;
    e.preventDefault();
    if (isLastRow) {
      setRolls((prev) => {
        const next = [
          ...prev,
          emptyRoll(nextPieceLabel(existingRollCount, prev.length), batchDefaults),
        ];
        // Focus after React re-renders — defer one tick.
        setTimeout(() => focusWeightAt(next.length - 1), 0);
        return next;
      });
    } else {
      focusWeightAt(rowIdx + 1);
    }
  }

  // Advance to next focusable input in the same roll row (cost → price → condition).
  function advanceInRow(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const row = (e.currentTarget as HTMLElement).closest('[data-roll-row]');
    if (!row) return;
    const inputs = Array.from(row.querySelectorAll<HTMLElement>('input, select'));
    const curIdx = inputs.indexOf(e.currentTarget as HTMLElement);
    (inputs[curIdx + 1] as HTMLElement | undefined)?.focus();
  }

  // ─── Running totals ──────────────────────────────────────────────────────────

  const totalKg = rolls.reduce((s, r) => s + (parseFloat(r.weightKg) || 0), 0);

  // ─── Cascade keyboard: Enter advances to next field ──────────────────────────

  function advanceCascade(e: KeyboardEvent<HTMLInputElement>, next: React.RefObject<HTMLInputElement | null>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      next.current?.focus();
    }
  }

  // ─── Submit ──────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    const resolvedTypeForCheck = matchedBatch ? matchedBatch.productType : productType;
    const problems = validateIngressForm({
      color, nm, fabricType,
      productType: resolvedTypeForCheck,
      colorCode,
      lotNumber,
      purchaseValueUsd: batchDefaults.purchaseValueUsd,
      salePriceUsd: batchDefaults.salePriceUsd,
      rolls,
      units,
      unitPurchaseValueUsd,
      unitSalePriceUsd,
    });
    setFieldErrors(problems);
    if (!ingressFormIsValid(problems)) {
      setError('Faltan datos — revisa los campos marcados en rojo.');
      // Put the cursor on the first thing that is wrong rather than making the
      // operator scan the form for it.
      setTimeout(() => {
        const first = document.querySelector<HTMLElement>('form [aria-invalid="true"]');
        first?.focus();
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 0);
      return;
    }

    setSubmitting(true);
    try {
      const operatorId = cachedUser()?.name ?? 'desconocido';
      const resolvedType = matchedBatch ? matchedBatch.productType : productType;

      if (resolvedType === 'ROLL') {
        // Drop trailing row with empty weight (the phantom row created by the last ⏎).
        const activeRolls = rolls.filter((r, i) => r.weightKg !== '' || i < rolls.length - 1);
        const submittedRolls = activeRolls.filter((r) => r.weightKg !== '');

        if (submittedRolls.length === 0) {
          setError('Agrega al menos un rollo con peso antes de registrar.');
          setSubmitting(false);
          return;
        }

        const parsedRolls = submittedRolls.map((r) => {
          // Per-row cost/price fall back to defaults if blank.
          // Both the row value and the fallback were checked by
          // validateIngressForm above, so these parses cannot be NaN here.
          const pv = Number(r.purchaseValueUsd !== '' ? r.purchaseValueUsd : batchDefaults.purchaseValueUsd);
          const sp = Number(r.salePriceUsd !== '' ? r.salePriceUsd : batchDefaults.salePriceUsd);
          return {
            pieceId: r.pieceId,
            weightKg: Number(r.weightKg),
            purchaseValueUsd: pv,
            salePriceUsd: sp,
            conditionTag: r.conditionTag,
          };
        });
        await ingressStock(db, {
          color: color.trim(),
          nm: nm.trim(),
          fabricType: fabricType.trim(),
          productType: resolvedType,
          location: location.trim() || matchedBatch?.location,
          // Only when the operator touched the field this submission: absent
          // carries the stored code, an explicit '' clears it (see buildBatch).
          colorCode: colorCodeTouched.current ? colorCode.trim() : undefined,
          operatorId,
          reason: 'Ingreso de inventario',
          lotNumber: lotNumber.trim() || undefined,
          pantone: batchDefaults.pantone.trim() || undefined,
          fiberComposition: batchDefaults.fiberComposition.trim() || undefined,
          rolls: parsedRolls,
        });
        const rollWord = parsedRolls.length === 1 ? 'rollo' : 'rollos';
        setSuccess(`Ingreso registrado — ${parsedRolls.length} ${rollWord} (${fmtKg(totalKg)}).`);
      } else {
        await ingressStock(db, {
          color: color.trim(),
          nm: nm.trim(),
          fabricType: fabricType.trim(),
          productType: resolvedType,
          location: location.trim() || matchedBatch?.location,
          colorCode: colorCodeTouched.current ? colorCode.trim() : undefined,
          operatorId,
          reason: 'Ingreso de inventario',
          units: Number(units),
          unitPurchaseValueUsd: Number(unitPurchaseValueUsd),
          unitSalePriceUsd: Number(unitSalePriceUsd),
          unitConditionTag,
        });
        setSuccess(`Ingreso registrado — ${fmtUnits(Number(units))}.`);
      }

      // Reset row state but keep cascade + batch defaults for rapid multi-batch entry.
      const nextMax = existingRollCount + rolls.filter((r) => r.weightKg !== '').length;
      setRolls([emptyRoll(nextPieceLabel(nextMax, 0), batchDefaults)]);
      setLotNumber(''); // the next arrival is a different lot — never carry it over
      // Un-stick the code's touched guard: what was just typed is now the
      // STORED code, so from here on the prefill owns the field again — a code
      // left "touched" would stamp this article's code onto the next article
      // the operator switches to (the lot-number hazard, batch-level).
      colorCodeTouched.current = false;
      setUnits('');
      // Keep unit price/condition for COMBO/PIECE rapid re-entry too (same as ROLL).
      setFieldErrors({});
      onDone?.(); // batches refresh themselves — useLiveQuery watches the DB
      void offerArrivalNotices(color.trim(), fabricType.trim());
    } catch (err) {
      setError((err as Error).message ?? 'Error desconocido.');
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Who bought this cloth recently, and can be told it just arrived. Loaded
   * lazily on success rather than on mount: the ledger scan is only worth doing
   * once there is something to announce.
   */
  async function offerArrivalNotices(color: string, fabric: string) {
    setArrivals(null);
    try {
      const since = new Date(Date.now() - ARRIVAL_WINDOW_DAYS * 86_400_000).toISOString();
      const [sales, clients, fiscal] = await Promise.all([
        getSales(db, { startDate: since }),
        getClients(db),
        getFiscalConfig(db),
      ]);
      const byId = new Map(clients.map((c) => [c._id, c]));
      const targets = clientsWhoBought(sales, fabric, since)
        .map((id) => byId.get(id))
        .filter((c): c is ClientDoc => Boolean(c))
        .map((client) => ({
          client,
          link: waLink(client.phoneNumber, buildArrivalText({
            clientName: client.name, fabricType: fabric, color,
            businessName: fiscal?.businessName,
          })),
        }))
        // No usable number means no button — never a link to nobody.
        .filter((t): t is { client: ClientDoc; link: string } => Boolean(t.link));
      if (targets.length) setArrivals({ what: `${fabric} ${color}`.trim(), targets });
    } catch (err) {
      console.error(err); // a failed suggestion must never break the ingress
    }
  }

  function handleFullReset() {
    setColor('');
    setNm('');
    setFabricType('');
    setProductType('ROLL');
    setLocation('');
    setColorCode('');
    colorCodeTouched.current = false;
    setBatchDefaults(freshDefaults());
    setRolls([emptyRoll('R1', freshDefaults())]);
    setLotNumber('');
    setUnits('');
    setUnitPurchaseValueUsd('');
    setUnitSalePriceUsd('');
    setUnitConditionTag('FIRST');
    unitTouched.current = { cost: false, price: false, condition: false };
    setSuccess('');
    setError('');
    setFieldErrors({});
    colorRef.current?.focus();
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  return (
    <div>

      {/* Pane header — the page title and the tabs live in InventarioPage. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
        <p className="kbd-hints" style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-thread)', margin: 0 }}>
          Presiona <Kbd>/</Kbd> para enfocar Color · <Kbd>Enter</Kbd> avanza al siguiente campo
        </p>
        <Button variant="ghost" size="md" onClick={handleFullReset} type="button">
          Limpiar todo
        </Button>
      </div>

      <form onSubmit={handleSubmit} noValidate>

        {/* ─── CASCADE ──────────────────────────────────────────────────── */}
        <section style={sectionStyle} className="card">
          <h2 style={sectionTitle}>Identificación del artículo</h2>

          <div className="form-grid-3">
            {/* COLOR */}
            <Field label="Color" error={fieldErrors.color}>
              <Combobox
                ref={colorRef}
                data-hotkey-search=""
                aria-invalid={Boolean(fieldErrors.color)}
                value={color}
                placeholder="Azul rey"
                options={colorOptions}
                onChange={(v) => { clearFieldError('color'); setColor(v); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setColor(''); return; } advanceCascade(e, nmRef); }}
                renderOption={(c) => <SwatchChip color={c} size="sm" />}
              />
            </Field>

            {/* COLOUR CODE — optional, batch-level. Bands per the REAL chart
                (carta de colores, 2026-08-15): 100 blanco, 200s pasteles,
                300s medios, 400s oscuros — the client's earlier note was off
                by a hundred. */}
            <Field label="Código de color" hint="Opcional · 100 blanco · 200s pastel · 300s medio · 400s oscuro" error={fieldErrors.colorCode}>
              <Input
                data-color-code
                aria-invalid={Boolean(fieldErrors.colorCode)}
                value={colorCode}
                placeholder="215"
                maxLength={12}
                onChange={(e) => {
                  clearFieldError('colorCode');
                  colorCodeTouched.current = true;
                  setColorCode(e.target.value);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); nmRef.current?.focus(); } }}
              />
            </Field>

            {/* NM */}
            <Field label={`${NM_LABEL} (métrica aguja)`} error={fieldErrors.nm}>
              <Combobox
                ref={nmRef}
                aria-invalid={Boolean(fieldErrors.nm)}
                value={nm}
                placeholder="30"
                options={nmOptions}
                onChange={(v) => { clearFieldError('nm'); setNm(v); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setNm(''); return; } advanceCascade(e, fabricRef); }}
              />
            </Field>

            {/* FABRIC TYPE */}
            <Field label="Tipo de tela" error={fieldErrors.fabricType}>
              <Combobox
                ref={fabricRef}
                aria-invalid={Boolean(fieldErrors.fabricType)}
                value={fabricType}
                placeholder="Jersey"
                options={fabricOptions}
                onChange={(v) => { clearFieldError('fabricType'); setFabricType(v); }}
                onKeyDown={(e) => { if (e.key === 'Escape') setFabricType(''); }}
              />
            </Field>
          </div>

          {/* Batch status banner */}
          {cascadeComplete && matchedBatch !== undefined && (
            <div style={matchedBatch ? bannerExisting : bannerNew}>
              {matchedBatch ? (
                <span>
                  <SwatchChip color={matchedBatch.color} size="sm" />
                  {' '}
                  <strong>Artículo existente</strong> — se sumará stock ·{' '}
                  Stock actual:{' '}
                  <strong>
                    {matchedBatch.productType === 'ROLL'
                      ? `${matchedBatch.currentUnits} rollos`
                      : fmtUnits(matchedBatch.currentUnits)}
                  </strong>
                  {' · '}
                  <strong>{fmtLotsLabel(matchedBatch.productType, batchProducts)}</strong>
                </span>
              ) : (
                <span><strong>Artículo nuevo</strong> — se creará al registrar</span>
              )}
            </div>
          )}
        </section>

        {/* ─── PRODUCT TYPE + LOCATION (new batch only) ──────────────── */}
        {cascadeComplete && matchedBatch === null && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>Tipo de producto (artículo nuevo)</h2>
            <div className="form-grid-2">
              <Field label="Tipo">
                <Select value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
                  <option value="ROLL">Rollo (Kg)</option>
                  <option value="COMBO">Combo (Unidades)</option>
                  <option value="PIECE">Pieza (Unidades)</option>
                </Select>
              </Field>
              <Field label="Ubicación en almacén">
                <Input
                  value={location}
                  placeholder="Estante A-3"
                  onChange={(e) => setLocation(e.target.value)}
                />
              </Field>
            </div>
          </section>
        )}

        {/* ─── BATCH DEFAULTS (ROLL mode only) ──────────────────────── */}
        {cascadeComplete && effectiveProductType === 'ROLL' && matchedBatch !== undefined && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>Precios y condición</h2>
            <div className="form-grid-3 form-grid-compact">
              <Field label="Costo · $/kg" error={fieldErrors.purchaseValueUsd}>
                <NumberInput
                  aria-invalid={Boolean(fieldErrors.purchaseValueUsd)}
                  value={batchDefaults.purchaseValueUsd}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  onChange={(e) => setBatchDefaults((prev) => ({
                    ...prev,
                    purchaseValueUsd: (clearFieldError('purchaseValueUsd'), e.target.value),
                    touched: { ...prev.touched, cost: true },
                  }))}
                />
              </Field>
              <Field label="Venta · $/kg" error={fieldErrors.salePriceUsd}>
                <NumberInput
                  aria-invalid={Boolean(fieldErrors.salePriceUsd)}
                  value={batchDefaults.salePriceUsd}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  onChange={(e) => setBatchDefaults((prev) => ({
                    ...prev,
                    salePriceUsd: (clearFieldError('salePriceUsd'), e.target.value),
                    touched: { ...prev.touched, price: true },
                  }))}
                />
              </Field>
              <Field label="Condición">
                <Select
                  value={batchDefaults.conditionTag}
                  onChange={(e) => setBatchDefaults((prev) => ({
                    ...prev,
                    conditionTag: e.target.value as ConditionTag,
                    touched: { ...prev.touched, condition: true },
                  }))}
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Pantone">
                <Input
                  value={batchDefaults.pantone}
                  placeholder="19-4052 TCX"
                  onChange={(e) => setBatchDefaults((prev) => ({
                    ...prev,
                    pantone: e.target.value,
                    touched: { ...prev.touched, pantone: true },
                  }))}
                />
              </Field>
              <Field label="Composición">
                <Input
                  value={batchDefaults.fiberComposition}
                  placeholder="95% algodón / 5% elastano"
                  onChange={(e) => setBatchDefaults((prev) => ({
                    ...prev,
                    fiberComposition: e.target.value,
                    touched: { ...prev.touched, composition: true },
                  }))}
                />
              </Field>
            </div>
          </section>
        )}

        {/* ─── ROLL ROWS ────────────────────────────────────────────── */}
        {cascadeComplete && effectiveProductType === 'ROLL' && matchedBatch !== undefined && (
          <section style={sectionStyle} className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ ...sectionTitle, marginBottom: 0 }}>
                Rollos — {rolls.length} rollo{rolls.length !== 1 ? 's' : ''} · {fmtKg(totalKg)} total
              </h2>
              <Button variant="ghost" size="md" type="button" onClick={addRollRow}>+ Rollo</Button>
            </div>

            {/* Lot number — the supplier's printed number, one per arrival. Applies
                to every row below; re-typing an existing number adds to that lot. */}
            <div style={{ maxWidth: 240, marginBottom: 16 }}>
              <Field
                label="Nº de lote *"
                hint="Obligatorio · se aplica a todos los rollos de este ingreso"
                error={fieldErrors.lotNumber}
              >
                <Input
                  data-lot-input
                  aria-invalid={Boolean(fieldErrors.lotNumber)}
                  value={lotNumber}
                  placeholder="Impreso en el bulto"
                  onChange={(e) => { clearFieldError('lotNumber'); setLotNumber(e.target.value); }}
                />
              </Field>
            </div>

            {/* Column headers (hidden on phones — rows reflow to two lines) */}
            <div className="roll-head">
              <span style={colLabel}>Pieza</span>
              <span style={colLabel}>Peso (Kg)</span>
              <span style={{ ...colLabel, color: 'var(--color-thread)', opacity: 0.7 }}>Costo $</span>
              <span style={{ ...colLabel, color: 'var(--color-thread)', opacity: 0.7 }}>Precio $</span>
              <span style={{ ...colLabel, color: 'var(--color-thread)', opacity: 0.7 }}>Condición</span>
              <span />
            </div>

            {fieldErrors.rolls && (
              <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-danger)', marginBottom: 8 }}>
                {fieldErrors.rolls}
              </div>
            )}

            <div ref={rollsContainerRef}>
              {rolls.map((roll, idx) => (
                <div key={idx} data-roll-row className="roll-row">
                  {/* Piece ID — display only, auto-assigned */}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-thread)', padding: '0 4px', alignSelf: 'center' }}>
                    {roll.pieceId}
                  </span>

                  {/* Weight — primary input, full-width feel */}
                  <NumberInput
                    data-weight-input
                    aria-invalid={Boolean(fieldErrors.rollWeights?.[idx])}
                    title={fieldErrors.rollWeights?.[idx]}
                    value={roll.weightKg}
                    placeholder="0.000"
                    min="0.001"
                    step="0.001"
                    onChange={(e) => {
                      setFieldErrors((prev) => {
                        if (!prev.rollWeights?.[idx] && !prev.rolls) return prev;
                        const next = { ...prev, rolls: undefined };
                        if (next.rollWeights) {
                          const { [idx]: _dropped, ...rest } = next.rollWeights;
                          next.rollWeights = rest;
                        }
                        return next;
                      });
                      updateRoll(idx, { weightKg: e.target.value });
                    }}
                    onKeyDown={(e) => onWeightKeyDown(e, idx)}
                    required
                  />

                  {/* Cost override — mouse-only (out of tab order), de-emphasized */}
                  <NumberInput
                    value={roll.purchaseValueUsd}
                    placeholder={batchDefaults.purchaseValueUsd || '0.00'}
                    min="0"
                    step="0.01"
                    tabIndex={-1}
                    onChange={(e) => updateRoll(idx, { purchaseValueUsd: e.target.value })}
                    onKeyDown={advanceInRow}
                    style={deemphasizedInput}
                  />

                  {/* Price override — mouse-only, de-emphasized */}
                  <NumberInput
                    value={roll.salePriceUsd}
                    placeholder={batchDefaults.salePriceUsd || '0.00'}
                    min="0"
                    step="0.01"
                    tabIndex={-1}
                    onChange={(e) => updateRoll(idx, { salePriceUsd: e.target.value })}
                    onKeyDown={advanceInRow}
                    style={deemphasizedInput}
                  />

                  {/* Condition override — mouse-only, de-emphasized */}
                  <Select
                    value={roll.conditionTag}
                    tabIndex={-1}
                    onChange={(e) => updateRoll(idx, { conditionTag: e.target.value as ConditionTag })}
                    style={{ ...deemphasizedInput, minHeight: 40 }}
                  >
                    {CONDITIONS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </Select>

                  <Button
                    variant="danger"
                    size="md"
                    type="button"
                    tabIndex={-1}
                    disabled={rolls.length === 1}
                    onClick={() => removeRoll(idx)}
                    style={{ minHeight: 40, padding: '0 10px' }}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>

            <p className="kbd-hints" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', margin: '8px 0 0' }}>
              <Kbd>↹</Kbd> / <Kbd>↵</Kbd> siguiente rollo · costo/precio/condición se heredan de arriba y se ajustan con el ratón
            </p>
          </section>
        )}

        {/* ─── COMBO / PIECE FORM ───────────────────────────────────── */}
        {cascadeComplete && (effectiveProductType === 'COMBO' || effectiveProductType === 'PIECE') && matchedBatch !== undefined && (
          <section style={sectionStyle} className="card">
            <h2 style={sectionTitle}>Unidades</h2>
            <div className="form-grid-3 form-grid-compact">
              <Field label="Cantidad" error={fieldErrors.units}>
                <NumberInput
                  aria-invalid={Boolean(fieldErrors.units)}
                  value={units}
                  placeholder="0"
                  min="1"
                  step="1"
                  onChange={(e) => { clearFieldError('units'); setUnits(e.target.value); }}
                  required
                />
              </Field>
              <Field label="Costo unitario USD" error={fieldErrors.unitPurchaseValueUsd}>
                <NumberInput
                  aria-invalid={Boolean(fieldErrors.unitPurchaseValueUsd)}
                  value={unitPurchaseValueUsd}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  onChange={(e) => { clearFieldError('unitPurchaseValueUsd'); unitTouched.current.cost = true; setUnitPurchaseValueUsd(e.target.value); }}
                  required
                />
              </Field>
              <Field label="Precio venta USD" error={fieldErrors.unitSalePriceUsd}>
                <NumberInput
                  aria-invalid={Boolean(fieldErrors.unitSalePriceUsd)}
                  value={unitSalePriceUsd}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  onChange={(e) => { clearFieldError('unitSalePriceUsd'); unitTouched.current.price = true; setUnitSalePriceUsd(e.target.value); }}
                  required
                />
              </Field>
            </div>
            <div style={{ marginTop: 16, maxWidth: 200 }}>
              <Field label="Condición">
                <Select
                  value={unitConditionTag}
                  onChange={(e) => { unitTouched.current.condition = true; setUnitConditionTag(e.target.value as ConditionTag); }}
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </section>
        )}

        {/* ─── FEEDBACK ─────────────────────────────────────────────── */}
        {success && (
          <div role="status" style={alertOk}>{success}</div>
        )}
        {error && (
          <div role="alert" style={alertErr}>{error}</div>
        )}

        {/* ─── ACABA DE LLEGAR ─── who buys this cloth, one press each ─── */}
        {arrivals && (
          <section data-arrivals style={{ ...sectionStyle, borderColor: 'var(--color-ok)' }} className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <h2 style={{ ...sectionTitle, marginBottom: 0, color: 'var(--color-ok)' }}>
                Avisar que llegó {arrivals.what}
              </h2>
              <Button variant="ghost" size="md" type="button" onClick={() => setArrivals(null)}>
                Descartar
              </Button>
            </div>
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', margin: '0 0 12px' }}>
              {arrivals.targets.length === 1
                ? 'Un cliente compró esta tela en los últimos 6 meses.'
                : `${arrivals.targets.length} clientes compraron esta tela en los últimos 6 meses.`}
              {' '}Cada mensaje se envía a mano, uno por uno.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {arrivals.targets.map(({ client, link }) => (
                <a
                  key={client._id}
                  data-arrival-link
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 14px',
                    borderRadius: 6, border: '1.5px solid var(--color-ok)', color: 'var(--color-ok)',
                    fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, textDecoration: 'none',
                  }}
                >
                  {client.name}
                </a>
              ))}
            </div>
          </section>
        )}

        {/* ─── SUBMIT ────────────────────────────────────────────────── */}
        {cascadeComplete && matchedBatch !== undefined && (
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={submitting}
            >
              {submitting ? 'Registrando…' : 'Registrar ingreso'}
            </Button>
          </div>
        )}

      </form>
    </div>
  );
}
