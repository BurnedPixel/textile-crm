// Shared UI kit — the app design system.
// All labels/text: SPANISH. All names/code: ENGLISH.
// No new deps — pure React + Tailwind v4 CSS custom properties.

import { useState, useRef, useEffect, useCallback, type ReactNode, type Ref, type InputHTMLAttributes, type SelectHTMLAttributes, type ButtonHTMLAttributes, type KeyboardEvent } from 'react';
import { fmtUsd, fmtBs, toBs } from '../lib/format';

// ─── SWATCH CHIP ────────────────────────────────────────────────────────────

// Spanish color vocabulary → real hues, so "Azul Rey" looks blue and "Negro" black.
// Ordered: specific names (vino, mostaza) before generic families (rojo, amarillo).
const COLOR_WORDS: Array<[RegExp, [number, number, number]]> = [
  [/negr/, [0, 0, 12]],
  [/blanc|crud/, [40, 15, 93]],
  [/gris|plom|plata/, [220, 4, 55]],
  [/beige|crema|hueso|arena|marfil/, [38, 35, 78]],
  [/vino|borgo|guind|tint/, [345, 62, 28]],
  [/marr|cafe|chocolat|camel|tabac/, [28, 45, 32]],
  [/coral|salm/, [10, 75, 62]],
  [/roj|carmes|escarlat/, [0, 72, 45]],
  [/naranj|mandarin|zanahori/, [25, 85, 52]],
  [/mostaz|ocre/, [45, 70, 45]],
  [/amarill|oro|dorad|limon/, [48, 82, 52]],
  [/oliv|militar/, [75, 35, 32]],
  [/esmerald|botell/, [155, 55, 26]],
  [/verde|ment|pistach/, [140, 45, 38]],
  [/turques|aguamarin|cian/, [183, 60, 42]],
  [/celest|ciel/, [205, 65, 65]],
  [/marin|naval/, [222, 55, 24]],
  [/azul|indig|anil/, [222, 62, 42]],
  [/morad|violet|lila|purpur|uva|berenjen/, [275, 45, 42]],
  [/fucsi|magent/, [325, 75, 48]],
  [/rosad|rosa/, [340, 55, 70]],
];

