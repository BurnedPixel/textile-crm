// React data hook for islands. Awaits dbReady, runs the query, and re-runs on
// debounced DB changes (onDbChange). Plain React 19 — no data-fetching libs.

import { useEffect, useState, useCallback, useRef } from 'react';
import { db, dbReady, onDbChange } from './db';

export interface LiveQueryResult<T> {
  data: T | undefined;
  reload: () => void;
}

/**
 * Run `query(db)` and keep it fresh as the DB changes. `deps` re-run the query
 * when they change (e.g. a filter). The query receives the live `db` handle.
 */
export function useLiveQuery<T>(
  query: (database: PouchDB.Database) => Promise<T>,
  deps: unknown[] = [],
): LiveQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const queryRef = useRef(query);
  queryRef.current = query;

  const run = useCallback(() => {
    let cancelled = false;
    void dbReady.then(() =>
      queryRef
        .current(db)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch((err) => {
          if (!cancelled) console.error('[useLiveQuery]', err);
        }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // Each change fires a fresh run(); cancel the in-flight one first so a stale
    // query can't setData after unmount (only the latest run's cancel is kept).
    let latestCancel = run();
    const off = onDbChange(() => {
      latestCancel();
      latestCancel = run();
    });
    return () => {
      latestCancel();
      off();
    };
  }, [run]);

  const reload = useCallback(() => {
    run();
  }, [run]);

  return { data, reload };
}
