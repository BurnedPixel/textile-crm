// /inventario shell. PouchDB browser-only → client:only="react".
//
// Two panes, and only ONE is mounted at a time. That is not a style choice: the
// global "/" hotkey (Layout.astro) resolves to the FIRST [data-hotkey-search] in
// DOM order, so a pane merely hidden with CSS would keep stealing the hotkey
// from the pane the operator is actually looking at.
//
// The shell also owns the movement ledger, because both panes write to it — each
// pane calls onDone() after a successful write instead of holding its own copy.

import { useState, useEffect, useRef } from 'react';
import { db } from '../../lib/db';
import { getMovements } from '../../lib/queries';
import type { InventoryMovementDoc } from '../../lib/types';
import { fmtDateTime, fmtKg, fmtUnits } from '../../lib/format';
import { Badge, EmptyState } from '../ui';
import IngressForm from './IngressForm';
import ReturnsPane from './ReturnsPane';
import { stitchDivider, movementRow } from './styles';

type Pane = 'nueva' | 'devoluciones';

const PANES: Array<{ id: Pane; label: string }> = [
  { id: 'nueva', label: 'Tela nueva' },
  { id: 'devoluciones', label: 'Devoluciones' },
];

// Strip the doc-id prefixes and join segments with spaces:
// "batch:negro:30:franela"            → "negro 30 franela"
// "product:batch:azul-rey:30:jersey:r1" → "azul-rey 30 jersey r1"
// Listed explicitly rather than "everything before the first colon": a product
// id carries TWO prefixes, and a generic rule would eat the colour instead.
const ID_PREFIX = /^(?:product:|batch:|sale:|movement:|expense:|payment:|client:)+/;

function humanizeRef(ref: string): string {
  return ref.replace(ID_PREFIX, '').replace(/:/g, ' ');
}

/**
 * What moved, by direction. Summing |quantityChanged| would report a 4 kg
 * exchange as "8 kg" — both legs counted, as if twice the fabric had moved.
 */
function movementAmount(m: InventoryMovementDoc): string {
  const fmt = m.lineItems[0]?.unitOfMeasure === 'Kg' ? fmtKg : fmtUnits;
  let received = 0;
  let issued = 0;
  for (const l of m.lineItems) {
    if (l.quantityChanged >= 0) received += l.quantityChanged;
    else issued -= l.quantityChanged;
  }
  if (received && issued) return `+${fmt(received)} / −${fmt(issued)}`;
  return fmt(received || issued);
}

/**
 * An exchange is an IN movement that also carries a negative leg (the
 * replacement going out). Read off the document rather than stored as a fourth
 * MovementType, so no existing movement needs migrating and the two can never
 * disagree.
 */
function isExchange(m: InventoryMovementDoc): boolean {
  return m.movementType === 'IN' && m.lineItems.some((l) => l.quantityChanged < 0);
}

function movementTypeLabel(m: InventoryMovementDoc): string {
  if (isExchange(m)) return 'Cambio';
  if (m.movementType === 'IN') return 'Ingreso';
  if (m.movementType === 'OUT') return 'Venta';
  return 'Ajuste';
}

function movementToneBadge(m: InventoryMovementDoc): 'ok' | 'neutral' | 'warn' {
  if (isExchange(m)) return 'warn';
  if (m.movementType === 'IN') return 'ok';
  if (m.movementType === 'ADJUST') return 'warn';
  return 'neutral';
}

export default function InventarioPage() {
  const [pane, setPane] = useState<Pane>('nueva');
  const [movements, setMovements] = useState<InventoryMovementDoc[]>([]);
  const tabsRef = useRef<HTMLDivElement>(null);

  function refreshMovements() {
    getMovements(db, { limit: 20, descending: true }).then(setMovements).catch(console.error);
  }

  useEffect(refreshMovements, []);

  // Arrow keys move between tabs (the ARIA tab pattern); the focused tab is the
  // selected one, so a keyboard user never lands on a pane they cannot see.
  function onTabsKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = PANES.findIndex((p) => p.id === pane);
    const next = PANES[(idx + (e.key === 'ArrowRight' ? 1 : PANES.length - 1)) % PANES.length];
    setPane(next.id);
    setTimeout(() => tabsRef.current?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus(), 0);
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <h1
        style={{
          fontFamily: 'var(--font-sans)', fontSize: 22, fontWeight: 800, fontStretch: '125%',
          textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)',
          margin: '0 0 16px',
        }}
      >
        Inventario
      </h1>

      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Modo de inventario"
        onKeyDown={onTabsKeyDown}
        style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--color-thread)' }}
      >
        {PANES.map((p) => {
          const active = p.id === pane;
          return (
            <button
              key={p.id}
              id={`tab-${p.id}`}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={`pane-${p.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setPane(p.id)}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                fontWeight: active ? 700 : 600,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: active ? 'var(--color-dye)' : 'var(--color-thread)',
                background: active ? 'rgba(181,23,92,0.08)' : 'transparent',
                border: 'none',
                borderBottom: active ? '3px solid var(--color-dye)' : '3px solid transparent',
                padding: '12px 18px',
                minHeight: 44,
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div id={`pane-${pane}`} role="tabpanel" aria-labelledby={`tab-${pane}`}>
        {pane === 'nueva'
          ? <IngressForm onDone={refreshMovements} />
          : <ReturnsPane onDone={refreshMovements} />}
      </div>

      <div aria-hidden="true" style={stitchDivider} />

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-thread)', marginBottom: 16 }}>
          Movimientos recientes
        </h2>

        {movements.length === 0 ? (
          <EmptyState title="Sin movimientos registrados aún" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {movements.map((m) => (
              <div key={m._id} className="movement-row" style={movementRow}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-thread)', whiteSpace: 'nowrap' }}>
                  {fmtDateTime(m.date)}
                </span>
                <Badge tone={movementToneBadge(m)}>{movementTypeLabel(m)}</Badge>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {humanizeRef(m.referenceId)}
                </span>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--color-thread)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.reason}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-thread)', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {m.lineItems.length} {m.lineItems.length === 1 ? 'línea' : 'líneas'} ·{' '}
                  {movementAmount(m)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
