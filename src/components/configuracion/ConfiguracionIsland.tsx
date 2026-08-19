// Configuración page island — BCV rate card, session card, sync card.
// UI: SPANISH. Code/fields: ENGLISH.

import { useState, useEffect } from 'react';
import { db } from '../../lib/db';
import { getConfig, saveDailyRate, getFiscalConfig, saveFiscalConfig } from '../../lib/queries';
import { onSyncState } from '../../lib/db';
import { cachedUser, logout, logoutExplicit, isSharedDevice, setSharedDevice, isAdmin, ADMIN_ROLE, OPERADOR_ROLE } from '../../lib/auth';
import { useLiveQuery } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/format';
import { Button, Input, NumberInput, Field, Badge, Select } from '../ui';
import { BRAND } from '../../../brand.mjs';
import { USERS_CONFIG_ID, validateUsername, type UsersRosterDoc, type RosterUser, type UserRole } from '../../lib/types';

// ONE definition, in db.ts — a local copy is how this union already drifted once.
type SyncState = import('../../lib/db').SyncState;

const SYNC_LABEL: Record<SyncState, string> = {
  idle:         'Sincronizado',
  active:       'Sincronizando…',
  error:        'Error de sincronización',
  offline:      'Sin conexión — trabajando local',
  unauthorized: 'Sesión expirada — inicia sesión de nuevo',
  denied:       'Cambios rechazados por el servidor',
};

const SYNC_TONE: Record<SyncState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  idle:         'ok',
  active:       'neutral',
  error:        'danger',
  offline:      'warn',
  unauthorized: 'danger',
  denied:       'danger',
};

/** Same-origin cookie-authenticated fetch against CouchDB's /db/_users. */
function usersFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
  });
}

function usersErrorMessage(status: number): string {
  if (status === 401 || status === 403) return 'La sesión no tiene permisos de administrador.';
  return 'No se pudo completar la operación.';
}

interface CouchUserDoc {
  _id: string;
  _rev: string;
  name: string;
  roles: string[];
  type: string;
}

/** GETs one `_users` doc by account name — allowed for the db-admin role,
 * unlike `_all_docs`/`_changes` (see USERS_CONFIG_ID doc comment). */
