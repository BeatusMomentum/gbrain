# Wave 9 follow-ups, lane R: receipts on managed brains

Integrator notes for the release PR. Nothing here is stamped: no VERSION, no
CHANGELOG header, no BEHAVIOR_CHANGES row was written to source. Copy the
lines below when the PR is next to merge.

## CHANGELOG lines

- Managed brains now publish conversation facts through receipted maintenance
  requests (`managed_maintenance_conversation_facts`), batched across pages:
  one request carries up to 25 pages (at most 10 with extracted facts, at
  most 8 MiB), and every page's facts and outcome row commit in the same
  transaction as that receipt. A page that changed while the batch was being
  built is skipped and reported inside the batch; the rest publish. A crash
  after the request was accepted replays the stored batch on the next run
  without calling the model again; a failed batch is resubmitted from its
  stored pages; a page whose rows can never publish, or that sat in three
  failed batches, is blocked until it changes.
- Managed brains now extract facts from email threads, and record single
  emails, prose meeting notes and undated pages as "not extractable" for good
  instead of rescanning them every run.
- `gbrain extract-conversation-facts` on a managed brain stops admitting once
  the writer's outstanding requests, reserved receipt bytes or permanent
  request ids would pass 80% of their limit (`maintenance_backpressure`,
  exit 12; the message names the resource and a `--limit` that fits), checked
  up front for the whole planned run and again before each page, and skips a
  page whose largest batch cannot fit one request before any model call.
- The cycle `extract_facts` fence reconcile, its deleted-page fact expiry,
  `gbrain extract takes --source db` / `gbrain takes rebuild` / the v0.28.0
  takes backfill, and `gbrain repair take-supersession`'s database branch now
  publish receipted maintenance requests on managed brains. A page that is
  already in sync admits nothing.
- Conversation extraction outcomes record the parser/extractor version
  (`extractor_version=<n>` in the outcome row context). Doctor
  `conversation_outcomes_stale` counts outcomes from an older version; they
  are never reopened automatically.

## BEHAVIOR_CHANGES candidate (one row, `since:` = this release)

> Managed brains now extract facts from email threads and record single emails, prose meeting notes and undated pages as not extractable for good. Preview what a run would extract and its segment count with `gbrain extract-conversation-facts --source-id <id> --dry-run`; a two-message thread is one segment, about $0.006 on Haiku 4.5 or $0.017 on Sonnet 4.6. Spend stays under the existing caps (`--max-cost-usd`, default $5; the opt-in `cycle.conversation_facts_backfill` at $1 per run and $5 total); nothing submits extraction automatically. There is no separate opt-out for email threads: leave the backfill off, or narrow `cycle.conversation_facts_backfill.types`.

The per-thread estimate is the plan's per-segment figure (about 3k input and
0.5k output tokens per segment, priced from `model-pricing.ts`), not a
measurement.

## Upgrade notes

- Managed conversation-fact extraction, fence reconcile, takes reextract and
  take-supersession reprojection now preflight like every other managed
  maintenance writer (`maintenancePreflight`): a source with a canonical
  checkout needs its active owner on this host before any model work. The
  cycle and takes paths preflight lazily, on the first page that needs a
  write, so a run with nothing to change never needs it.
- A request still pending after the job's wait is reported (`pages_pending`)
  and replayed on the next run with no model call.

## Decision 9: measured request volume (batched; Garry chose batching, no migration)

Run: 200 managed conversation pages on PGLite, three facts per segment with
1536-dimension vectors, injected extractor (no model calls), default caps
(25 pages, 10 fact pages, 8 MiB per request), receipts then force-compacted.
Script: `~/.capy/work/w9f-r/scratch/measure-d9c.test.ts` (not committed);
outputs `~/.capy/work/w9f-r/out/d9-batched-1.json` (25% outcome-only) and
`d9-batched-3.json` (75% outcome-only). The 50k column scales the 200-page
run linearly.

| 50k pages | Before batching (one request per page) | Batched, 25% outcome-only | Batched, 75% outcome-only |
|---|---|---|---|
| Requests (permanent request ids) | 50,000 (20% of `principalLifetimeIds`) | 3,750 (1.5%) | 2,000 (0.8%) |
| Reserved receipt bytes, 30-day window | 781 MiB (51% of `principalTerminalBytes`) | 61 MB (3.8%) | 33 MB (2.0%) |
| Retained receipt bytes after compaction | 87 MB (5.5%) | 17 MB (1.1%) | 14 MB (0.9%) |
| Intent per request | 128 KB fact page, 1.5 KB outcome-only | avg 1.6 MB, max 1.6 MB | avg 1.2 MB, max 1.4 MB |

The fact-page cap (10 per request) sets the request count: 150 fact pages
made 15 requests in the 25% run, 50 fact pages and 150 outcome-only pages
made 8 in the 75% run. A batch receipt keeps one result per member
(about 150 bytes each), so a compacted batch receipt keeps about 4.6 KB.
Both mixes are now well under Decision 9's 10% switch threshold. The
`maintenance_backpressure` stop at 80% of reserved receipt bytes and request
ids stays, and the up-front check counts the run's planned batches (pages
over 10).

Before batching, for the record: request ids and reserved receipt bytes were
charged per request (16,384 B flat), so each request type's share of the 20%
and 51% equalled its share of pages; a compacted per-page receipt kept about
1.75 KB.

## Functions touched in GBRA-52's file (`src/commands/extract-conversation-facts.ts`)

`ExtractConversationFactsResult` (two optional counters), `ExtractCoreState`
(`managed` is now the publisher or null), `processPage` (three managed call
sites; a managed page is enqueued and counted when its batch publishes),
`runExtractConversationFactsCore` (preflight line, run-stop errors in the two
page loops, the final batch flush before the checkpoint and on the error
path), `runExtractConversationFacts` (aggregate and print the
two counters), `terminalAuditFact`/`nonExtractableAuditFact` (version
stamp); new `currentConversationVersionToken`; removed `replacePageFacts`.
The managed logic lives in `src/core/facts/conversation-publication.ts`.

## TODOs (not written to TODOS.md)

- Receipts for the pages, timeline and alias derived writers
  (`page-state/materialize.ts`, `timeline-extract.ts`, `reindex-aliases.ts`,
  `mentions/pass.ts`) and for bootstrap verify's probe-fact cleanup
  (`bootstrap/verify.ts`), each listed in `test/receipt-coverage.test.ts`.
- Production fail-closed receipt guard (Decision 10 B): the contract harness
  enforces it today.
- Decision 9 follow-up above.
- A parser-version change is part of the generation identity but has no
  runtime test (the version is a constant); the stamp and doctor count are
  tested.
