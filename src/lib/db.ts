// Browser-only DB wiring. The ONLY module (with auth.ts) that touches browser
// APIs — every logic module takes a db handle so it stays node-testable. Do not
// import this from logic modules.

import PouchDB from 'pouchdb-browser';
import { registerValidation } from './validation';
import { startConflictWatcher } from './conflicts';
import { BRAND } from '../../brand.mjs';

// Local validation layer — reject derived fields on every local write (layer 1 of 2).
registerValidation(PouchDB as unknown as PouchDB.Static);

/** Main, synced database (browser IndexedDB ↔ CouchDB via startSync). */
export const db: PouchDB.Database = new PouchDB(BRAND.dbName);

// ─────────────────────────────────────────────────────────────────────────────
// NEVER SYNC CART. cartDb is browser-local only. Cart data must never leave the
// device (CLAUDE.md: "Cart data must never leave the browser"). There is
// deliberately NO sync call anywhere that references cartDb — do not add one.
// ─────────────────────────────────────────────────────────────────────────────
export const cartDb: PouchDB.Database = new PouchDB(`${BRAND.dbName}-cart`);
// NEVER SYNC CART

// ---- Sync ----

let syncHandle: PouchDB.Replication.Sync<object> | null = null;
type SyncState = 'idle' | 'active' | 'error' | 'offline';
const syncStateListeners = new Set<(s: SyncState) => void>();
// 'offline' until a sync actually reaches the server — never claim "synced" untried.
let lastSyncState: SyncState = 'offline';

function emitSyncState(s: SyncState): void {
  lastSyncState = s;
  for (const cb of syncStateListeners) cb(s);
}

/**
 * Start continuous bidirectional sync with same-origin /db/{dbName}. Idempotent:
 * a second call while syncing is a no-op. Returns a stop fn.
 * skip_setup:true — the server database already exists (couch/setup.sh); clients
 * must not try to create it.
 */
export function startSync(): () => void {
  if (syncHandle) return stopSync;

  const remote = new PouchDB(location.origin + '/db/' + BRAND.dbName, { skip_setup: true });
  syncHandle = db.sync(remote, { live: true, retry: true });

  syncHandle
    .on('active', () => emitSyncState('active'))
    .on('change', () => emitSyncState('active'))
    .on('paused', (err?: unknown) => emitSyncState(err ? 'offline' : 'idle'))
    .on('denied', () => emitSyncState('error'))
    .on('error', (err: unknown) => {
      // Network/fetch failures = offline (recoverable); everything else = error.
      const msg = String((err as { message?: string })?.message ?? err);
      emitSyncState(/fetch|network|Failed to fetch/i.test(msg) ? 'offline' : 'error');
    });

  return stopSync;
}

export function stopSync(): void {
  if (syncHandle) {
    syncHandle.cancel();
    syncHandle = null;
    emitSyncState('offline');
  }
}

/** Subscribe to sync state. Returns an unsubscribe fn. Fires current state immediately. */
export function onSyncState(cb: (s: SyncState) => void): () => void {
  syncStateListeners.add(cb);
  cb(lastSyncState);
  return () => syncStateListeners.delete(cb);
}

// ---- Live change notifications (debounced) ----

const changeListeners = new Set<() => void>();
let changeTimer: ReturnType<typeof setTimeout> | null = null;

db.changes({ live: true, since: 'now' }).on('change', () => {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    for (const cb of changeListeners) cb();
  }, 150);
});

/** Subscribe to debounced local/synced changes. Returns an unsubscribe fn. */
export function onDbChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// ---- Startup: conflict watcher + DEV seed ----

// Multi-master conflicts are expected — resolve them continuously (CLAUDE.md).
startConflictWatcher(db);

async function bootstrap(): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    // _local marker is written only after a COMPLETE seed; doc_count can't tell
    // a finished seed from one interrupted by a closed tab.
    if (await db.get('_local/seeded').catch(() => null)) return;
    const existing = await db.allDocs();
    if (existing.rows.length > 0) {
      // Interrupted half-seed from a previous dev session — wipe and reseed.
      await db.bulkDocs(
        existing.rows.map((r) => ({ _id: r.id, _rev: r.value.rev, _deleted: true }) as never),
      );
    }
    const { seedDemoData } = await import('./seed');
    await seedDemoData(db);
    await db.put({ _id: '_local/seeded' } as never);
  } catch (err) {
    // Never let a failed dev seed leave the app dead — dbReady must resolve.
    console.error('[seed] dev seed failed — continuing with existing data', err);
  }
}

/** Resolves once the DB is ready (DEV: after auto-seeding an empty DB). */
export const dbReady: Promise<void> = bootstrap();
