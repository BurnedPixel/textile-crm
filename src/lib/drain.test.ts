import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { drainToRemote } from './drain';

describe('drainToRemote', () => {
  it('pushes local docs to the remote before anything is destroyed', async () => {
    const local = makeTestDb();
    const remote = makeTestDb();
    await local.put({ _id: 'sale:2026-08-16T00:00:00.000Z:abc', totalUsd: 10 } as never);

    await drainToRemote(local, remote, 5_000);

    const got = await remote.get('sale:2026-08-16T00:00:00.000Z:abc');
    expect(got).toBeTruthy();
  });

  it('rejects against an unreachable remote and leaves the local db intact', async () => {
    const local = makeTestDb();
    const dead = makeTestDb();
    await dead.destroy(); // unreachable: replication to it cannot complete
    await local.put({ _id: 'sale:2026-08-16T00:00:00.000Z:def', totalUsd: 10 } as never);

    await expect(drainToRemote(local, dead, 1_000)).rejects.toThrow();

    // Nothing destroyed — the caller must still find the unsynced sale.
    const got = await local.get('sale:2026-08-16T00:00:00.000Z:def');
    expect(got).toBeTruthy();
  });
});
