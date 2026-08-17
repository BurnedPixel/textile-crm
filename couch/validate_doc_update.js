// CouchDB validate_doc_update — the REAL enforcement boundary (layer 2 of 2).
// Runs on every write that lands on a node, including replicated ones, so a buggy
// client that skips the local validation wrapper still cannot persist bad docs.
// Keep this identical on the cloud node AND the Pi node.
//
// Enforces:
//   1. No derived fields (totalBs / amountBs) — they are computed on read, never stored.
//   2. Only authenticated users with the app role (or server admins) may write.
//   3. Sale/Payment/Refund/Expense/InventoryMovement are append-only — a role member may create
//      them but never mutate an existing one (historical records never change; the "cannot
//      conflict by construction" invariant depends on existing ids being un-writable).
//      A new prefix is NOT append-only just by being named that — it has to be listed
//      in the regex below, and this file re-pushed with setup.sh on every node.
//   4. Function roles (2026-08-17): the base role only grants SYNC. Writing needs
//      `-operador` (or `-admin`); configuration needs `-admin`; the rate docs also
//      accept the `-rates` service role used by the VPS timer.
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
  if (!isAdmin && oldDoc && /^(sale|payment|expense|movement|refund):/.test(newDoc._id)) {
    throw { forbidden: 'Registro inmutable: no se puede modificar una venta, cobro, vuelto, gasto o movimiento existente.' };
  }

  // Deletions carry no business fields to validate.
  if (newDoc._deleted) return;

  // ── Function roles ────────────────────────────────────────────────────────
  // Derived from APP_ROLE so setup.sh keeps its single substitution.
  var ADMIN_ROLE = APP_ROLE + '-admin';
  var OPERADOR_ROLE = APP_ROLE + '-operador';
  var RATES_ROLE = APP_ROLE + '-rates'; // service role: the VPS rate timer, nothing else.
  //
  // PLACEMENT IS LOAD-BEARING: this block sits AFTER the `_deleted` early return.
  // Conflict resolution (src/lib/conflicts.ts) deletes losing revs of
  // batch:/product:/client:/config: docs on EVERY device, under whatever user is
  // logged in there — if deletions needed a function role the watcher would die on
  // operador devices and the cached counters would drift with nothing on screen
  // looking wrong. So deletions keep needing only the base role. Deleting an
  // append-only doc is already rejected above (oldDoc + sale|payment|… prefix),
  // so the exemption only reaches the doc types the watcher owns.
  if (!isAdmin) {
    var isAppAdmin = hasRole(ADMIN_ROLE);
    var id = newDoc._id || '';
    if (id === 'config:system' || id.indexOf('rate:') === 0) {
      // The timer writes BOTH every morning (vps/bcv-rates.py); in the app a
      // manual rate change is admin-only.
      if (!isAppAdmin && !hasRole(RATES_ROLE)) {
        throw { forbidden: 'Se requiere el rol de administrador para cambiar la tasa del día.' };
      }
    } else if (id.indexOf('config:') === 0) {
      // Tasa aparte: fiscal, catálogo, carta de colores, listas de precios.
      if (!isAppAdmin) {
        throw { forbidden: 'Se requiere el rol de administrador para cambiar la configuración.' };
      }
    } else if (!isAppAdmin && !hasRole(OPERADOR_ROLE)) {
      // Everything else — ventas, cobros, vueltos, gastos, movimientos, clientes,
      // artículos, rollos, and any future prefix: operador or admin.
      // The service role falls in here too, and that is deliberate: it must NOT be
      // able to write operational documents.
      throw { forbidden: 'Se requiere el rol de operador para registrar cambios.' };
    }
  }

  // config:system is read at every checkout on every device — one junk rate
  // replicates everywhere and breaks every terminal. The app's saveDailyRate
  // asserts this locally; this guards replicated and hand-crafted writes.
  if (newDoc._id === 'config:system') {
    var rate = newDoc.currentDailyRateBCV;
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
      throw { forbidden: 'config:system: currentDailyRateBCV debe ser un número finito y positivo.' };
    }
  }

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
