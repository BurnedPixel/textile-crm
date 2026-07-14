// CouchDB validate_doc_update — the REAL enforcement boundary (layer 2 of 2).
// Runs on every write that lands on a node, including replicated ones, so a buggy
// client that skips the local validation wrapper still cannot persist bad docs.
// Keep this identical on the cloud node AND the Pi node.
//
// Enforces:
//   1. No derived fields (totalBs / amountBs) — they are computed on read, never stored.
//   2. Only authenticated users with the app role (or server admins) may write.
//   3. Sale/Expense/InventoryMovement are append-only — a role member may create them
//      but never mutate an existing one (historical records never change; the "cannot
//      conflict by construction" invariant depends on existing ids being un-writable).
//
// Deployed as the `validate_doc_update` member of a design doc (see setup.sh).

function (newDoc, oldDoc, userCtx, secObj) {
  // Server admins bypass all checks (needed for replication + conflict-resolution deletes).
  var roles = (userCtx && userCtx.roles) || [];
  function hasRole(r) {
    return roles.indexOf(r) !== -1;
  }
  // __APP_ROLE__ is substituted from .env (APP_ROLE) by couch/setup.sh at deploy.
  var APP_ROLE = '__APP_ROLE__';
  var isAdmin = hasRole('_admin');
  if (!isAdmin && !hasRole(APP_ROLE)) {
    throw { forbidden: 'No autorizado: se requiere el rol "' + APP_ROLE + '".' };
  }

  // Immutable append-only docs: reject any write over an existing id (create-only).
  // Admins bypass so conflict resolution can delete stale counter revs, etc.
  if (!isAdmin && oldDoc && /^(sale|expense|movement):/.test(newDoc._id)) {
    throw { forbidden: 'Registro inmutable: no se puede modificar una venta, gasto o movimiento existente.' };
  }

  // Deletions carry no business fields to validate.
  if (newDoc._deleted) return;

  var FORBIDDEN = ['totalBs', 'amountBs'];
  for (var i = 0; i < FORBIDDEN.length; i++) {
    if (Object.prototype.hasOwnProperty.call(newDoc, FORBIDDEN[i])) {
      throw {
        forbidden:
          'Campo derivado no permitido: "' +
          FORBIDDEN[i] +
          '" se calcula al mostrar y nunca se guarda.',
      };
    }
  }
}
