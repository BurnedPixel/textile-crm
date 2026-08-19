// client:only="react" — subscribes to sync state and shows compact rail footer.
// Imports auth/db via contract; never SSR'd.
import { useEffect, useState, useCallback } from 'react';

type SyncState = import('../lib/db').SyncState;
type SessionUser = import('../lib/types').SessionUser;

// Deferred imports — db.ts and auth.ts are browser-only modules written in parallel.
// We import dynamically so Astro never tries to SSR them.
let _onSyncState: ((cb: (s: SyncState) => void) => () => void) | null = null;
let _startSync: (() => () => void) | null = null;
let _cachedUser: (() => SessionUser | null) | null = null;
let _getSession: (() => Promise<SessionUser | null>) | null = null;
// _logout = the session-expiry path: NEVER purges. _logoutExplicit = the Salir
// button: purges the device when it is marked as shared. Keep them apart.
let _logout: (() => Promise<void>) | null = null;
let _logoutExplicit: (() => Promise<void>) | null = null;
// Nómina: admin-only second database. nominaDb() is lazy, so importing the
// module creates nothing — only startNominaSync() does.
let _isAdmin: (() => boolean) | null = null;
let _startNominaSync: (() => void) | null = null;

async function loadModules() {
  const [dbMod, authMod, nominaMod] = await Promise.all([
    import('../lib/db'),
    import('../lib/auth'),
    import('../lib/nominadb'),
  ]);
  _onSyncState = dbMod.onSyncState;
  _startSync = dbMod.startSync;
  _cachedUser = authMod.cachedUser;
  _getSession = authMod.getSession;
  _logout = authMod.logout;
  _logoutExplicit = authMod.logoutExplicit;
  _isAdmin = authMod.isAdmin;
  _startNominaSync = nominaMod.startNominaSync;
}

// Rendered on the DARK rail (#151515): these are light, desaturated variants of
// the palette's status hues — the light-surface tokens would vanish here.
const stateConfig: Record<SyncState, { dot: string; label: string; color: string }> = {
  idle:         { dot: '#9DB89A', label: 'Sincronizado',    color: '#9DB89A' },
  active:       { dot: '#9FB0CC', label: 'Sincronizando…',  color: '#9FB0CC' },
  error:        { dot: '#D4AC6A', label: 'Sin conexión',    color: '#D4AC6A' },
  offline:      { dot: '#D4AC6A', label: 'Trabajo local',   color: '#D4AC6A' },
  unauthorized: { dot: '#CC8F8F', label: 'Sesión expirada', color: '#CC8F8F' },
  denied:       { dot: '#B49BC9', label: 'Cambios rechazados por el servidor', color: '#B49BC9' },
};

export default function SyncStatus() {
  // Start honest: 'offline' (trabajo local) until a sync event proves otherwise.
  const [syncState, setSyncState] = useState<SyncState>('offline');
  const [userName, setUserName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [logoutErr, setLogoutErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadModules().then(async () => {
      if (cancelled) return;
      setReady(true);
      const user = _cachedUser?.();
      setUserName(user?.name ?? null);
      if (!user) return;
      // Validate the session before syncing. getSession() returns null ONLY when
      // the server is reachable AND the session is gone (expired) — on a network
      // error it returns the cached user, so offline never forces a logout.
      const session = await _getSession?.();
      if (cancelled) return;
      if (session === null) { void _logout?.(); return; } // expired → /login
      // login() starts sync, but its page is torn down by the post-login redirect.
      // This island loads on every authenticated page, so it's the durable place
      // to (re)start sync. startSync() is idempotent — safe on every load.
      _startSync?.();
      // Same idempotent (re)start for nómina, but ONLY for an admin — a
      // vendedor's device must never create or replicate the payroll database.
      // getSession() just refreshed the cached roles this reads.
      if (_isAdmin?.()) _startNominaSync?.();
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !_onSyncState) return;
    const unsub = _onSyncState((s) => {
      setSyncState(s);
      // Session expired while the app was open (a live sync got a 401) → /login.
      if (s === 'unauthorized') void _logout?.();
    });
    return unsub;
  }, [ready]);

  const handleLogout = useCallback(async () => {
    setLogoutErr(null);
    try {
      await _logoutExplicit?.(); // purges only on a device marked as shared
      location.replace('/login');
    } catch (err) {
      // Shared-device purge aborted: nothing erased, session still open.
      setLogoutErr((err as Error).message);
    }
  }, []);

  const cfg = stateConfig[syncState];
  const isPulsing = syncState === 'active';

  const initial = userName
    ? userName.charAt(0).toUpperCase()
    : '?';

  return (
    <div className="sync-status">
      {/* Sync dot + label */}
      <div className="sync-dot-label" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
        <span
          aria-label={`Estado de sincronización: ${cfg.label}`}
          style={{
            display: 'block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: cfg.dot,
            animation: isPulsing ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            color: cfg.color,
            textAlign: 'center',
            lineHeight: 1.2,
            letterSpacing: '0.02em',
          }}
        >
          {cfg.label}
        </span>
      </div>

      {/* User initial circle */}
      {userName && (
        <div
          title={userName}
          aria-label={`Usuario: ${userName}`}
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            backgroundColor: 'color-mix(in srgb, var(--color-lavender) 18%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-lavender) 55%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: '12px',
            color: 'var(--color-lavender)',
            userSelect: 'none',
          }}
        >
          {initial}
        </div>
      )}

      {/* Logout */}
      <button
        onClick={handleLogout}
        title="Cerrar sesión"
        aria-label="Cerrar sesión"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          minHeight: '44px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-thread)',
          borderRadius: '4px',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', marginLeft: '2px' }}>
          Salir
        </span>
      </button>

      {/* Shared-device purge aborted — the rail is too narrow for the message. */}
      {logoutErr && (
        <div
          role="alert"
          onClick={() => setLogoutErr(null)}
          style={{
            position: 'fixed',
            left: '12px',
            bottom: '12px',
            zIndex: 100,
            maxWidth: '320px',
            padding: '10px 12px',
            borderRadius: '8px',
            background: 'var(--color-cloth)',
            border: '1px solid var(--color-danger)',
            color: 'var(--color-danger)',
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            lineHeight: 1.35,
            cursor: 'pointer',
          }}
        >
          {logoutErr}
        </div>
      )}

      {/* Pulse keyframe — injected inline to avoid a separate CSS dependency */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
