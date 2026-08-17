// The field rules are the contract both client forms rely on — if these drift,
// one form starts accepting what the other rejects (which is what they did before).
import { describe, it, expect } from 'vitest';
import {
  assertAmount,
  normalizeDocumentId,
  normalizePhone,
  validateDocumentId,
  validateEmail,
  validateName,
  validatePhone,
  validateUsername,
} from './types';
import { saveClient } from './queries';
import { makeTestDb } from './testdb';

describe('validateDocumentId', () => {
  it('accepts the real Venezuelan shapes', () => {
    for (const ok of ['V-12345678', 'v12345678', 'J-40123456-7', 'E-81234567', 'G-200012345', 'V-9876543', 'P-1234567']) {
      expect(validateDocumentId(ok), ok).toBeNull();
    }
  });

  it('ignores cosmetic separators and spacing', () => {
    expect(validateDocumentId('  V-12.345.678  ')).toBeNull();
  });

  it('rejects what cannot be a document', () => {
    // The prefix letter is REQUIRED now (user rule 2026-08-16) — a bare cédula
    // number without V/E/J/G/P is no longer a valid id to type.
    for (const bad of ['', 'hola', 'V-', '1234', '12345678', 'Z-12345678', 'V-123456789012345', '12345678@', 'V 12 AB']) {
      expect(validateDocumentId(bad), bad).not.toBeNull();
    }
  });
});

describe('validateName', () => {
  it('accepts names, including company names carrying digits', () => {
    for (const ok of ['José Pérez', 'Textiles 2000 C.A.', "O'Brien", 'Ñuñez-Díaz']) {
      expect(validateName(ok), ok).toBeNull();
    }
  });

  it('rejects a name with no letters at all', () => {
    for (const bad of ['', ' ', '12345', '---', '###']) {
      expect(validateName(bad), bad).not.toBeNull();
    }
  });

  it('rejects a pasted document', () => {
    expect(validateName('x'.repeat(200))).toMatch(/120 caracteres/);
  });
});

describe('validateUsername', () => {
  it('accepts lowercase names with the allowed punctuation', () => {
    for (const ok of ['jperez', 'j.perez', 'j_perez-2', 'abc']) {
      expect(validateUsername(ok), ok).toBeNull();
    }
  });

  it('rejects empty, too short, too long, and non-lowercase input', () => {
    for (const bad of ['', 'jp', 'x'.repeat(41), 'JPerez', 'j perez', 'jpérez']) {
      expect(validateUsername(bad), bad).not.toBeNull();
    }
  });
});

