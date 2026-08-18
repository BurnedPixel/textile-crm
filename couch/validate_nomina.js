// CouchDB validate_doc_update for the NÓMINA database (`${APP_DB}-nomina`).
// Salaries live in their own database whose `_security` admits only the
// `__APP_ROLE__-admin` role — no vendedor device ever replicates it. This
// validator is the belt over that suspender: it re-checks the role on every
// write that lands on a node (including replicated ones), so a misconfigured
// `_security` alone cannot expose payroll writes.
//
// Enforces:
//   1. Only server admins and `__APP_ROLE__-admin` may write. There is no
//      operador tier here — nómina is admin-only end to end.
//   2. `payrollpay:` documents are append-only (a payment is a historical
//      record; the idempotency key lives in its _id).
//   3. No derived fields (totalBs / amountBs) — concepts are USD-only and Bs is
//      computed at render from the rate locked on the document.
//   4. Shape checks on both doc types, so a buggy client cannot persist a
//      worker with an infinite salary or a payment with no lines.
//
// Deployed as the `validate_doc_update` member of `_design/validation` in the
// nómina database (see setup.sh). Keep it identical on the cloud node AND the Pi.

function (newDoc, oldDoc, userCtx, secObj) {
  var roles = (userCtx && userCtx.roles) || [];
  function hasRole(r) {
    return roles.indexOf(r) !== -1;
  }
  // __APP_ROLE__ is substituted from .env (APP_ROLE) by couch/setup.sh at deploy.
  var APP_ROLE = '__APP_ROLE__';
  var ADMIN_ROLE = APP_ROLE + '-admin';
  var isAdmin = hasRole('_admin');
  if (!isAdmin && !hasRole(ADMIN_ROLE)) {
    throw { forbidden: 'Nómina: se requiere el rol de administrador ("' + ADMIN_ROLE + '").' };
  }

  // Append-only: a payroll payment is never rewritten. Admins bypass so
  // conflict/maintenance cleanup stays possible (same exemption as the main db).
  if (!isAdmin && oldDoc && /^payrollpay:/.test(newDoc._id)) {
    throw { forbidden: 'Registro inmutable: no se puede modificar un pago de nómina existente.' };
  }

  // Deletions carry no business fields to validate. Placement matters: the
  // conflict watcher deletes losing `worker:` revs on whatever admin device
  // resolved them, and that must keep working.
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

  function isPositiveNumber(v) {
    return typeof v === 'number' && isFinite(v) && v > 0;
  }
  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
  }

  var id = newDoc._id || '';

  if (id.indexOf('worker:') === 0) {
    if (!isNonEmptyString(newDoc.documentId) || !isNonEmptyString(newDoc.name)) {
      throw { forbidden: 'Trabajador: cédula/RIF y nombre son obligatorios.' };
    }
    var concepts = newDoc.concepts;
    if (!Array.isArray(concepts) || concepts.length > 20) {
      throw { forbidden: 'Trabajador: los conceptos deben ser una lista de 20 como máximo.' };
    }
    for (var c = 0; c < concepts.length; c++) {
      var concept = concepts[c] || {};
      if (!isPositiveNumber(concept.amountUsd)) {
        throw { forbidden: 'Trabajador: cada concepto necesita un monto en dólares finito y mayor que cero.' };
      }
      if (concept.frequency !== 'WEEKLY' && concept.frequency !== 'MONTHLY') {
        throw { forbidden: 'Trabajador: la frecuencia de cada concepto debe ser semanal o mensual.' };
      }
    }
  }

  if (id.indexOf('payrollpay:') === 0) {
    if (!isPositiveNumber(newDoc.totalUsd)) {
      throw { forbidden: 'Pago de nómina: el total en dólares debe ser finito y mayor que cero.' };
    }
    if (!isPositiveNumber(newDoc.exchangeRateBCV)) {
      throw { forbidden: 'Pago de nómina: la tasa BCV debe ser finita y mayor que cero.' };
    }
    if (!Array.isArray(newDoc.lines) || newDoc.lines.length < 1 || newDoc.lines.length > 40) {
      throw { forbidden: 'Pago de nómina: debe tener entre 1 y 40 líneas.' };
    }
  }
}
