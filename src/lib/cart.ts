// Cart state — lives ONLY in cartDb (the never-synced browser DB). Takes cartDb
// as the FIRST arg. Consolidates into an immutable Sale on checkout (see checkout.ts);
// cart is never persisted server-side (CLAUDE.md). No browser imports here.

import { CART_ID, type CartDoc, type CartLineItem } from './types';
import { round2 } from './format';

type DB = PouchDB.Database;

function newTransaction(): { transactionId: string; createdAt: string } {
  return { transactionId: globalThis.crypto.randomUUID(), createdAt: new Date().toISOString() };
}

/** Fetch the current cart, creating an empty one (with a fresh transactionId) if absent. */
export async function getCart(cartDb: DB): Promise<CartDoc> {
  try {
    return (await cartDb.get(CART_ID)) as CartDoc;
  } catch (err) {
    if ((err as PouchDB.Core.Error).status !== 404) throw err;
    const { transactionId, createdAt } = newTransaction();
    const now = new Date().toISOString();
    const doc: CartDoc = {
      _id: CART_ID,
      type: 'cart',
      transactionId,
      createdAt,
      clientId: null,
      isOnTheBooks: true,
      lines: [],
      updatedAt: now,
    };
    const res = await cartDb.put(doc);
    return { ...doc, _rev: res.rev }; // carry the rev so an immediate re-put doesn't conflict
  }
}

async function mutate(cartDb: DB, fn: (cart: CartDoc) => void): Promise<CartDoc> {
  const cart = await getCart(cartDb);
  fn(cart);
  cart.updatedAt = new Date().toISOString();
  const res = await cartDb.put(cart);
  return { ...cart, _rev: res.rev };
}

/**
 * Add a line.
 * - Units: same-productId lines merge (sum quantity) — one row per pool product.
 * - Kg (rolls): duplicate productId is rejected — the seller edits the existing
 *   line instead of adding a second cut of the same roll.
 */
export async function addLine(cartDb: DB, line: CartLineItem): Promise<CartDoc> {
  return mutate(cartDb, (cart) => {
    if (line.unitOfMeasure === 'Units') {
      const existing = cart.lines.find(
        (l) => l.productId === line.productId && l.unitOfMeasure === 'Units',
      );
      if (existing) {
        existing.quantity += line.quantity;
        existing.lineSubtotalUsd = round2(existing.quantity * existing.unitPriceAtSale);
        return;
      }
    } else {
      // Kg (roll): reject duplicates — edit the existing line instead.
      if (cart.lines.some((l) => l.productId === line.productId)) {
        throw new Error('Ese rollo ya está en el carrito.');
      }
    }
    cart.lines.push({ ...line, lineSubtotalUsd: round2(line.quantity * line.unitPriceAtSale) });
  });
}

export async function updateLine(
  cartDb: DB,
  idx: number,
  patch: Partial<CartLineItem>,
): Promise<CartDoc> {
  return mutate(cartDb, (cart) => {
    const line = cart.lines[idx];
    if (!line) throw new Error('Línea de carrito no encontrada.');
    Object.assign(line, patch);
    line.lineSubtotalUsd = round2(line.quantity * line.unitPriceAtSale);
  });
}

export async function removeLine(cartDb: DB, idx: number): Promise<CartDoc> {
  return mutate(cartDb, (cart) => {
    cart.lines.splice(idx, 1);
  });
}

export async function setClient(cartDb: DB, clientId: string | null): Promise<CartDoc> {
  return mutate(cartDb, (cart) => {
    cart.clientId = clientId;
  });
}

export async function setOnTheBooks(cartDb: DB, isOnTheBooks: boolean): Promise<CartDoc> {
  return mutate(cartDb, (cart) => {
    cart.isOnTheBooks = isOnTheBooks;
  });
}

/** Empty the cart and rotate to a NEW transactionId+createdAt (fresh checkout identity). */
export async function clearCart(cartDb: DB): Promise<CartDoc> {
  const prev = await getCart(cartDb);
  const { transactionId, createdAt } = newTransaction();
  const now = new Date().toISOString();
  const doc: CartDoc = {
    _id: CART_ID,
    _rev: prev._rev,
    type: 'cart',
    transactionId,
    createdAt,
    clientId: null,
    isOnTheBooks: true,
    lines: [],
    updatedAt: now,
  };
  const res = await cartDb.put(doc);
  return { ...doc, _rev: res.rev };
}