describe('validatePhone', () => {
  it('accepts local and international forms', () => {
    for (const ok of ['0412-1234567', '04121234567', '+58 412 1234567', '(0243) 765-4321', '0243.765.4321']) {
      expect(validatePhone(ok), ok).toBeNull();
    }
  });

  it('is optional', () => {
    expect(validatePhone('')).toBeNull();
    expect(validatePhone('   ')).toBeNull();
  });

  it('rejects text and impossible lengths', () => {
    for (const bad of ['llámame', '0412-ABCDEFG', '123', '7654321', '12345678901234567890']) {
      expect(validatePhone(bad), bad).not.toBeNull();
    }
  });

  it('treats a bare «+58» autofill (or a lone +) as empty, not as an error', () => {
    expect(validatePhone('+58 ')).toBeNull();
    expect(validatePhone('+')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('canonicalizes to +<cc><digits>', () => {
    expect(normalizePhone('0412-1234567')).toBe('+584121234567');
    expect(normalizePhone('4121234567')).toBe('+584121234567');
    expect(normalizePhone('+58 412 1234567')).toBe('+584121234567');
    expect(normalizePhone('+1 (305) 555-0100')).toBe('+13055550100');
  });

  it('empty and untouched-autofill inputs mean «no phone»', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('+58 ')).toBe('');
    expect(normalizePhone('+')).toBe('');
  });

  it('what cannot be a phone is null, never a guess', () => {
    for (const bad of ['abc', '123', '7654321', '+58abc']) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });
});

describe('validateEmail', () => {
  it('accepts an address and stays optional', () => {
    expect(validateEmail('a@b.co')).toBeNull();
    expect(validateEmail('')).toBeNull();
  });
  it('rejects a non-address', () => {
    for (const bad of ['a@b', 'a b@c.co', '@b.co', 'nope']) {
      expect(validateEmail(bad), bad).not.toBeNull();
    }
  });
});

describe('assertAmount', () => {
  it('rejects Infinity, which passes a bare `> 0` check', () => {
    expect(() => assertAmount(Infinity, 'X')).toThrow(/no es un número válido/);
    expect(Infinity > 0).toBe(true); // ...which is exactly why the guard exists
  });

  it('rejects NaN, zero and negatives by default', () => {
    expect(() => assertAmount(NaN, 'X')).toThrow(/no es un número válido/);
    expect(() => assertAmount(0, 'X')).toThrow(/mayor que cero/);
    expect(() => assertAmount(-1, 'X')).toThrow(/mayor que cero/);
  });

  it('allowZero permits 0 but never a negative', () => {
    expect(() => assertAmount(0, 'X', { allowZero: true })).not.toThrow();
    expect(() => assertAmount(-0.01, 'X', { allowZero: true })).toThrow(/no puede ser negativo/);
  });

  it('rejects an absurd magnitude', () => {
    expect(() => assertAmount(1e13, 'X')).toThrow(/demasiado grande/);
  });
});

describe('saveClient — the same rules apply at the module boundary', () => {
  it('rejects a bad phone even though the field is optional', async () => {
    const db = makeTestDb();
    await expect(
      saveClient(db, { documentId: 'V-12345678', name: 'Ana', phoneNumber: 'llámame' }),
    ).rejects.toThrow(/Teléfono inválido/);
  });

  it('rejects a name that is only digits', async () => {
    const db = makeTestDb();
    await expect(saveClient(db, { documentId: 'V-12345678', name: '999' })).rejects.toThrow(/letras/);
  });

  it('caps the specialty array instead of storing whatever it is handed', async () => {
    const db = makeTestDb();
    const saved = await saveClient(db, {
      documentId: 'V-12345678',
      name: 'Ana',
      specialty: Array.from({ length: 50 }, (_, i) => `esp${i}`),
    });
    expect(saved.specialty).toHaveLength(10);
  });

  it('stores a valid client unchanged', async () => {
    const db = makeTestDb();
    const saved = await saveClient(db, {
      documentId: 'J-40123456-7',
      name: 'Textiles 2000 C.A.',
      phoneNumber: '+58 412 1234567',
      email: 'ventas@textiles.co',
    });
    expect(saved.documentId).toBe('J-40123456-7');
    // Stored canonically: caps name, +cc phone (user rule 2026-08-16).
    expect(saved.name).toBe('TEXTILES 2000 C.A.');
    expect(saved.phoneNumber).toBe('+584121234567');
  });

  it('normalizes a sloppy documentId when CREATING', async () => {
    const db = makeTestDb();
    const saved = await saveClient(db, { documentId: ' v12345678 ', name: 'Ana' });
    expect(saved.documentId).toBe('V-12345678');
    expect(saved._id).toBe('client:v-12345678');
    // ...and a later variant of the same document converges on the same doc.
    const again = await saveClient(db, { documentId: 'V-12.345.678', name: 'Ana María' });
    expect(again._id).toBe(saved._id);
  });

  it('rejects a prefix-less id on create, but never re-keys a legacy doc', async () => {
    const db = makeTestDb();
    await expect(saveClient(db, { documentId: '12345678', name: 'Ana' })).rejects.toThrow(/V\/E\/J\/G\/P/);
    // A legacy doc whose stored id predates the format rule stays editable and
    // keeps its _id verbatim — normalizing it would orphan its sales.
    await db.put({
      _id: 'client:v42042069', type: 'client', documentId: 'V42042069',
      entityType: 'PERSON', name: 'Legacy', address: '', phoneNumber: '', email: '',
      specialty: [], updatedAt: new Date().toISOString(),
    });
    const edited = await saveClient(db, { documentId: 'V42042069', name: 'Legacy Edited', address: 'Calle 1' });
    expect(edited._id).toBe('client:v42042069');
    expect(edited.documentId).toBe('V42042069');
    expect(edited.name).toBe('LEGACY EDITED');
  });
});
