import { describe, it, expect } from 'vitest';
import { buildNotaPdf } from './nota-pdf';
import type { ClientDoc, FiscalConfigDoc, SaleDoc } from './types';

const sale: SaleDoc = {
  _id: 'sale:2026-08-16T10:00:00.000Z:tx-abc12345',
  type: 'sale',
  transactionId: 'tx-abc12345',
  clientId: 'client:v-1',
  date: '2026-08-16T10:00:00.000Z',
  isOnTheBooks: true,
  exchangeRateBCV: 40,
  totalUsd: 100,
  paidUsdCash: 50,
  paidUsdTransfer: 0,
  paidBs: 0,
  paymentStatus: 'PARTIAL',
  creditTerms: '15 días',
  ivaRate: 0.16,
  igtfRate: 0.03,
  lineItems: [
    {
      productId: 'product:batch:x:R1',
      batchId: 'batch:x',
      description: 'Azul rey · NM 30 · Jersey · R1 · Lote 4471',
      quantity: 10,
      unitOfMeasure: 'Kg',
      unitPriceAtSale: 10,
      lineSubtotalUsd: 100,
    },
  ],
};

const client: ClientDoc = {
  _id: 'client:v-1',
  type: 'client',
  documentId: 'V-1',
  entityType: 'PERSON',
  name: 'Juan Pérez',
  address: 'Av. Principal',
  phoneNumber: '',
  email: '',
  specialty: [],
  updatedAt: '2026-08-16T10:00:00.000Z',
};

const fiscal: FiscalConfigDoc = {
  _id: 'config:fiscal',
  type: 'config',
  businessName: 'ML Textiles',
  taxId: 'J-12345678-9',
  address: 'Zona Industrial',
  lastUpdate: '2026-08-16T10:00:00.000Z',
};

describe('buildNotaPdf', () => {
  it('returns a valid PDF ArrayBuffer', () => {
    const buf = buildNotaPdf(sale, client, fiscal);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    const head = new TextDecoder('latin1').decode(buf.slice(0, 5));
    expect(head).toBe('%PDF-');
    expect(buf.byteLength).toBeGreaterThan(2000);
  });

  it('does not throw with no client and no fiscal config', () => {
    const buf = buildNotaPdf(sale, null, null);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder('latin1').decode(buf.slice(0, 5))).toBe('%PDF-');
  });

  it('embeds the nota heading text (uncompressed jsPDF text streams)', () => {
    const buf = buildNotaPdf(sale, client, fiscal);
    const text = new TextDecoder('latin1').decode(buf);
    expect(text).toContain('NOTA DE ENTREGA');
  });
});
