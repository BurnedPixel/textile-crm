// Cookie-session auth against same-origin /db/_session (CouchDB). Browser-only.
// IMPORTANT: this is a UX gate. CouchDB _security (couch/) is the real trust
// boundary — see couch/README.md. Passwords are NEVER stored anywhere.

import type { SessionUser } from './types';
import { startSync, stopSync, purgeLocalData } from './db';
import { BRAND } from '../../brand.mjs';

const CACHE_KEY = `${BRAND.dbName}:user`;
/** Device-scoped, NEVER synced and never cleared by a purge: it describes the equipment. */
const SHARED_KEY = `${BRAND.dbName}:shared-device`;

function cache(user: SessionUser): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(user));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Last known session, read synchronously from localStorage (offline-first). */
export function cachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

/**
 * Log in. On success caches {name, roles} and starts sync. Passwords go straight
 * to CouchDB over the same-origin proxy and are never persisted.
 */
export async function login(name: string, password: string): Promise<SessionUser> {
  let res: Response;
  try {
    res = await fetch('/db/_session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name, password }),
    });
  } catch {
    throw new Error('Sin conexión con el servidor.');
  }

  if (res.status === 401) throw new Error('Usuario o contraseña incorrectos');
  if (!res.ok) throw new Error('No se pudo iniciar sesión. Intente de nuevo.');

  const body = (await res.json()) as { name?: string; roles?: string[] };
  const user: SessionUser = { name: body.name ?? name, roles: body.roles ?? [] };
  cache(user);
  startSync();
  return user;
}

/**
 * Current session from the server. Anonymous → null. On network error, fall back
 * to the cached user so the app keeps working offline.
 */
export async function getSession(): Promise<SessionUser | null> {
  let res: Response;
  try {
    res = await fetch('/db/_session', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    // Network failure → offline. Keep the cached user so the app keeps working.
    return cachedUser();
  }
  // 401 = server reachable but the session is gone (expired/logged out) → NOT
  // offline. Report anonymous so the caller can route to /login; never fall back
  // to the stale cache here, or an expired session looks valid forever.
  if (res.status === 401) return null;
  if (!res.ok) return cachedUser(); // transient 5xx — don't force logout

  const body = (await res.json()) as { userCtx?: { name: string | null; roles: string[] } };
  const ctx = body.userCtx;
  if (!ctx?.name) return null; // anonymous
  const user: SessionUser = { name: ctx.name, roles: ctx.roles ?? [] };
  cache(user);
  return user;
}

/**
 * Log out: end the server session, stop sync, clear cache, go to /login.
 * NEVER purges local data — this is also the session-expiry path (SyncStatus
 * forces it on a 401), where the device is very likely offline and holding
 * unsynced sales. Explicit logout goes through logoutExplicit().
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/db/_session', { method: 'DELETE', credentials: 'include' });
  } catch {
    /* still clear locally even if the server is unreachable */
  }
  stopSync();
  clearCache();
  location.replace('/login');
}

// ---- Shared device (per-device setting; explicit logout wipes this equipment) ----

/** Is this device marked as shared? Device-scoped localStorage, never synced. */
export function isSharedDevice(): boolean {
  try {
    return localStorage.getItem(SHARED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSharedDevice(on: boolean): void {
  try {
    if (on) localStorage.setItem(SHARED_KEY, '1');
    else localStorage.removeItem(SHARED_KEY);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Every app key for this brand except SHARED_KEY (a property of the device). */
function clearBrandStorage(): void {
  try {
    const prefix = `${BRAND.dbName}:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix) && key !== SHARED_KEY) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

const PURGE_FAILED_MSG =
  'No se borraron los datos: hay cambios sin sincronizar. Conéctese e intente de nuevo.';

/**
 * Explicit logout (the «Salir» buttons). On a shared device the local databases
 * are drained to the server and then destroyed. If the drain fails, NOTHING is
 * destroyed and the user stays logged IN — a half-logout that promised a wipe
 * and delivered neither is worse than staying. Throws PURGE_FAILED_MSG then.
 */
export async function logoutExplicit(): Promise<void> {
  if (isSharedDevice()) {
    try {
      // BEFORE the session is deleted — the drain push needs the auth cookie.
      await purgeLocalData();
    } catch (err) {
      console.error('[logout] purge aborted, local data kept', err);
      throw new Error(PURGE_FAILED_MSG);
    }
    clearBrandStorage();
  }
  await logout();
}
