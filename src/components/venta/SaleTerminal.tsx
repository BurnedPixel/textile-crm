// Sale terminal island — keyboard left zone + mouse cart right zone.
// client:only="react" — PouchDB requires the browser.
// Language: UI=Spanish, code=English. CLAUDE.md domain rules are NON-NEGOTIABLE.

import {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  type KeyboardEvent as RKE,
  type ReactNode,
  type CSSProperties,
  type Ref,
} from 'react';
import { db, cartDb, dbReady } from '../../lib/db';
import { cachedUser } from '../../lib/auth';
import { getStockedBatches, getClients, getConfig, computePaymentStatus } from '../../lib/queries';
import {
  getCart,
  addLine,
  updateLine,
  removeLine,
  setClient,
  setOnTheBooks,
  clearCart,
} from '../../lib/cart';
import { checkout } from '../../lib/checkout';
import { saveClient } from '../../lib/queries';
import { useLiveQuery } from '../../lib/hooks';
import { round2, fmtKg, fmtUnits, fmtUsd, fmtBs } from '../../lib/format';
import { UNIT_FOR, clientIdOf, type BatchDoc, type ProductDoc, type CartLineItem, type ClientDoc, type CartDoc, type PaymentStatus } from '../../lib/types';
import {
  Button,
  Input,
  NumberInput,
  Field,
  Kbd,
  SwatchChip,
  Badge,
  Money,
  EmptyState,
} from '../ui';

// ── helpers ─────────────────────────────────────────────────────────────────

type StockedEntry = { batch: BatchDoc; products: ProductDoc[] };

function paymentTone(s: PaymentStatus): 'ok' | 'warn' | 'danger' {
  if (s === 'PAID') return 'ok';
  if (s === 'PARTIAL') return 'warn';
  return 'danger';
}

function paymentLabel(s: PaymentStatus): string {
  if (s === 'PAID') return 'Pagado';
  if (s === 'PARTIAL') return 'Pago parcial';
  return 'Pendiente';
}

function conditionLabel(tag: string): string {
  if (tag === 'FIRST') return '1ª';
  if (tag === 'SECONDS') return '2da';
  return 'Def.';
}

function conditionTone(tag: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (tag === 'FIRST') return 'ok';
  if (tag === 'SECONDS') return 'warn';
  return 'danger';
}

// ── Listbox (keyboard-driven facet, independent selection) ───────────────────
// Options are always fully visible. `isAvailable(opt)` decides whether an option
// can be picked given the OTHER facets' selections; unavailable options stay
// visible but grayed, and arrow/typeahead navigation skips them (no-op on
// click/Enter). This keeps the three facets mutually consistent in any order.

interface ListboxHandle {
  focus: () => void;
}

interface ListboxProps {
  id: string;
  label: string;
  options: string[];
  value: string | null;
  isAvailable: (opt: string) => boolean;
  /** Toggle select: pick if unselected, clear if the same value is re-picked. */
  onSelect: (v: string) => void;
  /** Clear this facet's selection (Escape). No-op if nothing selected. */
  onClear: () => void;
  /** Enter after selecting: hand focus to the next unselected facet. */
  onAdvance?: () => void;
  handleRef?: Ref<ListboxHandle>;
  renderOption?: (v: string) => ReactNode;
  'data-hotkey-search'?: string;
}

