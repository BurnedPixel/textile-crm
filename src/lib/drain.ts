// One-shot push replication with a bounded timeout. Used before destroying the
// local database on a shared device: NOTHING may be destroyed until every local
// change is provably on the server. Takes db handles as arguments (never imports
// db.ts) so it stays node-testable.

/** Default drain budget. Long enough for a real backlog, short enough to give up. */
export const DRAIN_TIMEOUT_MS = 15_000;

/**
 * Push every local change to `remote`. Resolves ONLY on a clean, complete push;
 * rejects on network failure, server rejection (doc_write_failures) or timeout.
 * The caller destroys nothing unless this resolves.
 */
export async function drainToRemote(
  local: PouchDB.Database,
  remote: PouchDB.Database,
  timeoutMs: number = DRAIN_TIMEOUT_MS,
): Promise<void> {
  const rep = local.replicate.to(remote, { retry: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      rep as unknown as Promise<PouchDB.Replication.ReplicationResultComplete<object>>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`drain timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    // A doc the server REJECTED (validate_doc_update, 403) never resolves the
    // replication as an error — it lands here. Destroying now would erase it.
    if (!result.ok || result.doc_write_failures > 0) {
      throw new Error(`drain incomplete: ${result.doc_write_failures} documento(s) rechazado(s)`);
    }
  } finally {
    clearTimeout(timer);
    rep.cancel(); // no-op once complete; stops the push on timeout
  }
}
