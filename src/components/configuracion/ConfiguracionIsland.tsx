// Configuración page island — BCV rate card, session card, sync card.
// UI: SPANISH. Code/fields: ENGLISH.

import { useState, useEffect } from 'react';
import { db } from '../../lib/db';
import { getConfig, saveDailyRate } from '../../lib/queries';
import { onSyncState } from '../../lib/db';
import { cachedUser, logout } from '../../lib/auth';
import { useLiveQuery } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/format';
import { Button, NumberInput, Field, Badge } from '../ui';

type SyncState = 'idle' | 'active' | 'error' | 'offline' | 'unauthorized';

const SYNC_LABEL: Record<SyncState, string> = {
  idle:         'Sincronizado',
  active:       'Sincronizando…',
  error:        'Error de sincronización',
  offline:      'Sin conexión — trabajando local',
  unauthorized: 'Sesión expirada — inicia sesión de nuevo',
};

const SYNC_TONE: Record<SyncState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  idle:         'ok',
  active:       'neutral',
  error:        'danger',
  offline:      'warn',
  unauthorized: 'danger',
};

export default function ConfiguracionIsland() {
  // ---- BCV rate card ----
  const [rateInput,  setRateInput]  = useState('');
  const [saving,     setSaving]     = useState(false);
  const [saveError,  setSaveError]  = useState<string | null>(null);
  const [saveOk,     setSaveOk]     = useState(false);

  const { data: config } = useLiveQuery((db) => getConfig(db));

  // Age-based, not same-calendar-day (see Dashboard): UTC-day equality
  // false-alarmed every Caracas evening and all weekend.
  const rateIsStale = config
    ? Math.floor((Date.now() - new Date(config.lastUpdate).getTime()) / 86_400_000) >= 3
    : false;

  async function handleSaveRate(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    const rate = parseFloat(rateInput);
    if (!(rate > 0)) {
      setSaveError('La tasa debe ser mayor que cero.');
      return;
    }
    setSaving(true);
    try {
      await saveDailyRate(db, rate);
      setRateInput('');
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2500);
    } catch (err) {
      setSaveError((err as Error).message ?? 'Error al guardar la tasa.');
    } finally {
      setSaving(false);
    }
  }

  // ---- Session card ----
  const user = cachedUser();

  // ---- Sync card ----
  const [syncState, setSyncState] = useState<SyncState>('idle');
  useEffect(() => {
    const off = onSyncState(setSyncState);
    return off;
  }, []);

  // ---- Card style helpers ----
  const card: React.CSSProperties = {
    background: 'var(--color-cloth)',
    border: '1px dashed var(--color-thread)',
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1.25rem',
  };

  const cardTitle: React.CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--color-thread)',
    margin: '0 0 1.25rem',
  };

  return (
    <div style={{ maxWidth: '560px' }}>
      {/* Page header */}
      <div style={{ marginBottom: '1.75rem' }}>
        <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: '22px', fontWeight: 800, fontStretch: '125%', textTransform: 'uppercase', letterSpacing: '-0.02em', color: 'var(--color-ink)', margin: 0 }}>
          Configuración
        </h1>
      </div>

      {/* ── Card 1: BCV rate ── */}
      <div className="card" style={card}>
        <h2 style={cardTitle}>Tasa BCV del día</h2>

        {config ? (
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '32px', fontWeight: 700, fontFeatureSettings: '"tnum" 1', color: 'var(--color-ink)', letterSpacing: '-0.5px' }}>
                {config.currentDailyRateBCV.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', fontWeight: 500 }}>
                Bs / USD
              </span>
              {rateIsStale && (
                <Badge tone="warn">Tasa desactualizada</Badge>
              )}
            </div>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)' }}>
              Actualizada: {fmtDateTime(config.lastUpdate)}
            </span>
          </div>
        ) : (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', marginBottom: '1.25rem' }}>
            No hay tasa configurada. Ingrese la tasa del día.
          </p>
        )}

        <form onSubmit={handleSaveRate} className="rate-form" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Field label="Nueva tasa (Bs/USD)">
              <NumberInput
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                placeholder="Ej: 92.50"
                min="0.01"
                step="0.01"
                required
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={saving} style={{ flexShrink: 0 }}>
            {saving ? 'Guardando…' : 'Actualizar tasa'}
          </Button>
        </form>

        {saveError && (
          <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', marginTop: '10px' }}>
            {saveError}
          </div>
        )}
        {saveOk && (
          <div role="status" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ok)', marginTop: '10px' }}>
            Tasa actualizada correctamente.
          </div>
        )}

        <p className="config-note" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', marginTop: '1rem', marginBottom: 0 }}>
          La tasa se fija en cada venta y gasto al crearlos; los registros históricos nunca cambian.
        </p>
      </div>

      {/* ── Card 2: Session ── */}
      <div className="card" style={card}>
        <h2 style={cardTitle}>Sesión</h2>

        {user ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: '15px', fontWeight: 600, color: 'var(--color-ink)', margin: '0 0 4px' }}>
                {user.name}
              </p>
              {user.roles.length > 0 && (
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--color-thread)', margin: 0 }}>
                  {user.roles.join(', ')}
                </p>
              )}
            </div>
            <Button variant="danger" onClick={() => void logout()}>
              Cerrar sesión
            </Button>
          </div>
        ) : (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)', margin: 0 }}>
            No hay sesión activa.
          </p>
        )}
      </div>

      {/* ── Card 3: Sync ── */}
      <div className="card" style={card}>
        <h2 style={cardTitle}>Sincronización</h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <Badge tone={SYNC_TONE[syncState]}>
            {SYNC_LABEL[syncState]}
          </Badge>
        </div>

        <p className="config-note" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', margin: 0 }}>
          Los datos se guardan en este equipo y se sincronizan automáticamente cuando hay conexión.
        </p>
      </div>
    </div>
  );
}