async function getUserDoc(name: string): Promise<CouchUserDoc> {
  const res = await usersFetch(`/db/_users/org.couchdb.user:${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(usersErrorMessage(res.status));
  return res.json();
}

function couchRolesFor(role: 'operador' | 'admin'): string[] {
  return [BRAND.dbName, role === 'admin' ? ADMIN_ROLE : OPERADOR_ROLE];
}

function rosterRoleLabel(role: UserRole): string {
  switch (role) {
    case 'admin': return 'Administrador';
    case 'operador': return 'Operador';
    case 'rates': return 'Tasas';
    case 'none': return 'Sin rol';
  }
}

/** Missing doc is not an error — no roster written yet. */
async function getRoster(database: PouchDB.Database): Promise<UsersRosterDoc | null> {
  try {
    return (await database.get(USERS_CONFIG_ID)) as UsersRosterDoc;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status === 404) return null;
    throw err;
  }
}

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
    const rate = Number(rateInput);
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

  // ---- Fiscal identity card ----
  // Its OWN document, never config:system: saveDailyRate rebuilds that one from
  // an explicit field list, so a header parked there is deleted by the next
  // 07:00 rate write and nobody finds out until the next time someone prints.
  const { data: fiscal } = useLiveQuery((d) => getFiscalConfig(d));
  const [fiscalForm, setFiscalForm] = useState<{ businessName: string; taxId: string; address: string } | null>(null);
  const [fiscalSaving, setFiscalSaving] = useState(false);
  const [fiscalErr, setFiscalErr] = useState<string | null>(null);
  const [fiscalOk, setFiscalOk] = useState(false);

  // Seeded from the stored document once it arrives, then owned by the form —
  // re-seeding on every live-query refresh would overwrite what is being typed.
  const fiscalValues = fiscalForm ?? {
    businessName: fiscal?.businessName ?? '',
    taxId: fiscal?.taxId ?? '',
    address: fiscal?.address ?? '',
  };
  const setFiscalField = (patch: Partial<typeof fiscalValues>) =>
    setFiscalForm({ ...fiscalValues, ...patch });

  async function handleSaveFiscal(e: React.FormEvent) {
    e.preventDefault();
    setFiscalErr(null);
    setFiscalSaving(true);
    try {
      await saveFiscalConfig(db, fiscalValues);
      setFiscalForm(null); // fall back to the stored document
      setFiscalOk(true);
      setTimeout(() => setFiscalOk(false), 2500);
    } catch (err) {
      setFiscalErr((err as Error).message);
    } finally {
      setFiscalSaving(false);
    }
  }

  // ---- Usuarios card (admin-only) ----
  // The LIST comes from the config:users roster doc — see USERS_CONFIG_ID's
  // comment for why: works offline, no server-admin-only _all_docs call.
  // `_users` itself stays the source of truth for auth; every mutation below
  // writes there FIRST and only syncs the roster after it succeeds.
  const admin = isAdmin();
  const { data: roster } = useLiveQuery((d) => getRoster(d));
  const rosterUsers: RosterUser[] = roster?.users ?? [];

  /** Rebuilds config:users from an explicit field list (builder rule) with a
   * fresh lastUpdate — newest wins on conflict, like every other config doc. */
  async function upsertRoster(nextUsers: RosterUser[]) {
    const doc: UsersRosterDoc = {
      _id: USERS_CONFIG_ID,
      ...(roster?._rev ? { _rev: roster._rev } : {}),
      type: 'config',
      users: nextUsers,
      lastUpdate: new Date().toISOString(),
    };
    await db.put(doc);
  }

  // Create form
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'operador' | 'admin'>('operador');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    const nameErr = validateUsername(newName);
    if (nameErr) { setCreateErr(nameErr); return; }
    if (newPassword.length < 8) { setCreateErr('La contraseña debe tener al menos 8 caracteres.'); return; }
    setCreating(true);
    const name = newName.trim();
    try {
      const id = `org.couchdb.user:${name}`;
      const res = await usersFetch(`/db/_users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, password: newPassword, roles: couchRolesFor(newRole), type: 'user' }),
      });
      if (!res.ok) throw new Error(res.status === 409 ? 'Ese usuario ya existe.' : usersErrorMessage(res.status));
      await upsertRoster([...rosterUsers.filter((u) => u.name !== name), { name, role: newRole }]);
      setNewName('');
      setNewPassword('');
      setNewRole('operador');
    } catch (err) {
      setCreateErr((err as Error).message);
    } finally {
      setCreating(false);
      setNewPassword('');
    }
  }

  // Deactivate / reactivate — inline confirm, never window.confirm
  const [confirmTarget, setConfirmTarget] = useState<{ name: string; role: UserRole } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function applyRoles(name: string, role: UserRole) {
    setActionErr(null);
    setActingOn(name);
    try {
      const doc = await getUserDoc(name);
      const roles = role === 'none' ? [] : couchRolesFor(role as 'operador' | 'admin');
      const res = await usersFetch(`/db/_users/${doc._id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...doc, roles }),
      });
      if (!res.ok) throw new Error(usersErrorMessage(res.status));
      await upsertRoster(rosterUsers.map((u) => (u.name === name ? { name, role } : u)));
      setConfirmTarget(null);
    } catch (err) {
      setActionErr((err as Error).message);
    } finally {
      setActingOn(null);
    }
  }

  // Reset password — inline field per row. Password resets never touch the
  // roster (the roster only tracks name + role).
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetErr, setResetErr] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  async function handleResetPassword(name: string) {
    setResetErr(null);
    if (resetValue.length < 8) { setResetErr('La contraseña debe tener al menos 8 caracteres.'); return; }
    setResetting(true);
    try {
      const doc = await getUserDoc(name);
      const res = await usersFetch(`/db/_users/${doc._id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...doc, password: resetValue }),
      });
      if (!res.ok) throw new Error(usersErrorMessage(res.status));
      setResetTarget(null);
    } catch (err) {
      setResetErr((err as Error).message);
    } finally {
      setResetValue('');
      setResetting(false);
    }
  }

  // ---- Session card ----
  const user = cachedUser();
  // Device-scoped setting (localStorage), never synced — survives the purge.
  const [shared, setShared] = useState(isSharedDevice);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutErr, setLogoutErr] = useState<string | null>(null);

  async function handleLogout() {
    setLogoutErr(null);
    setLoggingOut(true);
    try {
      await logoutExplicit(); // redirects on success
    } catch (err) {
      setLogoutErr((err as Error).message);
      setLoggingOut(false); // still logged in, on purpose
    }
  }

  // ---- Change own password (everyone) ----
  const [pwOpen, setPwOpen] = useState(false);
  const [pwValue, setPwValue] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr(null);
    if (pwValue.length < 8) {
      setPwErr('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    setPwSaving(true);
    try {
      const own = await usersFetch(`/db/_users/org.couchdb.user:${encodeURIComponent(user!.name)}`);
      const doc = await own.json();
      const put = await usersFetch(`/db/_users/${doc._id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...doc, password: pwValue }),
      });
      if (!put.ok) throw new Error(usersErrorMessage(put.status));
      setPwValue(''); // never keep the password around, success or not
      setPwDone(true);
      setPwOpen(false);
    } catch (err) {
      setPwErr((err as Error).message);
    } finally {
      setPwValue('');
      setPwSaving(false);
    }
  }

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

      {/* ── Card 1: BCV rate (admin-only, cosmetic — server enforces) ── */}
      {admin && (
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

        {/* noValidate — our Spanish messages, not the browser's localized bubbles. */}
        <form onSubmit={handleSaveRate} noValidate className="rate-form" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
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
      )}

      {/* ── Card 2: fiscal identity (nota de entrega header) — admin-only, cosmetic ── */}
      {admin && (
      <div className="card" style={card}>
        <h2 style={cardTitle}>Datos fiscales</h2>
        <form onSubmit={handleSaveFiscal} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Field label="Razón social">
            <Input
              value={fiscalValues.businessName}
              placeholder="ML Textiles, C.A."
              onChange={(e) => setFiscalField({ businessName: e.target.value })}
            />
          </Field>
          <Field label="RIF">
            <Input
              value={fiscalValues.taxId}
              placeholder="J-30665094-6"
              onChange={(e) => setFiscalField({ taxId: e.target.value })}
            />
          </Field>
          <Field label="Dirección fiscal">
            <Input
              value={fiscalValues.address}
              placeholder="Calle Manduca, edf. 90, La Candelaria, Caracas"
              onChange={(e) => setFiscalField({ address: e.target.value })}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Button type="submit" disabled={fiscalSaving}>
              {fiscalSaving ? 'Guardando…' : 'Guardar datos fiscales'}
            </Button>
            {fiscalOk && <Badge tone="ok">Guardado</Badge>}
          </div>
          {fiscalErr && (
            <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }}>
              {fiscalErr}
            </div>
          )}
        </form>
        <p className="config-note" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', marginTop: '1rem', marginBottom: 0 }}>
          Encabezan la nota de entrega. La factura fiscal la sigue emitiendo la máquina homologada por el SENIAT.
        </p>
      </div>
      )}

      {/* ── Card: Usuarios (admin-only) ── */}
      {admin && (
      <div className="card" style={card}>
        <h2 style={cardTitle}>Usuarios</h2>

        {roster === undefined && (
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)' }}>Cargando…</p>
        )}

        {roster !== undefined && (
          <div style={{ marginBottom: '1.25rem' }}>
            {rosterUsers.map((u) => (
              <div key={u.name} style={{ padding: '10px 0', borderBottom: '1px dashed var(--color-thread)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <div>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 600, color: 'var(--color-ink)' }}>{u.name}</span>
                    {' '}
                    <Badge tone={u.role === 'none' ? 'warn' : 'neutral'}>{rosterRoleLabel(u.role)}</Badge>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {u.role !== 'none' ? (
                      <>
                        <Button onClick={() => { setResetTarget(u.name); setResetErr(null); }} disabled={actingOn === u.name}>
                          Restablecer contraseña
                        </Button>
                        <Button variant="danger" onClick={() => setConfirmTarget({ name: u.name, role: 'none' })} disabled={actingOn === u.name}>
                          Desactivar
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={() => setConfirmTarget({ name: u.name, role: 'operador' })} disabled={actingOn === u.name}>
                          Reactivar (Operador)
                        </Button>
                        <Button onClick={() => setConfirmTarget({ name: u.name, role: 'admin' })} disabled={actingOn === u.name}>
                          Reactivar (Admin)
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {confirmTarget?.name === u.name && (
                  <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)' }}>
                      {confirmTarget.role === 'none' ? `¿Desactivar a ${u.name}?` : `¿Reactivar a ${u.name}?`}
                    </span>
                    <Button variant="primary" onClick={() => void applyRoles(confirmTarget.name, confirmTarget.role)} disabled={actingOn === u.name}>
                      Sí
                    </Button>
                    <Button onClick={() => setConfirmTarget(null)}>No</Button>
                  </div>
                )}

                {resetTarget === u.name && (
                  <form
                    onSubmit={(e) => { e.preventDefault(); void handleResetPassword(u.name); }}
                    noValidate
                    style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'flex-end' }}
                  >
                    <div style={{ flex: 1 }}>
                      <Field label="Nueva contraseña">
                        <Input type="password" value={resetValue} onChange={(e) => setResetValue(e.target.value)} />
                      </Field>
                    </div>
                    <Button type="submit" variant="primary" disabled={resetting}>
                      {resetting ? 'Guardando…' : 'Guardar'}
                    </Button>
                    <Button type="button" onClick={() => { setResetTarget(null); setResetValue(''); }}>Cancelar</Button>
                  </form>
                )}
                {resetTarget === u.name && resetErr && (
                  <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', marginTop: '6px' }}>
                    {resetErr}
                  </div>
                )}
              </div>
            ))}
            {rosterUsers.length === 0 && (
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-thread)' }}>Sin usuarios registrados aquí todavía.</p>
            )}
            {actionErr && (
              <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', marginTop: '10px' }}>
                {actionErr}
              </div>
            )}
          </div>
        )}

        {roster !== undefined && (
          <form onSubmit={handleCreateUser} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '0.5rem', borderTop: '1px dashed var(--color-thread)' }}>
            <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 700, color: 'var(--color-ink)', margin: '0.75rem 0 0' }}>
              Nuevo usuario
            </h3>
            <Field label="Usuario">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="jperez" />
            </Field>
            <Field label="Contraseña">
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
            <Field label="Rol">
              <Select value={newRole} onChange={(e) => setNewRole(e.target.value as 'operador' | 'admin')}>
                <option value="operador">Operador</option>
                <option value="admin">Administrador</option>
              </Select>
            </Field>
            <div>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creando…' : 'Crear usuario'}
              </Button>
            </div>
            {createErr && (
              <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)' }}>
                {createErr}
              </div>
            )}
          </form>
        )}
      </div>
      )}

      {/* ── Card 3: Session ── */}
      <div className="card" style={card}>
        <h2 style={cardTitle}>Sesión</h2>

        {user ? (
          <>
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
              <Button variant="danger" onClick={() => void handleLogout()} disabled={loggingOut}>
                {loggingOut ? 'Cerrando…' : 'Cerrar sesión'}
              </Button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ink)', marginTop: '1rem' }}>
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => { setSharedDevice(e.target.checked); setShared(e.target.checked); }}
              />
              Este equipo es compartido
            </label>
            <p className="config-note" style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--color-thread)', margin: '6px 0 0' }}>
              Al cerrar sesión se borran los datos locales de este equipo. Primero se envían al
              servidor los cambios pendientes; si no se pueden enviar, no se borra nada. Al volver
              a entrar hará falta conexión para descargar los datos de nuevo.
            </p>

            {logoutErr && (
              <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', marginTop: '10px' }}>
                {logoutErr}
              </div>
            )}

            {pwDone ? (
              <div style={{ marginTop: '1rem' }}>
                <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-ok)', margin: '0 0 8px' }}>
                  Contraseña cambiada — inicie sesión de nuevo.
                </p>
                <Button onClick={() => void logout()}>Ir a iniciar sesión</Button>
              </div>
            ) : pwOpen ? (
              <form
                onSubmit={handleChangePassword}
                noValidate
                style={{ marginTop: '1rem', display: 'flex', gap: '8px', alignItems: 'flex-end' }}
              >
                <div style={{ flex: 1 }}>
                  <Field label="Nueva contraseña">
                    <Input type="password" value={pwValue} onChange={(e) => setPwValue(e.target.value)} />
                  </Field>
                </div>
                <Button type="submit" variant="primary" disabled={pwSaving}>
                  {pwSaving ? 'Guardando…' : 'Guardar'}
                </Button>
                <Button type="button" onClick={() => { setPwOpen(false); setPwValue(''); setPwErr(null); }}>
                  Cancelar
                </Button>
              </form>
            ) : (
              <Button variant="ghost" style={{ marginTop: '1rem' }} onClick={() => setPwOpen(true)}>
                Cambiar mi contraseña
              </Button>
            )}
            {pwErr && (
              <div role="alert" style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--color-danger)', marginTop: '10px' }}>
                {pwErr}
              </div>
            )}
          </>
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