function Listbox({
  id,
  label,
  options,
  value,
  isAvailable,
  onSelect,
  onClear,
  onAdvance,
  handleRef,
  renderOption,
  ...rest
}: ListboxProps) {
  const [typeahead, setTypeahead] = useState('');
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const taTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(handleRef, () => ({ focus: () => containerRef.current?.focus() }), []);

  // Park the cursor on the selected option (or first available) when it changes.
  useEffect(() => {
    const target = value ? options.indexOf(value) : options.findIndex(isAvailable);
    setActiveIdx(target >= 0 ? target : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Keep activeIdx in bounds when options change.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(options.length - 1, 0)));
  }, [options]);

  // Auto-scroll active option into view.
  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-opt="${activeIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // Move the cursor to the next available option in `dir`, skipping unavailable.
  function step(from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      if (isAvailable(options[i])) return i;
    }
    return from;
  }

  function handleKey(e: RKE<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => step(i, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => step(i, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt !== undefined && isAvailable(opt)) {
        onSelect(opt);
        onAdvance?.();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClear();
    } else if (e.key.length === 1) {
      // Type-ahead jumps among AVAILABLE options only.
      const next = typeahead + e.key.toLowerCase();
      setTypeahead(next);
      if (taTimer.current) clearTimeout(taTimer.current);
      taTimer.current = setTimeout(() => setTypeahead(''), 800);
      const idx = options.findIndex((o) => isAvailable(o) && o.toLowerCase().startsWith(next));
      if (idx >= 0) setActiveIdx(idx);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
        <span style={stepLabelStyle}>{label}</span>
        {value && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 700, color: 'var(--color-dye)' }}>{value}</span>
            <button
              onClick={onClear}
              title="Quitar"
              aria-label={`Quitar ${label}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-thread)', fontSize: '14px', padding: '0 2px', lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        id={id}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        onKeyDown={handleKey}
        style={{
          outline: 'none',
          border: '1.5px solid var(--color-dye)',
          borderRadius: '6px',
          maxHeight: '200px',
          overflowY: 'auto',
          backgroundColor: 'var(--color-cloth)',
        }}
        {...(rest['data-hotkey-search'] !== undefined ? { 'data-hotkey-search': '' } : {})}
      >
        {options.length === 0 && (
          <div style={{ padding: '12px 16px', color: 'var(--color-thread)', fontFamily: 'var(--font-sans)', fontSize: '13px' }}>
            Sin stock disponible
          </div>
        )}
        {options.map((opt, i) => {
          const avail = isAvailable(opt);
          const selected = opt === value;
          return (
            <div
              key={opt}
              data-opt={i}
              role="option"
              aria-selected={selected}
              aria-disabled={!avail}
              onClick={() => { if (avail) onSelect(opt); }}
              style={{
                padding: '9px 14px',
                cursor: avail ? 'pointer' : 'default',
                opacity: avail ? 1 : 0.35,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontFamily: 'var(--font-sans)',
                fontSize: '14px',
                fontWeight: selected ? 700 : i === activeIdx ? 600 : 400,
                color: 'var(--color-ink)',
                backgroundColor: selected
                  ? 'rgba(181,23,92,0.12)'
                  : i === activeIdx
                  ? 'rgba(181,23,92,0.06)'
                  : 'transparent',
                borderLeft: selected
                  ? '3px solid var(--color-dye)'
                  : i === activeIdx
                  ? '3px solid rgba(181,23,92,0.4)'
                  : '3px solid transparent',
                transition: 'background 0.08s',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>{renderOption ? renderOption(opt) : opt}</span>
              {selected && <span aria-hidden="true" style={{ color: 'var(--color-dye)', fontWeight: 700 }}>✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const stepLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'var(--color-thread)',
  marginBottom: '6px',
};

const hintStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '11px',
  color: 'var(--color-thread)',
};

// 11px uppercase thread-colored micro-label above cart-line inputs.
const microLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--color-thread)',
  marginBottom: '3px',
};

function MicroField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={microLabelStyle}>{label}</span>
      {children}
    </div>
  );
}

const dividerStyle: CSSProperties = {
  width: '1px',
  background: 'repeating-linear-gradient(to bottom, var(--color-thread) 0px, var(--color-thread) 4px, transparent 4px, transparent 8px)',
  flexShrink: 0,
  alignSelf: 'stretch',
  opacity: 0.4,
};

// ── main component ────────────────────────────────────────────────────────────

type View = 'terminal' | 'payment' | 'success';
type Facet = 'color' | 'nm' | 'fabric';

export default function SaleTerminal() {
  // ── stocked inventory ──
  const { data: stocked = [] } = useLiveQuery<StockedEntry[]>((d) => getStockedBatches(d));
  const { data: clients = [] } = useLiveQuery<ClientDoc[]>((d) => getClients(d));

  // ── cart state (read from cartDb on mount + after mutations) ──
  const [cart, setCart] = useState<CartDoc | null>(null);
  const [cartErr, setCartErr] = useState<string | null>(null);
  const [lineUpdateErr, setLineUpdateErr] = useState<string | null>(null);

  // Load cart once dbReady
  useEffect(() => {
    void dbReady.then(() => getCart(cartDb)).then(setCart).catch(console.error);
  }, []);

  // ── independent facet selection state ──
  // Three facets (color / nm / fabric) selectable in ANY order. Each facet's
  // AVAILABLE values are those consistent with the OTHER two facets' current
  // selections; a null selection matches anything. This keeps selections
  // mutually consistent regardless of the order the seller picks them.
  const [selColor, setSelColor] = useState<string | null>(null);
  const [selNm, setSelNm] = useState<string | null>(null);
  const [selFabric, setSelFabric] = useState<string | null>(null);

  const colorRef = useRef<ListboxHandle>(null);
  const nmRef = useRef<ListboxHandle>(null);
  const fabricRef = useRef<ListboxHandle>(null);
  const cashInputRef = useRef<HTMLInputElement>(null);

  // Terminal starts ready: focus the Color facet at mount (autoFocus is a no-op
  // on div listboxes — focus imperatively, see React focus note below).
  useEffect(() => { colorRef.current?.focus(); }, []);

  // Preselect facets when arriving from the dashboard (/venta?color=…&nm=…&fabric=…).
  // Values are the batch's display strings; if they no longer match a stocked
  // batch, the selections simply don't resolve and the seller picks normally.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const color = p.get('color');
    const nm = p.get('nm');
    const fabric = p.get('fabric');
    if (color && nm && fabric) {
      setSelColor(color);
      setSelNm(nm);
      setSelFabric(fabric);
    }
  }, []);

  // Facet option universe = distinct values across all stocked batches.
  const colors = [...new Set(stocked.map((e) => e.batch.color))].sort();
  const nms = [...new Set(stocked.map((e) => e.batch.nm))].sort();
  const fabrics = [...new Set(stocked.map((e) => e.batch.fabricType))].sort();

  // A value is available for its facet iff some stocked batch has that value AND
  // matches the (non-null) selections of the OTHER two facets.
  function available(facet: Facet, v: string): boolean {
    return stocked.some((e) => {
      const b = e.batch;
      const okColor = facet === 'color' ? b.color === v : selColor === null || b.color === selColor;
      const okNm = facet === 'nm' ? b.nm === v : selNm === null || b.nm === selNm;
      const okFabric = facet === 'fabric' ? b.fabricType === v : selFabric === null || b.fabricType === selFabric;
      return okColor && okNm && okFabric;
    });
  }

  // The matched batch (once all 3 are selected → unique key)
  const matchedEntry =
    selColor && selNm && selFabric
      ? stocked.find(
          (e) =>
            e.batch.color === selColor && e.batch.nm === selNm && e.batch.fabricType === selFabric,
        ) ?? null
      : null;

  // ── roll selector (ROLL batches) ──
  const [selRoll, setSelRoll] = useState<ProductDoc | null>(null);
  const [rollActiveIdx, setRollActiveIdx] = useState(0);

  // In-stock rolls for ROLL batch
  const stockedRolls = matchedEntry?.batch.productType === 'ROLL'
    ? (matchedEntry.products.filter((p) => p.currentWeightKg > 0.001) ?? [])
    : [];

  // ── quantity + price input ──
  const [qty, setQty] = useState('');
  const [unitPrice, setUnitPrice] = useState('');

  function focusQty(): void {
    setTimeout(() => (document.getElementById('venta-qty') as HTMLInputElement | null)?.focus(), 30);
  }

  // When a roll is picked, prefill price and focus qty
  useEffect(() => {
    if (selRoll) {
      setUnitPrice(String(selRoll.salePriceUsd));
      setQty('');
      focusQty();
    }
  }, [selRoll]);

  // For COMBO/PIECE: prefill price from pool product when batch matches
  useEffect(() => {
    if (matchedEntry && matchedEntry.batch.productType !== 'ROLL') {
      const pool = matchedEntry.products[0];
      if (pool) {
        setUnitPrice(String(pool.salePriceUsd));
        setQty('');
        focusQty();
      }
    }
  }, [matchedEntry]);

  // ── client picker ──
  const [clientSearch, setClientSearch] = useState('');
  const [clientOpen, setClientOpen] = useState(false);
  const [clientDropHighlight, setClientDropHighlight] = useState<number>(-1); // -1=none
  // Inline creation form state
  const [creatingClient, setCreatingClient] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientDocId, setNewClientDocId] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [newClientErr, setNewClientErr] = useState<string | null>(null);

  // Accent-insensitive fold (same logic as colorFor uses).
  const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const filteredClients = clients.filter((c) =>
    fold(c.name).includes(fold(clientSearch)) || fold(c.documentId).includes(fold(clientSearch)),
  );

  const selectedClient = cart?.clientId
    ? clients.find((c) => c._id === cart.clientId) ?? null
    : null;

  // ── credit terms ──
  const [creditTerms, setCreditTerms] = useState('');

  // ── view / payment panel ──
  const [view, setView] = useState<View>('terminal');
  const [payments, setPayments] = useState({ paidUsdCash: '', paidUsdTransfer: '', paidBs: '' });
  const [checkoutErr, setCheckoutErr] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [lastSale, setLastSale] = useState<{ totalUsd: number; status: PaymentStatus } | null>(null);

  // ── config rate (for display Bs) ──
  const { data: config } = useLiveQuery((d) => getConfig(d));
  const rate = config?.currentDailyRateBCV ?? 0;

  // ── total ──
  const totalUsd = cart ? round2(cart.lines.reduce((s, l) => s + l.lineSubtotalUsd, 0)) : 0;

  // ── cart-derived sets for feature A + B ──
  // inCartRollIds: product ids of Kg lines already in the cart (for duplicate guard).
  // inCartQty: summed quantity per productId (for stock-cap accounting).
  const inCartRollIds = new Set(
    (cart?.lines ?? []).filter((l) => l.unitOfMeasure === 'Kg').map((l) => l.productId),
  );
  const inCartQty = new Map<string, number>();
  for (const l of cart?.lines ?? []) {
    inCartQty.set(l.productId, (inCartQty.get(l.productId) ?? 0) + l.quantity);
  }

  // ── payment status preview ──
  const paidCash = parseFloat(payments.paidUsdCash) || 0;
  const paidTransfer = parseFloat(payments.paidUsdTransfer) || 0;
  const paidBsNum = parseFloat(payments.paidBs) || 0;
  const previewStatus: PaymentStatus = computePaymentStatus(
    totalUsd,
    paidCash,
    paidTransfer,
    paidBsNum,
    rate,
  );
  const paidTotalUsd = paidCash + paidTransfer + (rate > 0 ? paidBsNum / rate : 0);
  const remainingUsd = Math.max(0, totalUsd - paidTotalUsd);

  // ── selection helpers ──
  function resetSelection(): void {
    selRef.current = { color: null, nm: null, fabric: null };
    setSelColor(null);
    setSelNm(null);
    setSelFabric(null);
    setSelRoll(null);
    setRollActiveIdx(0);
    setQty('');
    setUnitPrice('');
    setCartErr(null);
  }

  // AUTO-COMPLETE runs on SELECT only, never on clear. As an always-on effect
  // it made deselection impossible: whenever the other two facets uniquely
  // determined the third, Escape/× cleared it and the effect re-picked it in
  // the same tick. Select-driven cascading keeps the speed win without
  // fighting the seller's explicit "quitar".
  type Sel = { color: string | null; nm: string | null; fabric: string | null };
  const selRef = useRef<Sel>({ color: null, nm: null, fabric: null });

  function cascade(sel: Sel): Sel {
    const cur = { ...sel };
    for (let pass = 0; pass < 3; pass++) {
      const pool = stocked.filter(
        (e) =>
          (cur.color === null || e.batch.color === cur.color) &&
          (cur.nm === null || e.batch.nm === cur.nm) &&
          (cur.fabric === null || e.batch.fabricType === cur.fabric),
      );
      let changed = false;
      if (cur.color === null) {
        const vals = [...new Set(pool.map((e) => e.batch.color))];
        if (vals.length === 1) { cur.color = vals[0]; changed = true; }
      }
      if (cur.nm === null) {
        const vals = [...new Set(pool.map((e) => e.batch.nm))];
        if (vals.length === 1) { cur.nm = vals[0]; changed = true; }
      }
      if (cur.fabric === null) {
        const vals = [...new Set(pool.map((e) => e.batch.fabricType))];
        if (vals.length === 1) { cur.fabric = vals[0]; changed = true; }
      }
      if (!changed) break;
    }
    return cur;
  }

  function applySel(next: Sel, didSelect: boolean): void {
    const fin = didSelect ? cascade(next) : next;
    selRef.current = fin;
    setSelColor(fin.color);
    setSelNm(fin.nm);
    setSelFabric(fin.fabric);
    setSelRoll(null);
  }

  // Toggle-select a facet: pick it (cascading singletons), or clear it if the
  // same value is re-picked. Any facet change invalidates the roll selection.
  const toggleColor = (c: string) =>
    applySel({ color: selColor === c ? null : c, nm: selNm, fabric: selFabric }, selColor !== c);
  const toggleNm = (n: string) =>
    applySel({ color: selColor, nm: selNm === n ? null : n, fabric: selFabric }, selNm !== n);
  const toggleFabric = (f: string) =>
    applySel({ color: selColor, nm: selNm, fabric: selFabric === f ? null : f }, selFabric !== f);

  const clearFacet = (f: Facet) =>
    applySel(
      {
        color: f === 'color' ? null : selColor,
        nm: f === 'nm' ? null : selNm,
        fabric: f === 'fabric' ? null : selFabric,
      },
      false,
    );

  // Focus order for Enter-advance: hand focus to the next UNSELECTED facet
  // (color→nm→fabric, wrapping); if all are selected, let the product zone's
  // own focus effects (roll list / qty input) take over.
  function advanceFrom(facet: Facet): void {
    const order: Facet[] = ['color', 'nm', 'fabric'];
    // selRef holds the just-applied, post-cascade selection (state is stale here).
    const sel = selRef.current;
    const refs: Record<Facet, React.RefObject<ListboxHandle | null>> = { color: colorRef, nm: nmRef, fabric: fabricRef };
    const start = order.indexOf(facet);
    for (let k = 1; k <= order.length; k++) {
      const f = order[(start + k) % order.length];
      if (sel[f] === null) { refs[f].current?.focus(); return; }
    }
    // No unselected facet left → product zone effects will grab focus.
  }

  // ── add to cart ──
  async function handleAddToCart(): Promise<void> {
    setCartErr(null);
    if (!matchedEntry) return;
    const { batch, products } = matchedEntry;
    const qtyNum = parseFloat(qty);
    const priceNum = parseFloat(unitPrice);

    if (!(qtyNum > 0)) { setCartErr('Ingrese una cantidad válida.'); return; }
    if (!(priceNum > 0)) { setCartErr('Ingrese un precio válido.'); return; }

    let productDoc: ProductDoc | undefined;
    let productId: string;
    const uom = UNIT_FOR[batch.productType];

    if (batch.productType === 'ROLL') {
      if (!selRoll) { setCartErr('Seleccione un rollo.'); return; }
      if (inCartRollIds.has(selRoll._id)) {
        setCartErr('Ese rollo ya está en el carrito.');
        return;
      }
      if (qtyNum > selRoll.currentWeightKg) {
        setCartErr(`Solo quedan ${fmtKg(selRoll.currentWeightKg)} en ese rollo.`);
        return;
      }
      productDoc = selRoll;
      productId = selRoll._id;
    } else {
      productDoc = products[0]; // pool doc
      if (!productDoc) { setCartErr('Producto no encontrado.'); return; }
      const inCart = inCartQty.get(productDoc._id) ?? 0;
      const remaining = batch.currentUnits - inCart;
      if (qtyNum > remaining) {
        if (inCart > 0) {
          setCartErr(`Solo quedan ${fmtUnits(Math.max(0, remaining))} disponibles (el carrito ya tiene ${fmtUnits(inCart)}).`);
        } else {
          setCartErr(`Solo quedan ${fmtUnits(batch.currentUnits)} en stock.`);
        }
        return;
      }
      productId = productDoc._id;
    }

    const line: CartLineItem = {
      productId,
      batchId: batch._id,
      description: `${batch.color} · NM ${batch.nm} · ${batch.fabricType}${batch.productType === 'ROLL' ? ' · R' + (productDoc?.pieceId ?? '') : ''}`,
      quantity: qtyNum,
      unitOfMeasure: uom,
      unitPriceAtSale: priceNum,
      lineSubtotalUsd: round2(qtyNum * priceNum),
    };

    try {
      const updated = await addLine(cartDb, line);
      setCart(updated);
      resetSelection();
    } catch (err) {
      setCartErr((err as Error).message);
    }
  }

  // ── cart mutations ──
  async function handleUpdateLine(idx: number, patch: Partial<CartLineItem>): Promise<void> {
    if (patch.quantity !== undefined) {
      const q = patch.quantity;
      if (!isFinite(q) || q <= 0) {
        setLineUpdateErr('Ingrese una cantidad válida.');
        return;
      }
      // Stock cap: find the current line to determine uom and product
      const line = cart?.lines[idx];
      if (line) {
        if (line.unitOfMeasure === 'Kg') {
          // Find the roll's current weight in stocked entries
          const entry = stocked.find((e) => e.batch._id === line.batchId);
          const rollDoc = entry?.products.find((p) => p._id === line.productId);
          if (rollDoc) {
            if (q > rollDoc.currentWeightKg) {
              setLineUpdateErr(`Solo quedan ${fmtKg(rollDoc.currentWeightKg)} en ese rollo.`);
              return;
            }
          }
          // If not found in stocked (sold out elsewhere), allow — checkout re-validates
        } else {
          // Units: cap by batch.currentUnits
          const entry = stocked.find((e) => e.batch._id === line.batchId);
          if (entry) {
            if (q > entry.batch.currentUnits) {
              setLineUpdateErr(`Solo quedan ${fmtUnits(entry.batch.currentUnits)} disponibles.`);
              return;
            }
          }
        }
      }
    }
    const updated = await updateLine(cartDb, idx, patch);
    setCart(updated);
    setLineUpdateErr(null);
  }

  async function handleRemoveLine(idx: number): Promise<void> {
    const updated = await removeLine(cartDb, idx);
    setCart(updated);
    setLineUpdateErr(null);
  }

  async function handleSetClient(clientId: string | null): Promise<void> {
    const updated = await setClient(cartDb, clientId);
    setCart(updated);
    setClientOpen(false);
    setClientSearch('');
  }

  async function handleSetOnTheBooks(v: boolean): Promise<void> {
    const updated = await setOnTheBooks(cartDb, v);
    setCart(updated);
  }

  function startCreatingClient(): void {
    setCreatingClient(true);
    setNewClientName(clientSearch);
    setNewClientDocId('');
    setNewClientPhone('');
    setNewClientErr(null);
    setClientOpen(false);
  }

  function cancelCreatingClient(): void {
    setCreatingClient(false);
    setNewClientErr(null);
  }

  async function handleSaveNewClient(): Promise<void> {
    setNewClientErr(null);
    const name = newClientName.trim();
    const docId = newClientDocId.trim();
    if (!name) { setNewClientErr('El nombre es obligatorio.'); return; }
    if (!docId) { setNewClientErr('La cédula/RIF es obligatoria.'); return; }
    // Fast UX pre-check against the live list; saveClient(createOnly) is the real
    // guard — it re-reads from the DB atomically, so a client not yet in this
    // reactive snapshot still can't be silently overwritten.
    const existingId = clientIdOf(docId);
    if (clients.some((c) => c._id === existingId)) {
      setNewClientErr('Ya existe un cliente con ese documento.');
      return;
    }
    const entityType = /^j/i.test(docId) ? 'COMPANY' as const : 'PERSON' as const;
    try {
      const saved = await saveClient(db, {
        documentId: docId,
        entityType,
        name,
        phoneNumber: newClientPhone.trim() || undefined,
      }, { createOnly: true });
      const updated = await setClient(cartDb, saved._id);
      setCart(updated);
      setCreatingClient(false);
      setClientSearch('');
    } catch (err) {
      setNewClientErr((err as Error).message);
    }
  }

  // ── checkout ──
  async function handleCheckout(): Promise<void> {
    setCheckoutErr(null);
    if (!cart?.lines.length) { setCheckoutErr('El carrito está vacío.'); return; }
    if (previewStatus !== 'PAID' && !cart.clientId) {
      setCheckoutErr('Las ventas a crédito requieren un cliente seleccionado.');
      return;
    }

    if (!config?.currentDailyRateBCV) {
      setCheckoutErr('No hay tasa del día configurada. Configure la tasa en /configuracion antes de procesar ventas.');
      return;
    }

    setCheckoutLoading(true);
    try {
      const exchangeRateBCV = config.currentDailyRateBCV; // read ONCE, passed immutably
      const sale = await checkout(db, {
        transactionId: cart.transactionId,
        createdAt: cart.createdAt,
        clientId: cart.clientId,
        isOnTheBooks: cart.isOnTheBooks,
        exchangeRateBCV,
        creditTerms: creditTerms.trim() || null,
        operatorId: cachedUser()?.name ?? 'desconocido',
        lines: cart.lines,
        payments: { paidUsdCash: paidCash, paidUsdTransfer: paidTransfer, paidBs: paidBsNum },
      });
      setLastSale({ totalUsd: sale.totalUsd, status: sale.paymentStatus });
      const fresh = await clearCart(cartDb);
      setCart(fresh);
      setPayments({ paidUsdCash: '', paidUsdTransfer: '', paidBs: '' });
      setCreditTerms('');
      setView('success');
    } catch (err) {
      setCheckoutErr((err as Error).message);
    } finally {
      setCheckoutLoading(false);
    }
  }

  function handleNewSale(): void {
    setView('terminal');
    setLastSale(null);
    resetSelection();
  }

  // Focus first payment input when payment view opens.
  useEffect(() => {
    if (view === 'payment') {
      setTimeout(() => cashInputRef.current?.focus(), 30);
    }
  }, [view]);

  // ── Ctrl+Enter global checkout ──
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // Never fire global shortcuts while the seller is typing in the inline client form.
      const t = e.target as HTMLElement;
      if (creatingClient && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (view === 'terminal' && (cart?.lines.length ?? 0) > 0) setView('payment');
        else if (view === 'payment') void handleCheckout();
      }
      if (e.key === 'n' && view === 'success') {
        if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') handleNewSale();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `payments` is in the deps so Ctrl+Enter re-closes over a handleCheckout with
    // the current amounts even when previewStatus doesn't change (e.g. a re-typed
    // value that parses to the same status).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cart, config, previewStatus, payments, creatingClient]);

  // ── SUCCESS VIEW ──────────────────────────────────────────────────────────
  if (view === 'success' && lastSale) {
    return (
      <div style={{ maxWidth: '480px', margin: '60px auto', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div style={{ fontSize: '40px', lineHeight: 1 }}>✓</div>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 700, color: 'var(--color-ink)', margin: 0 }}>
          Venta registrada
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
          <Money usd={lastSale.totalUsd} rate={rate || undefined} />
          <Badge tone={paymentTone(lastSale.status)}>{paymentLabel(lastSale.status)}</Badge>
        </div>
        <Button size="lg" onClick={handleNewSale}>
          Nueva venta <Kbd>N</Kbd>
        </Button>
      </div>
    );
  }

  // ── PAYMENT VIEW ─────────────────────────────────────────────────────────
  if (view === 'payment') {
    return (
      <div style={{ maxWidth: '520px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Button variant="ghost" onClick={() => setView('terminal')} style={{ padding: '0 12px', minHeight: '36px', fontSize: '13px' }}>
            ← Volver
          </Button>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '18px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
            Cobrar
          </h2>
        </div>

        <div style={{ padding: '16px', border: '1px dashed var(--color-thread)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)' }}>Total</span>
          <Money usd={totalUsd} rate={rate || undefined} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Field label="$ Efectivo">
            <NumberInput
              ref={cashInputRef}
              placeholder="0.00"
              value={payments.paidUsdCash}
              onChange={(e) => setPayments((p) => ({ ...p, paidUsdCash: e.target.value }))}
              min={0}
            />
          </Field>
          <Field label="$ Transferencia">
            <NumberInput
              placeholder="0.00"
              value={payments.paidUsdTransfer}
              onChange={(e) => setPayments((p) => ({ ...p, paidUsdTransfer: e.target.value }))}
              min={0}
            />
          </Field>
          <Field label="Bolívares">
            <NumberInput
              placeholder="0.00"
              value={payments.paidBs}
              onChange={(e) => setPayments((p) => ({ ...p, paidBs: e.target.value }))}
              min={0}
            />
            {rate > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', marginTop: '4px' }}>
                Tasa: {fmtBs(rate)} / $1
              </span>
            )}
          </Field>
        </div>

        {/* Remaining */}
        <div style={{ padding: '14px 16px', borderRadius: '8px', background: remainingUsd > 0.009 ? 'rgba(185,119,24,0.08)' : 'rgba(62,107,58,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)' }}>
            {remainingUsd > 0.009 ? 'Restante' : 'Cubierto'}
          </span>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {remainingUsd > 0.009 && <Money usd={remainingUsd} rate={rate || undefined} />}
            <Badge tone={paymentTone(previewStatus)}>{paymentLabel(previewStatus)}</Badge>
          </div>
        </div>

        {(previewStatus === 'PENDING' || previewStatus === 'PARTIAL') && !cart?.clientId && (
          <div style={{ padding: '10px 14px', borderRadius: '6px', background: 'rgba(163,46,46,0.08)', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }}>
            Las ventas pendientes o parciales requieren un cliente seleccionado (crédito necesita deudor).
          </div>
        )}

        {rate === 0 && (
          <div style={{ padding: '10px 14px', borderRadius: '6px', background: 'rgba(163,46,46,0.08)', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }}>
            No hay tasa del día.{' '}
            <a href="/configuracion" style={{ color: 'var(--color-dye)' }}>Configurar tasa</a>
          </div>
        )}

        {checkoutErr && (
          <div style={{ padding: '10px 14px', borderRadius: '6px', background: 'rgba(163,46,46,0.08)', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }} role="alert">
            {checkoutErr}
          </div>
        )}

        <Button
          size="lg"
          onClick={() => void handleCheckout()}
          disabled={checkoutLoading || (!cart?.clientId && previewStatus !== 'PAID')}
        >
          {checkoutLoading ? 'Procesando…' : 'Confirmar venta'} <Kbd>Ctrl+↵</Kbd>
        </Button>
      </div>
    );
  }

  // ── TERMINAL VIEW ─────────────────────────────────────────────────────────
  return (
    <div className="venta-split">

      {/* ── LEFT: cascading selector ── */}
      <div className="venta-facets">

        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '18px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
            Nueva venta
          </h1>
          <Kbd>/</Kbd>
          <span style={hintStyle}>buscar</span>
        </div>

        {/* Three INDEPENDENT facets — any order. Availability narrows mutually. */}
        <Listbox
          id="lb-color"
          label="Color"
          options={colors}
          value={selColor}
          isAvailable={(c) => available('color', c)}
          onSelect={toggleColor}
          onClear={() => clearFacet('color')}
          onAdvance={() => advanceFrom('color')}
          handleRef={colorRef}
          data-hotkey-search=""
          renderOption={(c) => <SwatchChip color={c} size="sm" />}
        />

        <Listbox
          id="lb-nm"
          label="NM (grueso)"
          options={nms}
          value={selNm}
          isAvailable={(n) => available('nm', n)}
          onSelect={toggleNm}
          onClear={() => clearFacet('nm')}
          onAdvance={() => advanceFrom('nm')}
          handleRef={nmRef}
        />

        <Listbox
          id="lb-fabric"
          label="Tipo de tela"
          options={fabrics}
          value={selFabric}
          isAvailable={(f) => available('fabric', f)}
          onSelect={toggleFabric}
          onClear={() => clearFacet('fabric')}
          onAdvance={() => advanceFrom('fabric')}
          handleRef={fabricRef}
        />

        {/* Keyboard hint strip */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Kbd>↹</Kbd><span style={hintStyle}>campo</span>
          <Kbd>↑↓</Kbd><span style={hintStyle}>navegar</span>
          <Kbd>↵</Kbd><span style={hintStyle}>elegir</span>
          <Kbd>Esc</Kbd><span style={hintStyle}>quitar</span>
        </div>

        {/* Product picker + qty/price — appears once all three facets are set */}
        {matchedEntry && (
          <BatchProductZone
            entry={matchedEntry}
            stockedRolls={stockedRolls}
            selRoll={selRoll}
            setSelRoll={(r) => { setSelRoll(r); setRollActiveIdx(stockedRolls.indexOf(r!)); }}
            rollActiveIdx={rollActiveIdx}
            setRollActiveIdx={setRollActiveIdx}
            qty={qty}
            setQty={setQty}
            unitPrice={unitPrice}
            setUnitPrice={setUnitPrice}
            onAdd={() => void handleAddToCart()}
            onBack={() => { setSelFabric(null); setSelRoll(null); }}
            error={cartErr}
            inCartRollIds={inCartRollIds}
          />
        )}
      </div>

      {/* ── STITCH DIVIDER ── */}
      <div className="venta-divider" style={dividerStyle} />

      {/* ── RIGHT: cart ── */}
      <div className="venta-cart">

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-thread)', margin: 0 }}>
            Carrito
          </h2>
          {(cart?.lines.length ?? 0) > 0 && (
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
              {cart!.lines.length} ítem{cart!.lines.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Cart lines */}
        {(cart?.lines.length ?? 0) === 0 ? (
          <EmptyState title="El carrito está vacío" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {cart!.lines.map((line, idx) => (
              <CartLine
                key={`${line.productId}-${idx}`}
                line={line}
                rate={rate}
                onUpdate={(patch) => void handleUpdateLine(idx, patch)}
                onRemove={() => void handleRemoveLine(idx)}
              />
            ))}
          </div>
        )}

        {/* Cart line update errors */}
        {lineUpdateErr && (
          <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'rgba(163,46,46,0.08)', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }} role="alert">
            {lineUpdateErr}
          </div>
        )}

        {/* Total */}
        {(cart?.lines.length ?? 0) > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '2px dashed var(--color-thread)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 700, color: 'var(--color-thread)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Total
            </span>
            <Money usd={totalUsd} rate={rate || undefined} />
          </div>
        )}

        {/* Client picker */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={stepLabelStyle}>Cliente</div>
          {selectedClient ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', border: '1.5px solid var(--color-dye)', borderRadius: '6px', backgroundColor: 'var(--color-cloth)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600, color: 'var(--color-ink)' }}>{selectedClient.name}</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>{selectedClient.documentId}</div>
              </div>
              <button
                onClick={() => void handleSetClient(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-thread)', fontSize: '16px', padding: '4px', lineHeight: 1 }}
                title="Quitar cliente"
              >
                ×
              </button>
            </div>
          ) : creatingClient ? (
            /* Inline creation form */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: '1.5px dashed var(--color-dye)', borderRadius: '6px', backgroundColor: 'var(--color-cloth)' }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 700, color: 'var(--color-dye)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Nuevo cliente
              </div>
              <Field label="Nombre">
                <Input
                  autoFocus
                  placeholder="Nombre completo"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); void handleSaveNewClient(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelCreatingClient(); }
                  }}
                />
              </Field>
              <Field label="Cédula / RIF">
                <Input
                  placeholder="V-12345678 o J-12345678"
                  value={newClientDocId}
                  onChange={(e) => setNewClientDocId(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); void handleSaveNewClient(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelCreatingClient(); }
                  }}
                />
              </Field>
              <Field label="Teléfono (opcional)">
                <Input
                  type="tel"
                  placeholder="+58 412-000-0000"
                  value={newClientPhone}
                  onChange={(e) => setNewClientPhone(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); void handleSaveNewClient(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelCreatingClient(); }
                  }}
                />
              </Field>
              {newClientErr && (
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }} role="alert">{newClientErr}</div>
              )}
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button size="md" onClick={() => void handleSaveNewClient()}>Guardar</Button>
                <Button size="md" variant="ghost" onClick={cancelCreatingClient}>Cancelar</Button>
              </div>
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <Input
                aria-label="Buscar cliente"
                placeholder="Buscar cliente… o dejar sin cliente"
                value={clientSearch}
                onChange={(e) => { setClientSearch(e.target.value); setClientOpen(true); setClientDropHighlight(-1); }}
                onFocus={() => { setClientOpen(true); setClientDropHighlight(-1); }}
                onBlur={() => setTimeout(() => setClientOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    if (clientSearch) { setClientSearch(''); setClientDropHighlight(-1); }
                    else setClientOpen(false);
                    return;
                  }
                  // Dropdown keyboard nav: items are [Sin cliente, ...filteredClients, + Crear (if no match)]
                  const hasCreate = clientSearch.trim() !== '' && filteredClients.length === 0;
                  const itemCount = 1 + filteredClients.length + (hasCreate ? 1 : 0);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setClientDropHighlight((h) => Math.min(h + 1, itemCount - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setClientDropHighlight((h) => Math.max(h - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const h = clientDropHighlight;
                    if (h === 0) { void handleSetClient(null); return; }
                    if (h >= 1 && h <= filteredClients.length) {
                      void handleSetClient(filteredClients[h - 1]._id); return;
                    }
                    if (hasCreate && h === itemCount - 1) { startCreatingClient(); return; }
                    // Enter with no highlight and a unique match: pick it.
                    if (filteredClients.length === 1) void handleSetClient(filteredClients[0]._id);
                  }
                }}
              />
              {clientOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, border: '1.5px solid var(--color-dye)', borderRadius: '6px', backgroundColor: 'var(--color-cloth)', maxHeight: '180px', overflowY: 'auto', marginTop: '2px' }}>
                  {/* Sin cliente — index 0 */}
                  <div
                    onMouseDown={() => void handleSetClient(null)}
                    style={{ padding: '9px 14px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', borderBottom: '1px solid var(--color-thread)', backgroundColor: clientDropHighlight === 0 ? 'rgba(181,23,92,0.06)' : 'transparent' }}
                  >
                    Sin cliente
                  </div>
                  {filteredClients.map((c, ci) => (
                    <div
                      key={c._id}
                      onMouseDown={() => void handleSetClient(c._id)}
                      style={{ padding: '9px 14px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', backgroundColor: clientDropHighlight === ci + 1 ? 'rgba(181,23,92,0.06)' : 'transparent' }}
                    >
                      {c.name}
                      <span style={{ fontSize: '11px', color: 'var(--color-thread)', marginLeft: '8px' }}>{c.documentId}</span>
                    </div>
                  ))}
                  {/* Inline create option when search is non-empty and no match */}
                  {clientSearch.trim() !== '' && filteredClients.length === 0 && (
                    <div
                      onMouseDown={startCreatingClient}
                      style={{ padding: '9px 14px', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-dye)', fontWeight: 600, backgroundColor: clientDropHighlight === 1 ? 'rgba(181,23,92,0.06)' : 'transparent' }}
                    >
                      + Crear cliente «{clientSearch}»
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* En libros toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={cart?.isOnTheBooks ?? true}
            onChange={(e) => void handleSetOnTheBooks(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--color-dye)', cursor: 'pointer' }}
          />
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', fontWeight: 500 }}>En libros</span>
        </label>

        {/* Credit terms */}
        {(cart?.isOnTheBooks === false || previewStatus !== 'PAID') && (
          <Field label="Condiciones de crédito" hint="Opcional — p.ej. «30 días», «cuotas semanales»">
            <Input
              placeholder="Ej.: pago en 30 días"
              value={creditTerms}
              onChange={(e) => setCreditTerms(e.target.value)}
            />
          </Field>
        )}

        {/* Checkout button */}
        <Button
          size="lg"
          onClick={() => setView('payment')}
          disabled={(cart?.lines.length ?? 0) === 0}
          style={{ marginTop: '8px' }}
        >
          Cobrar <Kbd>Ctrl+↵</Kbd>
        </Button>
      </div>
    </div>
  );
}

// ── BatchProductZone — roll list or unit qty ──────────────────────────────────

interface BatchProductZoneProps {
  entry: StockedEntry;
  stockedRolls: ProductDoc[];
  selRoll: ProductDoc | null;
  setSelRoll: (r: ProductDoc | null) => void;
  rollActiveIdx: number;
  setRollActiveIdx: (i: number) => void;
  qty: string;
  setQty: (v: string) => void;
  unitPrice: string;
  setUnitPrice: (v: string) => void;
  onAdd: () => void;
  onBack: () => void;
  error: string | null;
  inCartRollIds: Set<string>;
}

function BatchProductZone({
  entry,
  stockedRolls,
  selRoll,
  setSelRoll,
  rollActiveIdx,
  setRollActiveIdx,
  qty,
  setQty,
  unitPrice,
  setUnitPrice,
  onAdd,
  onBack,
  error,
  inCartRollIds,
}: BatchProductZoneProps) {
  const { batch } = entry;
  const isRoll = batch.productType === 'ROLL';
  const rollListRef = useRef<HTMLDivElement>(null);

  // ROLL stock is total Kg across rolls, NOT currentUnits (that's a roll count).
  // Never render a roll count with a Kg unit (domain rule: never mix Kg/units).
  const stockText = isRoll
    ? `${stockedRolls.length} rollo${stockedRolls.length !== 1 ? 's' : ''} · ${fmtKg(
        stockedRolls.reduce((s, p) => s + p.currentWeightKg, 0),
      )}`
    : fmtUnits(batch.currentUnits);

  // Initial/auto active index: first roll NOT already in the cart.
  const firstAvailRollIdx = stockedRolls.findIndex((r) => !inCartRollIds.has(r._id));

  function focusQtyInput(): void {
    setTimeout(() => (document.getElementById('venta-qty') as HTMLInputElement | null)?.focus(), 20);
  }

  // Keyboard nav on the roll list — skips in-cart rolls (mirroring Listbox step()).
  function stepRoll(from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < stockedRolls.length; i += dir) {
      if (!inCartRollIds.has(stockedRolls[i]._id)) return i;
    }
    return from;
  }

  function handleRollKey(e: RKE<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = stepRoll(rollActiveIdx, 1);
      setRollActiveIdx(next);
      setSelRoll(stockedRolls[next] ?? null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = stepRoll(rollActiveIdx, -1);
      setRollActiveIdx(next);
      setSelRoll(stockedRolls[next] ?? null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = stockedRolls[rollActiveIdx];
      if (r && !inCartRollIds.has(r._id)) { setSelRoll(r); focusQtyInput(); }
    } else if (e.key === 'Escape') {
      onBack();
    }
  }

  // Auto-scroll active roll
  useEffect(() => {
    const el = rollListRef.current?.querySelector(`[data-ridx="${rollActiveIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [rollActiveIdx]);

  // autoFocus is a no-op on divs in React — focus the roll list imperatively
  // when it appears (and when Escape clears the roll selection).
  // Also seed the active index to the first available (non-cart) roll.
  useEffect(() => {
    if (isRoll && !selRoll) {
      if (firstAvailRollIdx >= 0) setRollActiveIdx(firstAvailRollIdx);
      rollListRef.current?.focus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRoll, selRoll]);

  function handleQtyKey(e: RKE<HTMLInputElement>): void {
    if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
    if (e.key === 'Escape') { onBack(); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Batch summary card */}
      <div style={{ padding: '10px 14px', border: '1.5px solid var(--color-dye)', borderRadius: '8px', backgroundColor: 'var(--color-cloth)', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <SwatchChip color={batch.color} size="sm" />
        <div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600, color: 'var(--color-ink)' }}>
            NM {batch.nm} · {batch.fabricType}
          </div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>
            {batch.location} · Stock: {stockText}
          </div>
        </div>
      </div>

      {isRoll ? (
        <>
          <div style={stepLabelStyle}>Selecciona un rollo</div>
          <div
            ref={rollListRef}
            tabIndex={0}
            role="listbox"
            aria-label="Rollos disponibles"
            onKeyDown={handleRollKey}
            autoFocus={!selRoll}
            style={{ outline: 'none', border: '1.5px solid var(--color-thread)', borderRadius: '6px', maxHeight: '200px', overflowY: 'auto', backgroundColor: 'var(--color-cloth)' }}
          >
            {stockedRolls.map((roll, i) => {
              const inCart = inCartRollIds.has(roll._id);
              return (
                <div
                  key={roll._id}
                  data-ridx={i}
                  role="option"
                  aria-selected={selRoll?._id === roll._id}
                  aria-disabled={inCart}
                  onClick={() => { if (!inCart) { setRollActiveIdx(i); setSelRoll(roll); focusQtyInput(); } }}
                  style={{
                    padding: '9px 14px',
                    cursor: inCart ? 'default' : 'pointer',
                    opacity: inCart ? 0.45 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    backgroundColor: i === rollActiveIdx ? 'rgba(181,23,92,0.08)' : 'transparent',
                    borderLeft: i === rollActiveIdx ? '3px solid var(--color-dye)' : '3px solid transparent',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-ink)', minWidth: '64px' }}>{fmtKg(roll.currentWeightKg)}</span>
                  <span style={{ color: 'var(--color-thread)', fontSize: '11px', textTransform: 'uppercase' }}>{roll.pieceId}</span>
                  <Badge tone={conditionTone(roll.conditionTag)}>{conditionLabel(roll.conditionTag)}</Badge>
                  {inCart
                    ? <Badge tone="neutral">EN CARRITO</Badge>
                    : <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-ink)' }}>{fmtUsd(roll.salePriceUsd)}/kg</span>
                  }
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Kbd>↑↓</Kbd><span style={hintStyle}>rollo</span>
            <Kbd>↵</Kbd><span style={hintStyle}>seleccionar</span>
          </div>
        </>
      ) : null}

      {/* Qty + price inputs */}
      {(selRoll || !isRoll) && (
        <>
          <Field label={isRoll ? `Cantidad (kg, máx. ${selRoll ? fmtKg(selRoll.currentWeightKg) : '–'})` : `Cantidad (unidades, máx. ${batch.currentUnits})`}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <NumberInput
                id="venta-qty"
                placeholder={isRoll ? '0.000' : '0'}
                value={qty}
                min={0}
                max={isRoll ? selRoll?.currentWeightKg : batch.currentUnits}
                step={isRoll ? 0.001 : 1}
                onChange={(e) => setQty(e.target.value)}
                onKeyDown={handleQtyKey}
                style={{ flex: 1 }}
              />
              {isRoll && selRoll && (
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setQty(String(selRoll.currentWeightKg))}
                  style={{ whiteSpace: 'nowrap', minWidth: 'auto', padding: '0 12px' }}
                >
                  Rollo completo
                </Button>
              )}
            </div>
          </Field>

          <Field label="Precio unitario (USD)">
            <NumberInput
              placeholder="0.00"
              value={unitPrice}
              min={0}
              step={0.01}
              onChange={(e) => setUnitPrice(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }}
            />
          </Field>

          {error && (
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }} role="alert">{error}</div>
          )}

          <Button onClick={onAdd} size="lg">
            Agregar al carrito <Kbd>↵</Kbd>
          </Button>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Kbd>Esc</Kbd><span style={hintStyle}>volver</span>
          </div>
        </>
      )}
    </div>
  );
}

// ── CartLine ──────────────────────────────────────────────────────────────────

interface CartLineProps {
  line: CartLineItem;
  rate: number;
  onUpdate: (patch: Partial<CartLineItem>) => void;
  onRemove: () => void;
}

function CartLine({ line, rate, onUpdate, onRemove }: CartLineProps) {
  const isKg = line.unitOfMeasure === 'Kg';

  return (
    <div
      style={{
        padding: '12px 14px',
        border: '1px dashed var(--color-thread)',
        borderRadius: '8px',
        backgroundColor: 'var(--color-cloth)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* Description row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600, color: 'var(--color-ink)', flex: 1 }}>
          {line.description}
        </span>
        <button
          onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', fontSize: '16px', padding: '0 4px', lineHeight: 1, flexShrink: 0 }}
          title="Quitar"
          aria-label="Quitar ítem"
        >
          ×
        </button>
      </div>

      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
        {/* Qty */}
        <MicroField label={isKg ? 'Cant · Kg' : 'Cant · Ud'}>
          {isKg ? (
            <NumberInput
              value={line.quantity}
              min={0.001}
              step={0.001}
              onChange={(e) => {
                const q = parseFloat(e.target.value);
                if (q > 0) onUpdate({ quantity: q, lineSubtotalUsd: round2(q * line.unitPriceAtSale) });
              }}
              style={{ width: '100px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}
              aria-label="Cantidad en kg"
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
              <button
                onClick={() => { const q = line.quantity - 1; if (q > 0) onUpdate({ quantity: q, lineSubtotalUsd: round2(q * line.unitPriceAtSale) }); }}
                disabled={line.quantity <= 1}
                style={{ minWidth: '44px', minHeight: '44px', border: '1.5px solid var(--color-thread)', borderRadius: '6px 0 0 6px', background: 'var(--color-cloth)', cursor: 'pointer', fontSize: '18px', fontWeight: 600, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                aria-label="Reducir cantidad"
              >
                −
              </button>
              <div style={{ minWidth: '48px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700, padding: '0 6px', border: '1.5px solid var(--color-thread)', borderLeft: 'none', borderRight: 'none', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-ink)' }}>
                {line.quantity}
              </div>
              <button
                onClick={() => { const q = line.quantity + 1; onUpdate({ quantity: q, lineSubtotalUsd: round2(q * line.unitPriceAtSale) }); }}
                style={{ minWidth: '44px', minHeight: '44px', border: '1.5px solid var(--color-thread)', borderRadius: '0 6px 6px 0', background: 'var(--color-cloth)', cursor: 'pointer', fontSize: '18px', fontWeight: 600, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                aria-label="Aumentar cantidad"
              >
                +
              </button>
            </div>
          )}
        </MicroField>

        {/* Price */}
        <MicroField label={isKg ? 'Precio · $/Kg' : 'Precio · $/Ud'}>
          <NumberInput
            value={line.unitPriceAtSale}
            min={0.01}
            step={0.01}
            onChange={(e) => {
              const p = parseFloat(e.target.value);
              if (p > 0) onUpdate({ unitPriceAtSale: p, lineSubtotalUsd: round2(line.quantity * p) });
            }}
            style={{ width: '90px', fontFamily: 'var(--font-mono)', fontSize: '13px' }}
            aria-label="Precio unitario USD"
          />
        </MicroField>

        {/* Subtotal */}
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span style={microLabelStyle}>Subtotal</span>
          <Money usd={line.lineSubtotalUsd} rate={rate || undefined} />
        </div>
      </div>
    </div>
  );
}
