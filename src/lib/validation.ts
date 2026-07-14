// Local validation layer (layer 1 of 2 — see CLAUDE.md).
// PouchDB does not run validate_doc_update on local writes, so we wrap bulkDocs
// (put/post route through the instance's bulkDocs internally) and reject documents
// carrying DERIVED fields that must never be persisted. The CouchDB design doc
// (couch/validate_doc_update.js) is the real enforcement boundary on replication.
//
// PouchDB assigns bulkDocs as an OWN instance property inside the constructor
// (`this.bulkDocs = adapterFun(...)`), so patching the prototype method directly
// does nothing. Instead we install a prototype getter/setter for `bulkDocs`: when
// the constructor sets it per instance, the setter wraps the real function once.
// This catches every write path (put/post/bulkDocs) for every instance.

// Derived, computed-on-read fields — writing them to the DB is a bug.
const FORBIDDEN_FIELDS = ['totalBs', 'amountBs'] as const;

/** Spanish because it can surface as a notification, though it signals a code bug. */
const forbiddenMessage = (field: string): string =>
  `Campo derivado no permitido: "${field}" se calcula al mostrar y nunca se guarda.`;

function assertNoForbiddenFields(doc: unknown): void {
  if (!doc || typeof doc !== 'object') return;
  for (const field of FORBIDDEN_FIELDS) {
    if (field in (doc as Record<string, unknown>)) {
      throw new Error(forbiddenMessage(field));
    }
  }
}

type BulkDocsFn = (docsArg: unknown, ...rest: unknown[]) => unknown;

function wrap(original: BulkDocsFn): BulkDocsFn {
  return function patchedBulkDocs(this: unknown, docsArg: unknown, ...rest: unknown[]) {
    // bulkDocs accepts either an array or a { docs: [...] } wrapper.
    const docs = Array.isArray(docsArg)
      ? docsArg
      : (docsArg as { docs?: unknown[] } | null)?.docs;
    // Reject as a promise (not a sync throw) so put/post/bulkDocs all surface the
    // failure the same way callers expect — via .catch / await rejection.
    if (Array.isArray(docs)) {
      const callback = rest.find((a) => typeof a === 'function') as
        | ((err: unknown) => void)
        | undefined;
      try {
        for (const doc of docs) assertNoForbiddenFields(doc);
      } catch (err) {
        if (callback) return callback(err);
        return Promise.reject(err);
      }
    }
    return original.call(this, docsArg, ...rest);
  };
}

/**
 * Register the validation plugin on a PouchDB constructor. Idempotent per ctor.
 * Installs a getter/setter for `bulkDocs` on the prototype so every instance's
 * per-construction assignment is wrapped exactly once.
 */
export function registerValidation(PouchDBCtor: PouchDB.Static): void {
  const proto = (PouchDBCtor as unknown as { prototype: Record<string, unknown> }).prototype;
  if (proto.__crmValidationWrapped) return;
  proto.__crmValidationWrapped = true;

  // Per-instance storage key for the wrapped fn (own property, avoids proto clashes).
  const SLOT = '__crmBulkDocs';
  Object.defineProperty(proto, 'bulkDocs', {
    configurable: true,
    get(this: Record<string, unknown>) {
      return this[SLOT];
    },
    set(this: Record<string, unknown>, fn: BulkDocsFn) {
      this[SLOT] = wrap(fn);
    },
  });
}
