// WhatsApp v1 — a wa.me deep link with the message pre-written. A human presses
// the button (client answer, casilla 18: «el botón está bien por ahora»).
//
// Pure, no db, no browser API: everything here is a string transformation, so
// the message wording is testable without a browser.
//
// Why NOT the Cloud API, so nobody re-litigates it from the code: the deployed
// CSP is `connect-src 'self'`, so a browser fetch to Meta is blocked — and the
// token would ship inside a bundle that lands on every device. An unattended
// sender also has to live on the VPS, reading its own replica, which dunes
// clients on stale balances whenever Pi↔cloud replication is behind. With a
// human pressing the button, the operator IS the filter.

import { fmtUsd } from './format';
import { norm, type SaleDoc } from './types';

/**
 * A phone number as wa.me wants it: digits only, country code included, no `+`.
 * Returns null when the number cannot be one — the button is hidden rather than
 * opening a chat with nobody.
 *
 * Venezuelan mobiles are written locally as 0412-1234567; wa.me needs
 * 584121234567. A stored landline (0212…) is left alone as far as this is
 * concerned: it is a plausible number, it simply may not have WhatsApp, and
 * only the operator can know that.
 */
export function toWaNumber(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  // 0412… → 58412…  (the local trunk prefix is not part of the international number)
  let e164 = digits.startsWith('0') ? `58${digits.slice(1)}` : digits;
  // A bare 412... typed without either prefix.
  if (e164.length === 10 && !e164.startsWith('58')) e164 = `58${e164}`;

  // E.164 is 7–15 digits including the country code. Anything outside that is a
  // typo, not a number, and must not become a link.
  if (e164.length < 10 || e164.length > 15) return null;
  return e164;
}

/** The full wa.me URL, or null when the number is unusable. */
export function waLink(phone: string | undefined | null, text: string): string | null {
  const number = toWaNumber(phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

export interface DunningInput {
  clientName: string;
  owedUsd: number;
  /** How many sales the balance covers, for the plural. */
  saleCount: number;
  /** Optional: the business name, so the client knows who is writing. */
  businessName?: string;
}

/**
 * The collection reminder. Deliberately short, courteous and factual: it names
 * the amount and nothing else. Off-the-books debts may be messaged (casilla 19),
 * so there is no filter on which sales it covers — but it never itemises them,
 * because a WhatsApp message is not a place to put a client's purchase history.
 */
export function buildDunningText(input: DunningInput): string {
  const who = input.businessName ? ` de ${input.businessName}` : '';
  const sales = input.saleCount === 1 ? 'una factura pendiente' : `${input.saleCount} facturas pendientes`;
  return [
    `Hola ${input.clientName}, le escribimos${who}.`,
    `Su saldo pendiente es de ${fmtUsd(input.owedUsd)} (${sales}).`,
    '¿Nos indica cuándo podemos pasar a cobrar? Gracias.',
  ].join(' ');
}

export interface ArrivalInput {
  clientName: string;
  /** e.g. "Jersey" — the fabric type that just came in. */
  fabricType: string;
  color?: string;
  businessName?: string;
}

/** "New fabric arrived" — offered after an ingress, to clients who buy that cloth. */
export function buildArrivalText(input: ArrivalInput): string {
  const who = input.businessName ? ` de ${input.businessName}` : '';
  const what = input.color ? `${input.fabricType} ${input.color}` : input.fabricType;
  return [
    `Hola ${input.clientName}, le escribimos${who}.`,
    `Acaba de llegar ${what} a nuestro almacén.`,
    '¿Le apartamos algo? Gracias.',
  ].join(' ');
}

/**
 * Client ids that bought a given fabric since `sinceISO`, most recent purchase
 * first. Pure — it reads sales the caller already has.
 *
 * Matched on the batch id, whose last segment is the normed fabric type, rather
 * than on the line description: the description is a frozen display string and
 * its wording has already changed once. Nothing new has to be stored and no
 * index is needed.
 *
 * Deliberately NOT ClientDoc.specialty: that holds garment categories ("Ropa
 * infantil", "Uniformes") while batches hold fabric types, so matching them
 * gives near-zero hits and quietly changes what an existing screen means.
 */
export function clientsWhoBought(
  sales: Array<Pick<SaleDoc, 'clientId' | 'date' | 'lineItems'>>,
  fabricType: string,
  sinceISO: string,
): string[] {
  const suffix = `:${norm(fabricType)}`;
  const lastSeen = new Map<string, string>();
  for (const sale of sales) {
    if (!sale.clientId || sale.date < sinceISO) continue;
    if (!sale.lineItems.some((l) => l.batchId.endsWith(suffix))) continue;
    const seen = lastSeen.get(sale.clientId);
    if (!seen || sale.date > seen) lastSeen.set(sale.clientId, sale.date);
  }
  return [...lastSeen.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
}
