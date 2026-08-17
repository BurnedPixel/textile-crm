import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';

describe('validation plugin — rejects derived fields', () => {
  it('rejects a doc containing totalBs (via put)', async () => {
    const db = makeTestDb();
    await expect(
      db.put({ _id: 'sale:x', type: 'sale', totalUsd: 10, totalBs: 365 } as never),
    ).rejects.toThrow(/totalBs/);
  });

  it('rejects a doc containing amountBs (via post)', async () => {
    const db = makeTestDb();
    await expect(
      db.post({ type: 'expense', amountUsd: 5, amountBs: 182.5 } as never),
    ).rejects.toThrow(/amountBs/);
  });

  it('rejects amountBs inside a bulkDocs batch', async () => {
    const db = makeTestDb();
    await expect(
      db.bulkDocs([
        { _id: 'ok', type: 'x' },
        { _id: 'bad', type: 'expense', amountBs: 1 },
      ] as never),
    ).rejects.toThrow(/amountBs/);
  });

  // Replication pulls arrive as new_edits:false — documents this device did not
  // author. Running the deny-list over them would let ONE bad doc upstream
  // reject the whole inbound batch, on every device, forever. The server's
  // validate_doc_update is the boundary for those.
  it('skips validation for replication writes ({ docs, new_edits } wrapper form)', async () => {
    const db = makeTestDb();
    await (db.bulkDocs as unknown as (a: unknown) => Promise<unknown>)({
      docs: [{ _id: 'repl-wrapper', _rev: '1-' + 'a'.repeat(32), type: 'sale', totalUsd: 10, totalBs: 365 }],
      new_edits: false,
    });
    expect((await db.get<{ totalBs: number }>('repl-wrapper')).totalBs).toBe(365);
  });

  it('skips validation for replication writes (new_edits in the options argument)', async () => {
    const db = makeTestDb();
    await db.bulkDocs(
      [{ _id: 'repl-opts', _rev: '1-' + 'b'.repeat(32), type: 'expense', amountUsd: 5, amountBs: 182.5 }] as never,
      { new_edits: false } as never,
    );
    expect((await db.get<{ amountBs: number }>('repl-opts')).amountBs).toBe(182.5);
  });

  it('still validates an ordinary bulkDocs in the wrapper form', async () => {
    const db = makeTestDb();
    await expect(
      (db.bulkDocs as unknown as (a: unknown) => Promise<unknown>)({
        docs: [{ _id: 'local', type: 'sale', totalUsd: 10, totalBs: 365 }],
      }),
    ).rejects.toThrow(/totalBs/);
  });

  it('allows clean docs through', async () => {
    const db = makeTestDb();
    const res = await db.put({ _id: 'clean', type: 'sale', totalUsd: 10 } as never);
    expect(res.ok).toBe(true);
  });
});
