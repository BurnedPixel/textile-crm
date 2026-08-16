import { describe, it, expect } from 'vitest';
import { toWaNumber, waLink, buildDunningText, buildArrivalText, clientsWhoBought } from './whatsapp';
import { batchIdOf } from './types';
import { validatePhone } from './types';

describe('toWaNumber — a stored phone becomes a wa.me number, or nothing', () => {
  it('turns the local formats the operators actually type into E.164 digits', () => {
    for (const written of ['0412-1234567', '0412 123 4567', '(0412) 1234567', '04121234567']) {
      expect(toWaNumber(written)).toBe('584121234567');
    }
  });

  it('accepts a number already written internationally', () => {
    expect(toWaNumber('+58 412 1234567')).toBe('584121234567');
    expect(toWaNumber('584121234567')).toBe('584121234567');
  });

  it('assumes Venezuela for a bare 10-digit mobile', () => {
    expect(toWaNumber('4121234567')).toBe('584121234567');
  });

  it('keeps a landline — it is a real number, it just may not have WhatsApp', () => {
    expect(toWaNumber('0212-7654321')).toBe('582127654321');
  });

  it('returns null for anything that cannot be a number', () => {
    for (const junk of ['', '   ', 'no tiene', '12345', null, undefined, '+++', '1'.repeat(20)]) {
      expect(toWaNumber(junk)).toBeNull();
    }
  });

  it('agrees with validatePhone — one definition of a normalizable number', () => {
    // Since the +cc rule (2026-08-16) both sides reject a 7-digit local number:
    // it cannot carry a country code, so it is neither a valid stored phone nor
    // a wa.me number. What validates, links.
    expect(validatePhone('7654321')).not.toBeNull();
    expect(toWaNumber('7654321')).toBeNull();
    expect(validatePhone('+58 412 1234567')).toBeNull();
    expect(toWaNumber('+58 412 1234567')).toBe('584121234567');
  });
});

describe('waLink', () => {
  it('builds a wa.me url with the message url-encoded', () => {
    const link = waLink('0412-1234567', 'Hola, ¿cómo está?');
    expect(link).toBe('https://wa.me/584121234567?text=Hola%2C%20%C2%BFc%C3%B3mo%20est%C3%A1%3F');
  });

  it('is null when there is no usable number, so the button can hide', () => {
    expect(waLink('', 'x')).toBeNull();
    expect(waLink('no tiene', 'x')).toBeNull();
  });
});

describe('message wording', () => {
  it('names the amount and the number of invoices, and nothing else', () => {
    const text = buildDunningText({
      clientName: 'Confecciones Lara', owedUsd: 1234.5, saleCount: 3,
      businessName: 'ML Textiles, C.A.',
    });
    expect(text).toContain('Confecciones Lara');
    expect(text).toContain('ML Textiles, C.A.');
    expect(text).toContain('3 facturas pendientes');
    expect(text).toContain('1.234,50'); // es-VE money, same formatter as the app
    // No itemisation: a client's purchase history does not belong in a message.
    expect(text).not.toMatch(/jersey|rollo|lote/i);
  });

  it('uses the singular for one invoice', () => {
    const text = buildDunningText({ clientName: 'Ana', owedUsd: 50, saleCount: 1 });
    expect(text).toContain('una factura pendiente');
    expect(text).not.toContain('facturas');
  });

  it('works without a business name configured', () => {
    const text = buildDunningText({ clientName: 'Ana', owedUsd: 50, saleCount: 1 });
    expect(text.startsWith('Hola Ana, le escribimos.')).toBe(true);
  });

  it('announces an arrival by fabric, with the colour when there is one', () => {
    expect(buildArrivalText({ clientName: 'Ana', fabricType: 'Jersey', color: 'Azul Rey' }))
      .toContain('Jersey Azul Rey');
    expect(buildArrivalText({ clientName: 'Ana', fabricType: 'Jersey' }))
      .toContain('Acaba de llegar Jersey');
  });
});

describe('clientsWhoBought — who to tell about a new arrival', () => {
  const line = (color: string, nm: string, fabric: string) => ({
    productId: 'p', batchId: batchIdOf(color, nm, fabric), description: 'x',
    quantity: 1, unitOfMeasure: 'Kg' as const, unitPriceAtSale: 1, lineSubtotalUsd: 1,
  });
  const sale = (clientId: string | null, date: string, ...lines: ReturnType<typeof line>[]) =>
    ({ clientId, date, lineItems: lines });

  const sales = [
    sale('client:a', '2026-07-01T00:00:00.000Z', line('Azul Rey', '30', 'Jersey')),
    sale('client:b', '2026-07-20T00:00:00.000Z', line('Negro', '24', 'Jersey')),
    sale('client:a', '2026-07-25T00:00:00.000Z', line('Rojo', '30', 'Piqué')),
    sale('client:c', '2026-01-02T00:00:00.000Z', line('Blanco', '24', 'Jersey')), // too old
    sale(null,       '2026-07-22T00:00:00.000Z', line('Gris', '30', 'Jersey')),   // walk-in
  ];
  const SINCE = '2026-03-01T00:00:00.000Z';

  it('finds the clients who bought that cloth, most recent first', () => {
    expect(clientsWhoBought(sales, 'Jersey', SINCE)).toEqual(['client:b', 'client:a']);
  });

  it('matches the fabric however it was spelled or accented', () => {
    expect(clientsWhoBought(sales, 'JERSEY', SINCE)).toEqual(['client:b', 'client:a']);
    expect(clientsWhoBought(sales, 'pique', SINCE)).toEqual(['client:a']);
  });

  it('ignores walk-ins and anything outside the window', () => {
    const found = clientsWhoBought(sales, 'Jersey', SINCE);
    expect(found).not.toContain('client:c'); // bought in January
    expect(found).toHaveLength(2);           // the null-client sale is not a target
  });

  it('returns nothing for a cloth nobody has bought', () => {
    expect(clientsWhoBought(sales, 'Interlock', SINCE)).toEqual([]);
  });
});
