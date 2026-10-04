/**
 * Life Chronicle automatic extraction contract (#5876): the ledger columns,
 * the decision and outcome reason codes, the write-receipt hint and the
 * `chronicle` cycle-phase result. Doctor, advisor, receipts, docs and tests
 * import these names; nothing else spells them.
 *
 * Lifecycle:
 *   1. A coordinated page publication (put_page, capture, edit_page,
 *      restore_page, revert_version, managed sync and connector imports)
 *      records one `chronicle_page_state` row for the published content in
 *      the same transaction (`pending` or `skipped` + reason) and returns the
 *      `chronicle_backstop` receipt hint. Unmanaged brains have no write
 *      decision; the phase scans their pages directly.
 *   2. The global `chronicle` cycle phase claims settled `pending` rows whose
 *      content is still live, takes a rolling daily reservation, runs the
 *      judge under a BudgetTracker scope, publishes events, reconciles the
 *      previous generation and records the outcome on the row.
 *   3. `gbrain chronicle-backfill` records `pending` rows with
 *      trigger='backfill' (exempt from the daily limit and recency rule);
 *      the same phase executes them.
 */

/** Bump to re-extract every page once (the ledger key includes it). */
export const CHRONICLE_EXTRACTOR_VERSION = 1;

/** Ledger table and its columns (migration `chronicle_page_state`). */
export const CHRONICLE_LEDGER_TABLE = 'chronicle_page_state';
/** Rolling daily reservations: one row per automatic judge call (attempts and retries count). */
export const CHRONICLE_RESERVATION_TABLE = 'chronicle_judge_reservations';

export type ChronicleLedgerState = 'pending' | 'skipped' | 'extracted' | 'failed';
export type ChronicleTrigger = 'auto' | 'backfill';

export interface ChronicleLedgerRow {
  source_id: string;
  page_id: number;
  content_hash: string;
  extractor_version: number;
  slug: string;
  state: ChronicleLedgerState;
  /** A `ChronicleReason` (or `no_events` on an extracted row); null on pending/extracted-with-events. */
  reason: string | null;
  trigger: ChronicleTrigger;
  /** Writer of the decided revision (`persistence_requests.principal_*`); null on unmanaged scans and backfill. */
  principal_kind: string | null;
  principal_id: string | null;
  request_id: string | null;
  /** `processingOptions.noExtract` of the sync intent at decision time. */
  no_extract: boolean;
  attempts: number;
  /** Earliest next judge attempt for a failed row with backoff; null = not scheduled. */
  next_attempt_at: Date | string | null;
  /** Recorded spend of the last attempt in USD (null when unpriced or not run). */
  cost_usd: number | null;
  /** The judge model had no price, so cost_usd is unknown. */
  unpriced: boolean;
  /** Event page slugs this content produced (the generation reconciliation reads). */
  event_slugs: string[];
  /** content_hash of each event page as the extractor wrote it, parallel to event_slugs. An event whose
   *  live hash is no longer in any row of its depth page was edited by an operator and is never touched. */
  event_hashes: string[];
  decided_at: Date | string;
  updated_at: Date | string;
}

/** Config keys this subsystem reads (registered under the `chronicle.` prefix). */
export const CHRONICLE_CONFIG = {
  enabled: 'auto_chronicle',
  jobBudgetUsd: 'chronicle.job_budget_usd',
  dailyLimit: 'chronicle.auto_daily_limit',
  recentDays: 'chronicle.auto_recent_days',
  settleSeconds: 'chronicle.auto_settle_seconds',
  /** ISO timestamp the automatic path activated on this brain (written by the migration). */
  activatedAt: 'chronicle.activated_at',
} as const;

export const CHRONICLE_DEFAULTS = {
  jobBudgetUsd: 0.25,
  dailyLimit: 200,
  recentDays: 30,
  settleSeconds: 180,
  /** Items one phase run judges at most (automatic + backfill). */
  maxItemsPerRun: 50,
  /** Wall-time bound of one phase run. */
  maxRunMs: 10 * 60_000,
  /** Judge attempts before a failed row stops retrying on its own. */
  maxAttempts: 5,
} as const;

export const OPT_OUT_COMMAND = 'gbrain config set auto_chronicle false';
export const RUN_NOW_COMMAND = 'gbrain dream --phase chronicle';

/**
 * Every reason code a ledger row, receipt or phase result can carry. One
 * table: meaning, the exact next command, and whether the agent must ask
 * the user first (paid or destructive).
 */
