// The SERVER validator (couch/validate_doc_update.js) is the real trust boundary —
// it is the only layer that sees replicated writes from devices whose local code
// nobody controls. It used to have no test at all: this file loads the shipped
// source (the same one setup.sh pushes, with the same __APP_ROLE__ substitution)
// and asserts the whole role matrix against it, so a role rule cannot be lost in
// an edit and discovered in production.
import { describe, it, expect } from 'vitest';
// ?raw so the shipped file is loaded verbatim, exactly as setup.sh reads it
// (and without needing @types/node just for a readFileSync).
import rawSource from '../../couch/validate_doc_update.js?raw';

const APP_ROLE = 'ml-textiles';
const ADMIN = `${APP_ROLE}-admin`;
const OPERADOR = `${APP_ROLE}-operador`;
const RATES = `${APP_ROLE}-rates`;

type Doc = Record<string, unknown> & { _id: string };
type UserCtx = { name: string; roles: string[] };
type ValidateFn = (newDoc: Doc, oldDoc: Doc | null, userCtx: UserCtx, secObj: unknown) => void;

const source = rawSource.replaceAll('__APP_ROLE__', APP_ROLE);

const validate = new Function(`return (${source})`)() as ValidateFn;

/** Runs the validator; returns the Spanish `forbidden` message, or null when it allows the write. */
function run(doc: Doc, oldDoc: Doc | null, roles: string[]): string | null {
  try {
    validate(doc, oldDoc, { name: 'u', roles }, {});
    return null;
  } catch (e) {
    return (e as { forbidden?: string }).forbidden ?? String(e);
  }
}

const base = [APP_ROLE];
const operador = [APP_ROLE, OPERADOR];
const admin = [APP_ROLE, ADMIN];
const rates = [APP_ROLE, RATES];
const serverAdmin = ['_admin'];

const SALE: Doc = { _id: 'sale:2026-08-17T10:00:00Z:tx1', type: 'sale', totalUsd: 10 };
const OPERATIONAL: Doc[] = [
  SALE,
  { _id: 'payment:2026-08-17T10:00:00Z:u1', type: 'payment', paidUsdCash: 5 },
  { _id: 'refund:2026-08-17T10:00:00Z:u1', type: 'refund', givenUsdCash: 5 },
  { _id: 'expense:2026-08-17T10:00:00Z:u1', type: 'expense', amountUsd: 5 },
  { _id: 'movement:2026-08-17T10:00:00Z:u1', type: 'movement', lineItems: [] },
  { _id: 'client:V-12345678', type: 'client', name: 'ANA' },
  { _id: 'batch:azul:30:jersey', type: 'batch', currentUnits: 2 },
  { _id: 'product:batch:azul:30:jersey:R3', type: 'product', currentWeightKg: 12 },
];
const RATE_DOC: Doc = { _id: 'rate:2026-08-17', type: 'rate', bsPerUsd: 36.5 };
const CONFIG_SYSTEM: Doc = { _id: 'config:system', type: 'config', currentDailyRateBCV: 36.5 };
const CONFIG_FISCAL: Doc = { _id: 'config:fiscal', type: 'config', businessName: 'ML', lastUpdate: 'x' };

describe('validate_doc_update — base role', () => {
  it('rejects a user without the base role at all', () => {
    expect(run(SALE, null, [])).toMatch(/No autorizado/);
    expect(run(SALE, null, ['otra-app'])).toMatch(/No autorizado/);
  });

  it('no longer lets a base-role-only user create a sale (the intended tightening)', () => {
    // Every real user gets a function role in the one-time migration before this
    // ddoc ships; a device left with only the sync role can read/replicate, not write.
    expect(run(SALE, null, base)).toMatch(/operador/);
  });

  it('still lets the base role DELETE a batch — the conflict watcher runs on every device', () => {
    expect(run({ _id: 'batch:azul:30:jersey', _deleted: true } as Doc, null, base)).toBeNull();
    expect(run({ _id: 'product:batch:azul:30:jersey:R3', _deleted: true } as Doc, null, base)).toBeNull();
    expect(run({ _id: 'client:V-12345678', _deleted: true } as Doc, null, base)).toBeNull();
    // config: losers too — keepBy() in conflicts.ts resolves them by deleting only.
    expect(run({ _id: 'config:fiscal', _deleted: true } as Doc, null, base)).toBeNull();
  });
});

describe('validate_doc_update — operador', () => {
  it('creates every operational document', () => {
    for (const doc of OPERATIONAL) expect(run(doc, null, operador), doc._id).toBeNull();
  });

  it('cannot touch configuration or the daily rate', () => {
    expect(run(CONFIG_SYSTEM, null, operador)).toMatch(/administrador/);
    expect(run(CONFIG_FISCAL, null, operador)).toMatch(/administrador/);
    expect(run(RATE_DOC, null, operador)).toMatch(/administrador/);
  });

  it('still cannot mutate an append-only document', () => {
    expect(run(SALE, SALE, operador)).toMatch(/inmutable/);
    expect(run(OPERATIONAL[1], OPERATIONAL[1], operador)).toMatch(/inmutable/);
  });
});

describe('validate_doc_update — rates service role', () => {
  it('writes the rate docs the timer produces', () => {
    expect(run(RATE_DOC, null, rates)).toBeNull();
    expect(run(CONFIG_SYSTEM, null, rates)).toBeNull();
  });

  it('has NO operational write access', () => {
    expect(run(SALE, null, rates)).toMatch(/operador/);
    expect(run(OPERATIONAL[6], null, rates)).toMatch(/operador/); // batch:
  });

  it('cannot touch other configuration', () => {
    expect(run(CONFIG_FISCAL, null, rates)).toMatch(/administrador/);
  });
});

describe('validate_doc_update — admin', () => {
  it('does everything the other roles can', () => {
    for (const doc of [...OPERATIONAL, RATE_DOC, CONFIG_SYSTEM, CONFIG_FISCAL]) {
      expect(run(doc, null, admin), doc._id).toBeNull();
    }
  });

  it('is NOT exempt from immutability — only the server admin is', () => {
    expect(run(SALE, SALE, admin)).toMatch(/inmutable/);
    expect(run(SALE, SALE, serverAdmin)).toBeNull();
  });
});

describe('validate_doc_update — document rules survive the role checks', () => {
  it('rejects derived fields whoever writes them', () => {
    expect(run({ ...SALE, totalBs: 365 }, null, admin)).toMatch(/totalBs/);
    expect(run({ _id: 'expense:2026-08-17T10:00:00Z:u1', amountBs: 1 }, null, operador)).toMatch(/amountBs/);
    expect(run({ ...SALE, totalBs: 365 }, null, serverAdmin)).toMatch(/totalBs/);
  });

  it('rejects a non-finite or non-positive daily rate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '36,5', null, undefined]) {
      expect(run({ ...CONFIG_SYSTEM, currentDailyRateBCV: bad }, null, admin), String(bad))
        .toMatch(/currentDailyRateBCV/);
    }
    // …including from the service role, which is the only non-human writer.
    expect(run({ ...CONFIG_SYSTEM, currentDailyRateBCV: 0 }, null, rates)).toMatch(/currentDailyRateBCV/);
  });
});
