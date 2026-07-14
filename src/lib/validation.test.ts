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

  it('allows clean docs through', async () => {
    const db = makeTestDb();
    const res = await db.put({ _id: 'clean', type: 'sale', totalUsd: 10 } as never);
    expect(res.ok).toBe(true);
  });
});