/** Deterministic HSL from a color name string. The identity element of the design. */
export function colorFor(name: string): string {
  const n = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const match = COLOR_WORDS.find(([re]) => re.test(n));
  if (match) {
    let [h, s, l] = match[1];
    if (/oscur|noche|profund/.test(n)) l = Math.max(8, l - 14);
    if (/clar|pastel|bebe|palid/.test(n)) l = Math.min(90, l + 16);
    if (/rey|electric|intens|vivo/.test(n)) s = Math.min(95, s + 18);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  // Unknown color word: djb2-style hash → stable arbitrary hue
  let hash = 5381;
  for (let i = 0; i < n.length; i++) {
    hash = ((hash << 5) + hash) ^ n.charCodeAt(i);
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 48%)`;
}

interface SwatchChipProps {
  color: string;
  size?: 'sm' | 'md';
}

export function SwatchChip({ color, size = 'md' }: SwatchChipProps) {
  const px = size === 'sm' ? 14 : 18;
  const hsl = colorFor(color);
  // Notched corner: top-right clipped
  const notch = size === 'sm' ? '0 3px 0 0' : '0 4px 0 0';
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: px,
          height: px,
          backgroundColor: hsl,
          border: '1px solid var(--color-ink)',
          clipPath: `polygon(0 0, calc(100% - ${notch.split(' ')[1]}) 0, 100% ${notch.split(' ')[1]}, 100% 100%, 0 100%)`,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: size === 'sm' ? '11px' : '12px',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--color-ink)',
        }}
      >
        {color}
      </span>
    </span>
  );
}

// ─── BUTTON ─────────────────────────────────────────────────────────────────

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  children: ReactNode;
}

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  letterSpacing: '0.02em',
  border: '1.5px solid transparent',
  borderRadius: '6px',
  cursor: 'pointer',
  transition: 'background 0.12s, color 0.12s, opacity 0.12s',
  minHeight: '44px',
  userSelect: 'none',
};

const btnVariant: Record<string, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-dye)',
    color: 'var(--color-cloth)',
    borderColor: 'var(--color-dye)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--color-ink)',
    borderColor: 'var(--color-thread)',
  },
  danger: {
    backgroundColor: 'transparent',
    color: 'var(--color-danger)',
    borderColor: 'var(--color-danger)',
  },
};

const btnSize: Record<string, React.CSSProperties> = {
  md: { padding: '0 16px', fontSize: '14px', minHeight: '44px' },
  lg: { padding: '0 24px', fontSize: '15px', minHeight: '52px' },
};

export function Button({ variant = 'primary', size = 'md', style, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled}
      style={{
        ...btnBase,
        ...btnVariant[variant],
        ...btnSize[size],
        ...(disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ─── INPUT ───────────────────────────────────────────────────────────────────

type InputProps = InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> };

const inputBase: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-sans)',
  fontSize: '14px',
  color: 'var(--color-ink)',
  backgroundColor: 'var(--color-cloth)',
  border: '1.5px solid var(--color-thread)',
  borderRadius: '6px',
  padding: '0 12px',
  minHeight: '44px',
  outline: 'none',
  transition: 'border-color 0.12s',
};

export function Input({ style, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      style={{ ...inputBase, ...style }}
      onFocus={(e) => {
        (e.target as HTMLInputElement).style.borderColor = 'var(--color-dye)';
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        (e.target as HTMLInputElement).style.borderColor = 'var(--color-thread)';
        rest.onBlur?.(e);
      }}
    />
  );
}

// ─── NUMBER INPUT ─────────────────────────────────────────────────────────────

type NumberInputProps = Omit<InputProps, 'type'>;

export function NumberInput({ style, ...rest }: NumberInputProps) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      style={{ fontFamily: 'var(--font-mono)', fontFeatureSettings: '"tnum" 1', ...style }}
      {...rest}
    />
  );
}

// ─── SELECT ──────────────────────────────────────────────────────────────────

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode; ref?: Ref<HTMLSelectElement> };

export function Select({ style, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      style={{
        ...inputBase,
        appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238A8371' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 12px center',
        paddingRight: '32px',
        cursor: 'pointer',
        ...style,
      }}
      onFocus={(e) => {
        (e.target as HTMLSelectElement).style.borderColor = 'var(--color-dye)';
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        (e.target as HTMLSelectElement).style.borderColor = 'var(--color-thread)';
        rest.onBlur?.(e);
      }}
    >
      {children}
    </select>
  );
}

// ─── FIELD ────────────────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: error ? 'var(--color-danger)' : 'var(--color-thread)',
        }}
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
          {hint}
        </span>
      )}
      {error && (
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-danger)', fontWeight: 500 }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ─── KBD ─────────────────────────────────────────────────────────────────────

interface KbdProps {
  children: ReactNode;
}

export function Kbd({ children }: KbdProps) {
  return (
    <kbd
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        fontWeight: 500,
        color: 'var(--color-thread)',
        backgroundColor: 'var(--color-cloth)',
        border: '1px solid var(--color-thread)',
        borderRadius: '3px',
        padding: '1px 5px',
        lineHeight: 1.4,
        display: 'inline-block',
        userSelect: 'none',
      }}
    >
      {children}
    </kbd>
  );
}

// ─── MONEY ────────────────────────────────────────────────────────────────────

interface MoneyProps {
  usd: number;
  /** When provided, shows a secondary Bs line. */
  rate?: number;
}

export function Money({ usd, rate }: MoneyProps) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '14px',
          fontWeight: 600,
          fontFeatureSettings: '"tnum" 1',
          color: 'var(--color-ink)',
        }}
      >
        {fmtUsd(usd)}
      </span>
      {rate !== undefined && (
        <span
          className="money-bs"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontFeatureSettings: '"tnum" 1',
            color: 'var(--color-thread)',
            lineHeight: 1.2,
          }}
        >
          {fmtBs(toBs(usd, rate))}
        </span>
      )}
    </span>
  );
}

// ─── BADGE ────────────────────────────────────────────────────────────────────

interface BadgeProps {
  tone?: 'ok' | 'warn' | 'danger' | 'neutral';
  children: ReactNode;
}

const badgeColors: Record<string, { bg: string; text: string }> = {
  ok:      { bg: 'rgba(62,107,58,0.12)',   text: 'var(--color-ok)' },
  warn:    { bg: 'rgba(185,119,24,0.12)',  text: 'var(--color-warn)' },
  danger:  { bg: 'rgba(163,46,46,0.12)',   text: 'var(--color-danger)' },
  neutral: { bg: 'rgba(138,131,113,0.12)', text: 'var(--color-thread)' },
};

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  const c = badgeColors[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'var(--font-sans)',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: '4px',
        backgroundColor: c.bg,
        color: c.text,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────

interface EmptyStateProps {
  title: string;
  action?: ReactNode;
}

export function EmptyState({ title, action }: EmptyStateProps) {
  return (
    <div
      className="empty-state"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        padding: '48px 32px',
        border: '1px dashed var(--color-thread)',
        borderRadius: '8px',
        textAlign: 'center',
        backgroundColor: 'var(--color-cloth)',
      }}
    >
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-thread)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <path d="M8 12h8M12 8v8"/>
      </svg>
      <p
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '14px',
          color: 'var(--color-thread)',
          margin: 0,
          fontWeight: 500,
        }}
      >
        {title}
      </p>
      {action && <div>{action}</div>}
    </div>
  );
}

// ─── COMBOBOX ─────────────────────────────────────────────────────────────────
// Free-entry combobox with design-unified suggestion panel.
// Typed text is always preserved (creates new batches when nothing matches).
// Visually matches the venta client picker panel and facet Listbox option rows.

/** Accent-insensitive, case-insensitive substring match — same logic as norm() in lib/types. */
export function normStr(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

type ComboboxInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onKeyDown'>;

export interface ComboboxProps extends ComboboxInputProps {
  value: string;
  onChange: (next: string) => void;
  options: string[];
  placeholder?: string;
  renderOption?: (v: string) => ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  ref?: Ref<HTMLInputElement>;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  renderOption,
  onKeyDown,
  ref,
  ...rest
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const filtered = options.filter((o) =>
    value === '' ? true : normStr(o).includes(normStr(value)),
  );

  // Reset highlight when filtered list changes.
  useEffect(() => { setActiveIdx(-1); }, [value]);

  // Auto-scroll highlighted row into view.
  useEffect(() => {
    if (activeIdx < 0 || !panelRef.current) return;
    const el = panelRef.current.querySelector(`[data-cbidx="${activeIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const closePanel = useCallback(() => setOpen(false), []);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === 'Enter') {
      if (open && activeIdx >= 0 && filtered[activeIdx] !== undefined) {
        e.preventDefault();
        onChange(filtered[activeIdx]);
        closePanel();
        // Fire parent onKeyDown AFTER apply (same keystroke advances cascade).
        onKeyDown?.(e);
        return;
      }
      // Panel closed or nothing highlighted — pass through to parent as-is.
      closePanel();
      onKeyDown?.(e);
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        closePanel();
        return;
      }
      // Panel already closed → pass through (parent clears the field).
      onKeyDown?.(e);
      return;
    }
    if (e.key === 'Tab') {
      closePanel();
      onKeyDown?.(e);
      return;
    }
    onKeyDown?.(e);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        {...rest}
        ref={ref}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        style={{ ...inputBase }}
        onFocus={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'var(--color-dye)';
          setOpen(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          (e.target as HTMLInputElement).style.borderColor = 'var(--color-thread)';
          // Defer close so onMouseDown on an option fires first.
          blurTimer.current = setTimeout(closePanel, 150);
          rest.onBlur?.(e);
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 2px)',
            left: 0,
            right: 0,
            zIndex: 20,
            backgroundColor: 'var(--color-cloth)',
            border: '1.5px solid var(--color-dye)',
            borderRadius: '6px',
            maxHeight: '220px',
            overflowY: 'auto',
          }}
        >
          {filtered.map((opt, i) => (
            <div
              key={opt}
              data-cbidx={i}
              onMouseDown={(e) => {
                e.preventDefault(); // beats blur
                if (blurTimer.current) clearTimeout(blurTimer.current);
                onChange(opt);
                closePanel();
              }}
              onMouseEnter={() => setActiveIdx(i)}
              style={{
                padding: '9px 14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                color: 'var(--color-ink)',
                backgroundColor: i === activeIdx ? 'rgba(181,23,92,0.08)' : 'transparent',
                borderLeft: i === activeIdx ? '3px solid var(--color-dye)' : '3px solid transparent',
                transition: 'background 0.08s',
              }}
            >
              {renderOption ? renderOption(opt) : opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
