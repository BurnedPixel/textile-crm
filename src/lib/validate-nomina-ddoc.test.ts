// The nómina database has its own server validator (couch/validate_nomina.js).
// Same harness as validate-ddoc.test.ts: load the shipped file verbatim, apply
// the same __APP_ROLE__ substitution setup.sh applies, and assert the rules
// against it — the admin-only gate on salaries is not something to discover in
// production.
import { describe, it, expect } from 'vitest';
import rawSource from '../../couch/validate_nomina.js?raw';

const APP_ROLE = 'ml-textiles';
const ADMIN = `${APP_ROLE}-admin`;
const OPERADOR = `${APP_ROLE}-operador`;

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
const serverAdmin = ['_admin'];

const WORKER: Doc = {
  _id: 'worker:v-12345678',
  type: 'worker',
  documentId: 'V-12345678',
  name: 'ANA PEREZ',
  active: true,
  concepts: [{ label: 'Salario', amountUsd: 40, frequency: 'WEEKLY' }],
  updatedAt: '2026-08-17T10:00:00.000Z',
};
const PAY: Doc = {
  _id: 'payrollpay:2026-08-17T10:00:00.000Z:u1',
  type: 'payrollpay',
  payId: 'u1',
  workerId: 'worker:v-12345678',
  date: '2026-08-17T10:00:00.000Z',
  entryMethod: 'CASH',
  exchangeRateBCV: 36.5,
  lines: [{ label: 'Salario', amountUsd: 40, periodKey: '2026-W34' }],
  totalUsd: 40,
  operatorId: 'daniel',
};

describe('validate_nomina — who may write', () => {
  it('accepts the app admin role and the server admin', () => {
    expect(run(WORKER, null, admin)).toBeNull();
    expect(run(PAY, null, admin)).toBeNull();
    expect(run(WORKER, null, serverAdmin)).toBeNull();
  });

  it('rejects every non-admin — nómina is admin-only end to end', () => {
    // _security already keeps these users out of the database; this is the belt.
    for (const roles of [[], ['otra-app'], base, operador]) {
      expect(run(WORKER, null, roles), JSON.stringify(roles)).toMatch(/administrador/);
      expect(run(PAY, null, roles), JSON.stringify(roles)).toMatch(/administrador/);
    }
  });

  it('names the concrete role in the message (so a misrolled account is diagnosable)', () => {
    expect(run(WORKER, null, operador)).toContain(ADMIN);
  });
});

describe('validate_nomina — immutability', () => {
  it('rejects any rewrite of an existing payrollpay', () => {
    expect(run(PAY, PAY, admin)).toMatch(/inmutable/);
    expect(run({ ...PAY, totalUsd: 999 }, PAY, admin)).toMatch(/inmutable/);
  });

  it('exempts only the server admin (maintenance / conflict cleanup)', () => {
    expect(run(PAY, PAY, serverAdmin)).toBeNull();
  });

  it('allows updating a worker — workers are mutable by design', () => {
    expect(run({ ...WORKER, active: false }, WORKER, admin)).toBeNull();
  });

  it('lets the admin delete a worker rev (conflict watcher) but not a payrollpay', () => {
    expect(run({ _id: WORKER._id, _deleted: true } as Doc, WORKER, admin)).toBeNull();
    expect(run({ _id: PAY._id, _deleted: true } as Doc, PAY, admin)).toMatch(/inmutable/);
  });
});

describe('validate_nomina — derived money is never stored', () => {
  it('rejects totalBs / amountBs whoever writes them', () => {
    expect(run({ ...PAY, totalBs: 1460 }, null, admin)).toMatch(/totalBs/);
    expect(run({ ...WORKER, amountBs: 1 }, null, admin)).toMatch(/amountBs/);
    expect(run({ ...PAY, totalBs: 1460 }, null, serverAdmin)).toMatch(/totalBs/);
  });
});

describe('validate_nomina — worker shape', () => {
  it('requires a documentId and a name', () => {
    expect(run({ ...WORKER, documentId: '' }, null, admin)).toMatch(/cédula/);
    expect(run({ ...WORKER, name: undefined }, null, admin)).toMatch(/nombre/);
    expect(run({ ...WORKER, name: 42 }, null, admin)).toMatch(/nombre/);
  });

  it('requires concepts to be a list of at most 20', () => {
    expect(run({ ...WORKER, concepts: undefined }, null, admin)).toMatch(/conceptos/);
    expect(run({ ...WORKER, concepts: 'Salario' }, null, admin)).toMatch(/conceptos/);
    const many = Array.from({ length: 21 }, () => ({ label: 'x', amountUsd: 1, frequency: 'WEEKLY' }));
    expect(run({ ...WORKER, concepts: many }, null, admin)).toMatch(/conceptos/);
    expect(run({ ...WORKER, concepts: [] }, null, admin)).toBeNull(); // a worker with no concepts is legal
  });

  it('rejects a non-finite or non-positive salary — Infinity is the one that can never be corrected', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '40', null, undefined]) {
      expect(
        run({ ...WORKER, concepts: [{ label: 'Salario', amountUsd: bad, frequency: 'WEEKLY' }] }, null, admin),
        String(bad),
      ).toMatch(/monto/);
    }
  });

  it('rejects a frequency outside WEEKLY|MONTHLY', () => {
    for (const bad of ['DAILY', 'weekly', '', undefined]) {
      expect(
        run({ ...WORKER, concepts: [{ label: 'Salario', amountUsd: 40, frequency: bad }] }, null, admin),
        String(bad),
      ).toMatch(/frecuencia/);
    }
    expect(run({ ...WORKER, concepts: [{ label: 'Utilidades', amountUsd: 40, frequency: 'MONTHLY' }] }, null, admin))
      .toBeNull();
  });
});

describe('validate_nomina — payrollpay shape', () => {
  it('rejects a non-finite or non-positive total', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '40', null, undefined]) {
      expect(run({ ...PAY, totalUsd: bad }, null, admin), String(bad)).toMatch(/total/);
    }
  });

  it('rejects a non-finite or non-positive BCV rate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '36,5', null, undefined]) {
      expect(run({ ...PAY, exchangeRateBCV: bad }, null, admin), String(bad)).toMatch(/tasa BCV/);
    }
  });

  it('requires between 1 and 40 lines', () => {
    expect(run({ ...PAY, lines: [] }, null, admin)).toMatch(/líneas/);
    expect(run({ ...PAY, lines: undefined }, null, admin)).toMatch(/líneas/);
    const many = Array.from({ length: 41 }, () => ({ label: 'x', amountUsd: 1, periodKey: '2026-W34' }));
    expect(run({ ...PAY, lines: many }, null, admin)).toMatch(/líneas/);
  });

  it('applies the shape rules to the server admin too — a bad doc is bad whoever writes it', () => {
    expect(run({ ...PAY, totalUsd: Number.POSITIVE_INFINITY }, null, serverAdmin)).toMatch(/total/);
  });

  it('ignores unknown ids (nothing else is written to this database yet)', () => {
    expect(run({ _id: '_local/checkpoint', foo: 1 } as Doc, null, admin)).toBeNull();
  });
});
