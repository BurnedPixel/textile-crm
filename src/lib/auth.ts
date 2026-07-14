// Cookie-session auth against same-origin /db/_session (CouchDB). Browser-only.
// IMPORTANT: this is a UX gate. CouchDB _security (couch/) is the real trust
// boundary — see couch/README.md. Passwords are NEVER stored anywhere.

import type { SessionUser } from './types';
import { startSync, stopSync } from './db';
import { BRAND } from '../../brand.mjs';

const CACHE_KEY = `${BRAND.dbName}:user`;

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
    return cachedUser();
  }
  if (!res.ok) return cachedUser();

  const body = (await res.json()) as { userCtx?: { name: string | null; roles: string[] } };
  const ctx = body.userCtx;
  if (!ctx?.name) return null; // anonymous
  const user: SessionUser = { name: ctx.name, roles: ctx.roles ?? [] };
  cache(user);
  return user;
}

/** Log out: end the server session, stop sync, clear cache, go to /login. */
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
