// Brand & deployment identity — the ONLY app file the private branch overlays.
// Public defaults are generic; a deployment sets its own name and database.
export const BRAND = {
  /** Product name — page titles, PWA manifest. */
  name: 'CRM Textil',
  /** Stacked login wordmark: [top line (ink), bottom line (dye)]. */
  wordmark: ['CRM', 'TEXTIL'],
  /**
   * Database name: the local IndexedDB replica, `{dbName}-cart` for the
   * never-synced cart, and the same-origin remote at `/db/{dbName}`.
   * Must match APP_DB in .env (couch/setup.sh provisions that database).
   */
  dbName: 'crm',
};
