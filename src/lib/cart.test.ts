import { describe, it, expect } from 'vitest';
import { makeTestDb } from './testdb';
import { getCart, addLine, clearCart } from './cart';
import type { CartLineItem } from './types';

function unitLine(productId: string, qty: number): CartLineItem {
  return {
    productId,
    batchId: 'batch:x',
    description: 'combo',
    quantity: qty,
    unitOfMeasure: 'Units',
    unitPriceAtSale: 19,
    lineSubtotalUsd: 0,
  };
}

function kgLine(productId: string, qty: number): CartLineItem {
  return {
    productId,
    batchId: 'batch:y',
    description: 'rollo',
    quantity: qty,
    unitOfMeasure: 'Kg',
    unitPriceAtSale: 10,
    lineSubtotalUsd: 0,
  };
}

describe('cart', () => {
  it('creates a cart with a transactionId on first read', async () => {
    const db = makeTestDb();
    const cart = await getCart(db);
    expect(cart.transactionId).toBeTruthy();
    expect(cart.lines).toHaveLength(0);
  });

  it('merges same-productId Unit lines', async () => {
    const db = makeTestDb();
    await addLine(db, unitLine('product:x:stock', 3));
    const cart = await addLine(db, unitLine('product:x:stock', 2));
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(5);
    expect(cart.lines[0].lineSubtotalUsd).toBe(95); // 5 * 19
  });

  it('rejects duplicate Kg (roll) productId with a Spanish error', async () => {
    const db = makeTestDb();
    await addLine(db, kgLine('product:y:r1', 5));
    await expect(addLine(db, kgLine('product:y:r1', 3))).rejects.toThrow(
      'Ese rollo ya está en el carrito.',
    );
  });

  it('allows two different rolls (Kg) as separate lines', async () => {
    const db = makeTestDb();
    await addLine(db, kgLine('product:y:r1', 5));
    const cart = await addLine(db, kgLine('product:y:r2', 3));
    expect(cart.lines).toHaveLength(2);
  });

  it('clearCart empties and rotates the transactionId', async () => {
    const db = makeTestDb();
    const before = await addLine(db, unitLine('product:x:stock', 3));
    const after = await clearCart(db);
    expect(after.lines).toHaveLength(0);
    expect(after.transactionId).not.toBe(before.transactionId);
  });
});
