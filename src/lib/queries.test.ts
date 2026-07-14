import { describe, it, expect } from 'vitest';
import { computePaymentStatus, saveClient } from './queries';
import { batchIdOf } from './types';
import { makeTestDb } from './testdb';

const RATE = 36.5;

describe('computePaymentStatus — boundaries', () => {
  it('PAID when fully covered in USD cash', () => {
    expect(computePaymentStatus(100, 100, 0, 0, RATE)).toBe('PAID');
  });

  it('PAID within the 1-cent epsilon', () => {
    expect(computePaymentStatus(100, 99.995, 0, 0, RATE)).toBe('PAID');
  });

  it('PARTIAL when some but not all is paid', () => {
    expect(computePaymentStatus(100, 40, 0, 0, RATE)).toBe('PARTIAL');
  });

  it('PENDING when nothing is paid', () => {
    expect(computePaymentStatus(100, 0, 0, 0, RATE)).toBe('PENDING');
  });

  it('Bs-only payment at the locked rate marks PAID', () => {
    // 100 USD * 36.5 = 3650 Bs pays it off exactly at the locked rate.
    expect(computePaymentStatus(100, 0, 0, 3650, RATE)).toBe('PAID');
  });

  it('mixed channels sum across currencies', () => {
    // 30 cash + 20 transfer + 1825 Bs (=50 USD) = 100 USD.
    expect(computePaymentStatus(100, 30, 20, 1825, RATE)).toBe('PAID');
  });

  it('a tiny Bs payment is PARTIAL, not PENDING', () => {
    expect(computePaymentStatus(100, 0, 0, 3.65, RATE)).toBe('PARTIAL');
  });
});

describe('batchIdOf — convergence', () => {
  it('normalizes whitespace and case', () => {
    expect(batchIdOf('  Azul Rey ', '30', 'Jersey')).toBe(batchIdOf('azul rey', '30', 'jersey'));
  });

  it('strips accents so accented + unaccented converge', () => {
    expect(batchIdOf('Piqué', '30', 'Rib')).toBe(batchIdOf('pique', '30', 'rib'));
  });

  it('strips the _id delimiter — "a:b" cannot reshape the id (id-injection)', () => {
    // (color "x:y", nm "z") must NOT collide with (color "x", nm "y:z").
    expect(batchIdOf('x:y', 'z', 'w')).not.toBe('batch:x:y:z:w');
    expect(batchIdOf('x:y', 'z', 'w')).toBe(batchIdOf('x y', 'z', 'w'));
    expect(batchIdOf('x', 'y:z', 'w')).toBe('batch:x:y-z:w');
  });
});

describe('saveClient — createOnly guard', () => {
  it('createOnly rejects an existing documentId instead of overwriting', async () => {
    const db = makeTestDb();
    await saveClient(db, { documentId: 'V-1', name: 'Original' });
    // A create against the same id (normalized: 'V-1' === 'v-1') must throw, not upsert.
    await expect(
      saveClient(db, { documentId: 'v-1', name: 'Impostor' }, { createOnly: true }),
    ).rejects.toThrow(/Ya existe/);
    const stored = await saveClient(db, { documentId: 'V-1', name: 'Edited' }); // upsert path still works
    expect(stored.name).toBe('Edited');
  });
});