export const CHRONICLE_REASONS = {
  // ── write-time / discovery skips (state 'skipped') ──
  auto_chronicle_off: { stage: 'decision', meaning: 'Automatic extraction is turned off on this brain.', next: 'gbrain config set auto_chronicle true', ask_user: true },
  no_extract: { stage: 'decision', meaning: 'The sync ran with --no-extract, so its pages are not extracted automatically.', next: 'gbrain chronicle-backfill --limit 50 --dry-run', ask_user: true },
  slug_bound_client: { stage: 'decision', meaning: 'A confined writer (slug-bound, delegated or restricted namespace) cannot trigger paid extraction.', next: 'gbrain chronicle-backfill --limit 50 --dry-run', ask_user: true },
  operation_bound_client: { stage: 'decision', meaning: 'The writer grant does not include extract_facts, which also covers automatic event extraction.', next: 'gbrain chronicle-backfill --limit 50 --dry-run', ask_user: true },
  dream_generated: { stage: 'decision', meaning: 'Dream output is never mined for events.', next: null, ask_user: false },
  too_short: { stage: 'decision', meaning: 'The page body is under 80 characters.', next: null, ask_user: false },
  history: { stage: 'decision', meaning: 'The page is dated older than chronicle.auto_recent_days; history is left to the backfill.', next: 'gbrain chronicle-backfill --dated-since <date> --limit 50 --dry-run', ask_user: true },
  not_yet_happened: { stage: 'decision', meaning: 'The meeting has not ended yet; the phase picks it up once its end time passes.', next: null, ask_user: false },
  no_write_decision: { stage: 'discovery', meaning: 'A managed page revision has no write decision (written by an older binary or before activation).', next: 'gbrain chronicle-backfill --limit 50 --dry-run', ask_user: true },
  not_chronicle_shaped: { stage: 'decision', meaning: 'The page is no longer a meeting, conversation or calendar page; its automatic events were retired.', next: null, ask_user: false },
  already_extracted: { stage: 'decision', meaning: 'This exact content was already extracted; its events are current.', next: null, ask_user: false },
  // ── execution outcomes ──
  superseded: { stage: 'execution', meaning: 'The page, its source, its privacy or the writer grant changed before the events were published; the newer revision carries its own decision.', next: null, ask_user: false },
  page_missing: { stage: 'execution', meaning: 'The page was deleted before extraction.', next: null, ask_user: false },
  judge_refused: { stage: 'execution', meaning: 'The model refused or filtered the page.', next: null, ask_user: false },
  no_events: { stage: 'execution', meaning: 'The judge read the page and found no events.', next: null, ask_user: false },
  // ── failures (state 'failed') ──
  judge_chat_error: { stage: 'execution', meaning: 'The chat provider call failed; the row retries with backoff.', next: RUN_NOW_COMMAND, ask_user: false },
  judge_llm_unavailable: { stage: 'execution', meaning: 'No chat provider is configured, so nothing can be extracted until one is.', next: 'gbrain config set models.chat <provider:model>', ask_user: true },
  no_pricing: { stage: 'execution', meaning: 'chronicle.job_budget_usd was set explicitly and the chat model has no price, so the cap cannot be enforced.', next: 'gbrain pricing set <model> --input <usd-per-1M-input-tokens> --output <usd-per-1M-output-tokens> --source <pricing-page-url>', ask_user: true },
  budget_exhausted: { stage: 'execution', meaning: 'The page cost more than chronicle.job_budget_usd.', next: 'gbrain config set chronicle.job_budget_usd <usd>', ask_user: true },
  judge_truncated: { stage: 'execution', meaning: 'The judge output hit its token cap.', next: 'gbrain config set chronicle.judge_max_tokens 8000', ask_user: false },
  judge_parse_failed: { stage: 'execution', meaning: 'The judge returned no parseable JSON array.', next: RUN_NOW_COMMAND, ask_user: false },
  malformed_proposal: { stage: 'execution', meaning: 'A proposed event failed validation, so the whole batch was rejected.', next: RUN_NOW_COMMAND, ask_user: false },
  publish_error: { stage: 'execution', meaning: 'Publishing the events failed; nothing from this attempt was retired.', next: RUN_NOW_COMMAND, ask_user: false },
  // ── phase-level ──
  daily_limit: { stage: 'execution', meaning: 'The rolling 24 h automatic limit is used up; pending pages wait for a free slot.', next: 'gbrain config set chronicle.auto_daily_limit <n>', ask_user: true },
  no_chat_provider: { stage: 'phase', meaning: 'No chat provider is configured; the phase made no calls.', next: 'gbrain config set models.chat <provider:model>', ask_user: true },
} as const satisfies Record<string, { stage: 'decision' | 'discovery' | 'execution' | 'phase'; meaning: string; next: string | null; ask_user: boolean }>;

export type ChronicleReason = keyof typeof CHRONICLE_REASONS;

/** Write-receipt hint (`chronicle_backstop`), omitted for pages that are not chronicle-shaped. */
export type ChronicleBackstopReceipt =
  | { pending: 'next_cycle'; daily_remaining: number; next_command: string }
  | { skipped: ChronicleReason; next_command: string | null; ask_user: boolean };

/** `chronicle` cycle-phase result details. */
export interface ChronicleRunDetails {
  /** Why the phase made no calls at all, when it did not run. */
  reason?: 'auto_chronicle_off' | 'no_chat_provider' | 'no_pricing' | 'no_database' | 'nothing_pending';
  dry_run: boolean;
  sources: number;
  /** Rows the run looked at (claimed or skipped). */
  candidates: number;
  judged: number;
  extracted: number;
  no_events: number;
  failed: number;
  /** Count per reason of rows skipped or failed in this run. */
  reasons: Partial<Record<ChronicleReason, number>>;
  events_written: number;
  events_retired: number;
  /** Pending automatic rows left for the next run because the daily limit is used up. */
  deferred_daily_limit: number;
  daily_limit: number;
  daily_remaining: number;
  spent_usd: number;
  unpriced_calls: number;
  max_items: number;
  per_source: Record<string, { candidates: number; judged: number }>;
  next_command?: string;
}
