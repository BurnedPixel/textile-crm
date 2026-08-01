// Shared chrome for the /inventario panes. Lifted out of IngressForm when the
// page grew a second pane (Devoluciones) — two panes inventing two card styles
// is the same drift the Spanish labels already went through once.

export const sectionStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-cloth)',
  border: '1px dashed var(--color-thread)',
  borderRadius: 8,
  padding: '20px 24px',
  marginBottom: 16,
};

export const sectionTitle: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  color: 'var(--color-thread)',
  marginBottom: 16,
  marginTop: 0,
};

export const colLabel: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--color-thread)',
};

/** Per-row overrides that stay out of the tab order — mouse-only, de-emphasized. */
export const deemphasizedInput: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-thread)',
  minHeight: 36,
};

export const bannerExisting: React.CSSProperties = {
  marginTop: 14,
  padding: '10px 14px',
  borderRadius: 6,
  backgroundColor: 'rgba(62,107,58,0.08)',
  border: '1px solid rgba(62,107,58,0.25)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--color-ok)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const bannerNew: React.CSSProperties = {
  marginTop: 14,
  padding: '10px 14px',
  borderRadius: 6,
  backgroundColor: 'rgba(185,119,24,0.08)',
  border: '1px solid rgba(185,119,24,0.25)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--color-warn)',
};

export const alertOk: React.CSSProperties = {
  margin: '0 0 16px',
  padding: '12px 16px',
  borderRadius: 6,
  backgroundColor: 'rgba(62,107,58,0.08)',
  border: '1px solid rgba(62,107,58,0.25)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--color-ok)',
  fontWeight: 500,
};

export const alertErr: React.CSSProperties = {
  margin: '0 0 16px',
  padding: '12px 16px',
  borderRadius: 6,
  backgroundColor: 'rgba(163,46,46,0.08)',
  border: '1px solid rgba(163,46,46,0.25)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--color-danger)',
  fontWeight: 500,
};

export const stitchDivider: React.CSSProperties = {
  marginTop: 40,
  height: 2,
  backgroundImage:
    'repeating-linear-gradient(to right, var(--color-thread) 0px, var(--color-thread) 8px, transparent 8px, transparent 14px)',
  opacity: 0.4,
};

/** Grid shape lives in .movement-row (global.css) so phones can reflow it. */
export const movementRow: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 6,
  backgroundColor: 'var(--color-cloth)',
  border: '1px dashed var(--color-thread)',
  marginBottom: 4,
};

/** The roll picker — same visual language as the /venta roll list. */
export const rollListBox: React.CSSProperties = {
  outline: 'none',
  border: '1.5px solid var(--color-thread)',
  borderRadius: 6,
  maxHeight: 220,
  overflowY: 'auto',
  // A wide row scrolls inside its own box rather than pushing the page sideways
  // — on a phone the search results are wider than the screen by design.
  overflowX: 'auto',
  backgroundColor: 'var(--color-cloth)',
};

export const rollRowStyle = (active: boolean): React.CSSProperties => ({
  padding: '9px 14px',
  minWidth: 'max-content',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  backgroundColor: active ? 'rgba(181,23,92,0.08)' : 'transparent',
  borderLeft: active ? '3px solid var(--color-dye)' : '3px solid transparent',
});
