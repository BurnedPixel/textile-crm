import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { seedDemoData } from './seed';
import { getStockedBatches, getSales, getClients, getExpenses, getConfig } from './queries';

describe('seedDemoData — full end-to-end through logic paths', () => {
  it('produces realistic data with no leaked derived fields', async () => {
    const db = makeTestDb();
    await seedDemoData(db);

    const stocked = await getStockedBatches(db);
    const sales = await getSales(db);
    const clients = await getClients(db);
    const expenses = await getExpenses(db);
    const cfg = await getConfig(db);

    expect(stocked.length).toBeGreaterThanOrEqual(7); // ~8 batches, some may deplete
    expect(sales).toHaveLength(3);
    const statuses = sales.map((s) => s.paymentStatus).sort();
    expect(statuses).toContain('PAID');
    expect(statuses).toContain('PARTIAL');
    expect(statuses).toContain('PENDING');
    expect(clients).toHaveLength(3);
    expect(expenses).toHaveLength(2);
    expect(cfg?.currentDailyRateBCV).toBe(36.5);

    const all = await db.allDocs({ include_docs: true });
    const bad = all.rows.filter(
      (r) => r.doc && ('totalBs' in r.doc || 'amountBs' in r.doc),
    );
    expect(bad).toHaveLength(0);
  });
});
