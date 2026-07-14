// Test-only DB factory: PouchDB + memory adapter, with the validation plugin
// registered exactly like db.ts does (so tests exercise the real write guard).
// Not imported by any app code.

import PouchDB from 'pouchdb';
import memory from 'pouchdb-adapter-memory';
import { registerValidation } from './validation';

PouchDB.plugin(memory);
registerValidation(PouchDB as unknown as PouchDB.Static);

let counter = 0;

/** Fresh in-memory database, unique name per call. */
export function makeTestDb(): PouchDB.Database {
  return new PouchDB(`test-${Date.now()}-${counter++}`, { adapter: 'memory' });
}
