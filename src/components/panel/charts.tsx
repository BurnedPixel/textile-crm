// Panel charts — hand-rolled SVG/HTML, no chart library (offline-first, no deps).
// Mark specs: 2px lines, hairline solid gridlines, ≤16px bars with 4px rounded
// data-ends, 2px surface rings on markers, thread-colored text (marks carry the
// series color, text never does). Tooltips enhance, never gate — every chart has
// a table twin (<details>) and the crosshair works from the keyboard too.

import { useRef, useState, useEffect, type ReactNode } from 'react';
import type { DayPoint, RankedRow } from '../../lib/panel-charts';
import { fmtUsd } from '../../lib/format';

const VIOLET = 'var(--color-chart-violet)';
const BRASS = 'var(--color-chart-brass)';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => setW(es[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Smallest "nice" ceiling (1/2/2.5/5 × 10^k) at or above v. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const k = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * k >= v) return m * k;
  return 10 * k;
}

const fmtAxis = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n));

const fmtDay = (iso: string): string =>
  new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));

// ─── CHART CARD ──────────────────────────────────────────────────────────────

export function ChartCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
        <h2 className="micro-label" style={{ margin: 0 }}>• {title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

// ─── LINE CHART: facturado vs cobrado ────────────────────────────────────────

const SERIES = [
  { key: 'facturadoUsd' as const, label: 'Facturado', color: VIOLET },
  { key: 'cobradoUsd' as const, label: 'Cobrado', color: BRASS },
];

export function SalesLegend() {
  return (
    <span style={{ display: 'inline-flex', gap: '14px', alignItems: 'center' }}>
      {SERIES.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--color-thread)' }}>
          <span aria-hidden="true" style={{ width: '14px', height: '2px', background: s.color, display: 'inline-block' }} />
          {s.label}
        </span>
      ))}
    </span>
  );
}

export function SalesLineChart({ series }: { series: DayPoint[] }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const H = 190;
  const M = { top: 10, right: 14, bottom: 24, left: 42 };
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = H - M.top - M.bottom;
  const n = series.length;
  const max = niceCeil(Math.max(1, ...series.map((p) => Math.max(p.facturadoUsd, p.cobradoUsd))));
  const x = (i: number) => M.left + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2);
  const y = (v: number) => M.top + plotH - (Math.max(0, v) / max) * plotH;
  const path = (key: (typeof SERIES)[number]['key']) =>
    series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');

  const nearest = (clientX: number, rect: DOMRect): number => {
    const px = clientX - rect.left - M.left;
    return Math.max(0, Math.min(n - 1, Math.round((px / Math.max(1, plotW)) * (n - 1))));
  };

  const ticks = [0, max / 2, max];
  const xLabelEvery = 7;
  const hovered = hover !== null ? series[hover] : null;

  return (
    <div ref={boxRef} style={{ position: 'relative', minWidth: 0 }}>
      {width > 0 && (
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={n > 0 ? `Facturado y cobrado, del ${fmtDay(series[0].date)} al ${fmtDay(series[n - 1].date)}` : 'Facturado y cobrado'}
          tabIndex={0}
          style={{ display: 'block', outlineOffset: '4px' }}
          onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? n - 1) - 1)); }
            if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(n - 1, (h ?? n - 1) + 1)); }
            if (e.key === 'Escape') setHover(null);
          }}
        >
          {/* Gridlines — solid hairlines, one step off the surface */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--color-bone)" strokeWidth={1} />
              <text x={M.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-thread)" fontFamily="var(--font-mono)">
                {fmtAxis(t)}
              </text>
            </g>
          ))}
          {/* X labels — sparse; a periodic label within 3 steps of the last
              would collide with it, so the last one wins */}
          {series.map((p, i) =>
            (i % xLabelEvery === 0 && i < n - 3) || i === n - 1 ? (
              <text key={p.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--color-thread)" fontFamily="var(--font-sans)">
                {fmtDay(p.date)}
              </text>
            ) : null,
          )}
          {/* Crosshair */}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + plotH} stroke="var(--color-thread)" strokeWidth={1} />
          )}
          {/* Series lines */}
          {SERIES.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* End + hover markers, 2px surface ring */}
          {SERIES.map((s) => {
            const marks = hover !== null ? [hover] : [n - 1];
            return marks.map((i) => (
              <circle key={`${s.key}${i}`} cx={x(i)} cy={y(series[i][s.key])} r={4} fill={s.color} stroke="var(--color-cloth)" strokeWidth={2} />
            ));
          })}
        </svg>
      )}

      {/* Tooltip — values lead, line keys follow */}
      {hovered && width > 0 && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 0,
            left: Math.min(Math.max(0, x(hover!) + 10), Math.max(0, width - 150)),
            background: 'var(--color-cloth)',
            border: '1px solid var(--color-bone)',
            borderRadius: '8px',
            padding: '8px 10px',
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            zIndex: 5,
          }}
        >
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', color: 'var(--color-thread)' }}>{fmtDay(hovered.date)}</span>
          {SERIES.map((s) => (
            <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span aria-hidden="true" style={{ width: '10px', height: '2px', background: s.color }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 600, fontFeatureSettings: '"tnum" 1', color: 'var(--color-ink)' }}>
                {fmtUsd(hovered[s.key])}
              </span>
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', color: 'var(--color-thread)' }}>{s.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* Table twin — the values without hovering */}
      <details style={{ marginTop: '8px' }}>
        <summary className="micro-label" style={{ cursor: 'pointer', fontSize: '11px' }}>Ver datos</summary>
        <div style={{ maxHeight: '180px', overflowY: 'auto', marginTop: '6px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: '11px', fontFeatureSettings: '"tnum" 1' }}>
            <thead>
              <tr>
                {['Día', 'Facturado', 'Cobrado'].map((h) => (
                  <th key={h} style={{ textAlign: h === 'Día' ? 'left' : 'right', padding: '3px 6px', color: 'var(--color-thread)', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.date}>
                  <td style={{ padding: '2px 6px', color: 'var(--color-thread)' }}>{fmtDay(p.date)}</td>
                  <td style={{ padding: '2px 6px', textAlign: 'right', color: 'var(--color-ink)' }}>{fmtUsd(p.facturadoUsd)}</td>
                  <td style={{ padding: '2px 6px', textAlign: 'right', color: 'var(--color-ink)' }}>{fmtUsd(p.cobradoUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// ─── RANKED BAR LIST (single hue, direct-labeled) ────────────────────────────

export function BarList({ rows, color, fmt }: { rows: RankedRow[]; color: string; fmt: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      {rows.map((r) => (
        <div
          key={r.label}
          title={`${r.label}: ${fmt(r.value)}`}
          style={{ display: 'grid', gridTemplateColumns: 'minmax(64px, 110px) 1fr auto', alignItems: 'center', gap: '8px', minWidth: 0 }}
        >
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.label}
          </span>
          <span aria-hidden="true" style={{ minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                height: '12px',
                width: `${Math.max(1, (r.value / max) * 100)}%`,
                background: color,
                borderRadius: '0 4px 4px 0',
              }}
            />
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontFeatureSettings: '"tnum" 1', color: 'var(--color-ink)', whiteSpace: 'nowrap' }}>
            {fmt(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export const CHART_VIOLET = VIOLET;
export const CHART_BRASS = BRASS;
