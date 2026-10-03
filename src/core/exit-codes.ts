/**
 * Process exit statuses with a contract beyond "0 ok / 1 failed". One home so
 * a new status cannot silently reuse a value a caller already branches on.
 */

/** A runner refused because another runner holds the migration lock (EX_TEMPFAIL). */
export const MIGRATIONS_RUNNING_EXIT_CODE = 75;

/**
 * #5232 (O-ENG-1): the write was admitted and is still pending; it may commit
 * later. Distinct from 75, which `gbrain upgrade` reads as "another
 * migration runner holds the lock". Exit 0 means committed; pass
 * `--accept-pending` (or GBRAIN_ACCEPT_PENDING=1) to map pending to 0.
 */
export const PENDING_WRITE_EXIT_CODE = 10;
