# W9F lane T: takes, concepts, jobs

Branch `capy/w9f-lane-t` from origin/master 9cc7c467 (v0.60.99.0). No migration, no version bump.
The integrator folds these lines into the wave's CHANGELOG entry and `BEHAVIOR_CHANGES`.

## CHANGELOG lines

- Unmanaged brains: dream-cycle concept publication no longer overwrites a concept's markdown file when the file holds an edit the database has not imported (narrative, frontmatter, tags, type or title), or an edit made while the import ran. The concept is deferred (`revision_conflict`) and publishes after sync imports the edit. A failed file write now holds the concept (`concept_write_through_failed`) instead of reporting success. (item 3)
- `gbrain takes remove` leaves a reservation row (`| N | ~~(removed)~~ | take | world | 0.0 |  | removed |`) in the takes fence, so a removed take's number is never handed out again and `slug#N` citations and `take_proposals.promoted_row_num` never start pointing at an unrelated take. Every new take row number now comes from the shared `nextFreeRowNum` allocator. (item 4)
- Worker shutdown: an `UnrecoverableError` thrown while the worker shuts down now dead-letters on its first attempt with its own error text, instead of being re-queued as `worker_shutdown` for a second (possibly paid) run. Other errors during shutdown are still handed back with no attempt burned, and the hand-back now keeps the handler's text (`error_text = 'worker_shutdown: <handler error>'`). (item 6)
- `gbrain jobs supervisor stop`: a recycled worker pid no longer reads as `worker_still_running`; a supervisor started before the ISO-week boundary no longer reports a false `drained`; a run whose `started` audit row is missing or pruned reports `unverified`; and a stale PID file whose pid now belongs to another process is never signaled (`stale_pid_file`). (item 7)
- `gbrain takes rebuild <slug>` works while `gbrain serve` owns a PGLite brain (it used to hang on the owner's lock until killed). It is now the local-only `takes_rebuild` operation, delegated to the resident owner, with the same JSON, warnings and exit codes as a local rebuild. (item 8)

## BEHAVIOR_CHANGES candidates

1. **Take numbering on pages with a facts fence (item 4).** `nextFreeRowNum` is page-wide by GBRA-54's agreed contract: one more than every fence row number on the page, facts and takes, live, struck and reserved, plus stored facts/takes rows. The first take added to a page whose facts fence holds rows 1-5 is now #6, not #1. Existing rows are never renumbered. No opt-out.
2. **Visible reservation rows (item 4, Decision 3A).** `takes remove` now leaves a struck `(removed)` row in the user's markdown instead of deleting the line. The claim, holder and other cells are reset, so no removed text stays. The promise holds only while the row exists; deleting it by hand frees the number again.
3. **Shutdown error text (item 6).** `minion_jobs.error_text` for a shutdown hand-back is `worker_shutdown: <handler error>`, not bare `worker_shutdown`. Anything matching the exact string should match the prefix. The drain-expiry hand-back (no handler error) stays bare `worker_shutdown`.
4. **Supervisor stop reasons and PID file (item 7).** New stop outcomes: `unverified` (exit 1) and `stale_pid_file` (exit 0, `stopped: false`), plus `warnings: ['legacy_exit_pairing']` on audit rows written before this release. The PID file now holds a second line with the kernel start time on Linux; every gbrain reader takes the first line. External tools that parse the whole file as one integer need to read the first line.

## Upgrade notes

- Supervisors started before the upgrade write `worker_exited` rows without a `pid`. `supervisor stop` pairs them with spawns by order and warns. After a restart on the new version, the rows carry the pid and the process start time.

## Integration points and follow-ups

- **Lane R (item 8).** `takes_rebuild` calls `extractTakes({ source: 'db', rebuild: true })`, which on a managed brain publishes through `reextractCoordinated` (`src/core/cycle/extract-takes.ts`). When Lane R moves `reextractCoordinated` onto its receipted takes intent, `takes rebuild` (local and delegated) is receipted with no further change. The op already takes `request_id` (`WRITE_REQUEST_PARAM`), and the CLI sends a fresh UUID. If the intent returns a `write_request` receipt, `runTakesRebuild` renders it as part of the JSON result; pending handling like `runTakesMutation` would be a small addition there.
- **Item 6 follow-up.** In-process, the watchdog aborts the per-job signal, so a cooperative job interrupted by the watchdog burns an attempt (`aborted: watchdog`). Isolated mode treats the watchdog as a shutdown. This was already the case and Decision 7 leaves it alone. `test/worker-shutdown-error-matrix.test.ts` pins the current behavior so any change is deliberate. The strict `ShutdownInterruptedError` stays a TODO.
- **Item 4.** No reader displays `promoted_row_num` today, so the "resolve to removed" reader in the plan has no consumer. The pointer is never cleared and never re-targeted. No doctor check flags a hand-deleted reservation, because #6221 owns fence_integrity.
- **Item 3.** `composeConceptRepublication` and `preserveCanonicalFences` (GBRA-55 #6161) are untouched. The recheck lives in `publishClassicConcept`, `conceptFile` and the new `fileHoldsPage`, plus `writePageThrough({ expectedFileBytes })`.
