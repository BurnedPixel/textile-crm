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

  // Returns a cancel fn plus `done`, a promise that settles once the query
  // has resolved/rejected — used by the effect below to know when a run has
  // actually finished (not just been kicked off).
  const run = useCallback(() => {
    let cancelled = false;
    const done = dbReady.then(() =>
      queryRef
        .current(db)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch((err) => {
          if (!cancelled) console.error('[useLiveQuery]', err);
        }),
    );
    return { cancel: () => (cancelled = true), done };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // Single-flight: a change event while a run is in flight only sets a
    // pending bit instead of starting a second overlapping scan; the
    // in-flight run's completion (success or error) drains the pending bit
    // by starting exactly one more run. Latest-run-wins is preserved because
    // only one run is ever in flight at a time.
    let latestCancel = () => {};
    let inFlight = false;
    let pending = false;
    let unmounted = false;

    const startAndDrain = () => {
      inFlight = true;
      pending = false;
      const { cancel, done } = run();
      latestCancel = cancel;
      void done.finally(() => {
        inFlight = false;
        if (pending && !unmounted) startAndDrain();
      });
    };

    startAndDrain();
    const off = onDbChange(() => {
      if (inFlight) {
        pending = true;
        return;
      }
      startAndDrain();
    });
    return () => {
      unmounted = true;
      latestCancel();
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const reload = useCallback(() => {
    run();
  }, [run]);

  return { data, reload };
}
