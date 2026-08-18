// Browser-only wiring for the ADMIN-ONLY nómina database (salaries). Separate
// from db.ts on purpose: the local replica is created lazily and replicated ONLY
// in an admin session, so a vendedor's device never holds payroll at all (the
// server `_security` on `${dbName}-nomina` is the real boundary — this module is
// the client half of that promise). Logic modules take a db handle; never import
// this from them.
//
// Import direction is nominadb → db (acyclic): db.ts must NOT import this file.
// Importing db.ts here also guarantees the local validation layer is registered
// before any nómina write (registerValidation patches the shared PouchDB proto).

import PouchDB from 'pouchdb-browser';
import { startConflictWatcher } from './conflicts';
import { drainToRemote } from './drain';
import { reportSyncState } from './db';
import { BRAND } from '../../brand.mjs';

const NOMINA_DB = `${BRAND.dbName}-nomina`;

let instance: PouchDB.Database | null = null;
let syncHandle: PouchDB.Replication.Sync<object> | null = null;
let stopWatcher: (() => void) | null = null;
let changeFeed: { cancel: () => void } | null = null;

/** Lazy singleton — merely importing this module must not create the database. */
export function nominaDb(): PouchDB.Database {
  if (!instance) instance = new PouchDB(NOMINA_DB);
  return instance;
}

/** Same-origin CouchDB handle. skip_setup: the server db already exists (setup.sh). */
function remoteNominaDb(): PouchDB.Database {
  return new PouchDB(location.origin + '/db/' + NOMINA_DB, { skip_setup: true });
}

/** A replication error caused by an expired/invalid session (CouchDB 401). */
function isAuthError(err: unknown): boolean {
  const e = err as { status?: number; name?: string } | null;
  return e?.status === 401 || e?.name === 'unauthorized';
}

/**
 * Start continuous bidirectional sync with /db/{dbName}-nomina. Idempotent.
 * Call ONLY for admins (auth.ts login / SyncStatus) — a non-admin sync would
 * just 403, but it would also create the local replica for nothing.
 *
 * State is reported through db.ts's single shared indicator (last writer wins).
 * Both syncs share one origin and one session cookie, so they diverge only when
 * the server treats the two databases differently (missing db / missing role),
 * which maps to the pessimistic states — the honest direction for the operator.
 */
export function startNominaSync(): void {
  if (syncHandle) return;

  const local = nominaDb();
  syncHandle = local.sync(remoteNominaDb(), { live: true, retry: true });

  syncHandle
    .on('active', () => reportSyncState('active'))
    .on('change', () => reportSyncState('active'))
    .on('paused', (err?: unknown) => reportSyncState(err ? 'offline' : 'idle'))
    .on('denied', (err: unknown) => {
      if (isAuthError(err)) { reportSyncState('unauthorized'); return; }
      const info = err as { direction?: string; doc?: { _id?: string } };
      // eslint-disable-next-line no-console
      console.error('CouchDB rejected nómina write:', info.direction, info.doc?._id, err);
      reportSyncState('denied');
    })
    .on('error', (err: unknown) => {
      if (isAuthError(err)) { reportSyncState('unauthorized'); return; }
      const msg = String((err as { message?: string })?.message ?? err);
      reportSyncState(/fetch|network|Failed to fetch/i.test(msg) ? 'offline' : 'error');
    });

  // Multi-master conflicts are expected here too (worker: docs edited offline).
  if (!stopWatcher) stopWatcher = startConflictWatcher(local);
}

/** Stop replication. The conflict watcher stays on the live handle (see purge). */
export function stopNominaSync(): void {
  if (syncHandle) {
    syncHandle.cancel();
    syncHandle = null;
  }
}

/**
 * Shared-device purge of the nómina database: stop sync, PUSH everything to the
 * server, and only then destroy. Throws (destroying NOTHING, sync restarted) if
 * the push fails or times out — purgeLocalData's contract, applied here.
 * Called only from auth.ts logoutExplicit(), BEFORE purgeLocalData().
 */
export async function purgeNominaData(): Promise<void> {
  const local = nominaDb();
  stopNominaSync();
  try {
    await drainToRemote(local, remoteNominaDb());
  } catch (err) {
    // Nothing destroyed. Put live sync back: the user stays logged in and the
    // pending changes must keep trying to reach the server.
    startNominaSync();
    throw err;
  }
  await local.destroy();
  // Reset every handle bound to the destroyed database, so a later nominaDb()
  // builds a fresh (empty) replica instead of throwing "database is destroyed".
  instance = null;
  stopWatcher?.();
  stopWatcher = null;
  changeFeed?.cancel();
  changeFeed = null;
  // ponytail: subscribers registered before the purge stop receiving until the
  // next onNominaChange() reopens the feed (island remount / page load). The
  // only path here ends in a redirect to /login; reopening now would recreate
  // the database we just erased.
}

// ---- Live change notifications (debounced, mirrors db.ts onDbChange) ----

const changeListeners = new Set<() => void>();
let changeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Subscribe to debounced local/synced nómina changes. Returns an unsubscribe fn.
 * The feed is opened on first subscription — never at import time (that would
 * create the admin-only database on every device).
 */
export function onNominaChange(cb: () => void): () => void {
  if (!changeFeed) {
    changeFeed = nominaDb()
      .changes({ live: true, since: 'now' })
      .on('change', () => {
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          for (const fn of changeListeners) fn();
        }, 150);
      });
  }
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
