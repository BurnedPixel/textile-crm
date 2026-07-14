// client:only="react" — subscribes to sync state and shows compact rail footer.
// Imports auth/db via contract; never SSR'd.
import { useEffect, useState, useCallback } from 'react';

type SyncState = 'idle' | 'active' | 'error' | 'offline';

// Deferred imports — db.ts and auth.ts are browser-only modules written in parallel.
// We import dynamically so Astro never tries to SSR them.
let _onSyncState: ((cb: (s: SyncState) => void) => () => void) | null = null;
let _startSync: (() => () => void) | null = null;
let _cachedUser: (() => import('../lib/types').SessionUser | null) | null = null;
let _logout: (() => Promise<void>) | null = null;

async function loadModules() {
  const [dbMod, authMod] = await Promise.all([
    import('../lib/db'),
    import('../lib/auth'),
  ]);
  _onSyncState = dbMod.onSyncState;
  _startSync = dbMod.startSync;
  _cachedUser = authMod.cachedUser;
  _logout = authMod.logout;
}

const stateConfig: Record<SyncState, { dot: string; label: string; color: string }> = {
  idle:    { dot: '#3E6B3A', label: 'Sincronizado',    color: '#3E6B3A' },
  active:  { dot: '#3A4A6B', label: 'Sincronizando…',  color: '#3A4A6B' },
  error:   { dot: '#B97718', label: 'Sin conexión',    color: '#B97718' },
  offline: { dot: '#B97718', label: 'Trabajo local',   color: '#B97718' },
};

export default function SyncStatus() {
  // Start honest: 'offline' (trabajo local) until a sync event proves otherwise.
  const [syncState, setSyncState] = useState<SyncState>('offline');
  const [userName, setUserName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadModules().then(() => {
      setReady(true);
      const user = _cachedUser?.();
      setUserName(user?.name ?? null);
      // login() starts sync, but its page is torn down by the post-login redirect.
      // This island loads on every authenticated page, so it's the durable place
      // to (re)start sync. startSync() is idempotent — safe on every load.
      if (user) _startSync?.();
    });
  }, []);

  useEffect(() => {
    if (!ready || !_onSyncState) return;
    const unsub = _onSyncState(setSyncState);
    return unsub;
  }, [ready]);

  const handleLogout = useCallback(async () => {
    await _logout?.();
    location.replace('/login');
  }, []);

  const cfg = stateConfig[syncState];
  const isPulsing = syncState === 'active';

  const initial = userName
    ? userName.charAt(0).toUpperCase()
    : '?';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 4px',
        width: '64px',
      }}
    >
      {/* Sync dot + label */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
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
            backgroundColor: 'rgba(181,23,92,0.20)',
            border: '1.5px solid rgba(181,23,92,0.50)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-sans)',
            fontWeight: 700,
            fontSize: '12px',
            color: '#B5175C',
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
