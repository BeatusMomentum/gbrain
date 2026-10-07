# Wave 9 follow-ups, lane R: receipts on managed brains

Integrator notes for the release PR. Nothing here is stamped: no VERSION, no
CHANGELOG header, no BEHAVIOR_CHANGES row was written to source. Copy the
lines below when the PR is next to merge.

## CHANGELOG lines

- Managed brains now publish conversation facts through receipted maintenance
  requests (`managed_maintenance_conversation_facts`). Each page's facts and
  its outcome row commit in one transaction with their receipt. A crash after
  the request was accepted replays the stored batch on the next run without
  calling the model again; a request that fails the same way every time
  blocks that page version (no more model calls until the page changes); at
  most three requests are admitted per page version.
- Managed brains now extract facts from email threads, and record single
  emails, prose meeting notes and undated pages as "not extractable" for good
  instead of rescanning them every run.
- `gbrain extract-conversation-facts` on a managed brain stops admitting at
  80% of the writer's outstanding-request limit (`maintenance_backpressure`,
  exit 12), skips a page whose largest batch cannot fit one request before any
  model call, and refuses up front when the writer's permanent request ids
  cannot cover the run.
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

## Decision 9: measured request volume

Run: 200 managed conversation pages on PGLite (a quarter each of two-segment
transcripts, one-segment transcripts, short transcripts and prose notes),
three facts per segment with 1536-dimension vectors, injected extractor (no
model calls). Script: `~/.capy/work/w9f-r/scratch/measure-d9.test.ts`
(not committed); output `~/.capy/work/w9f-r/out/d9-measure.json`.

| Measure | Per request | Per 1k pages | 50k pages | Share of default limit |
|---|---|---|---|---|
| Permanent request ids | 1 | 1,000 | 50,000 | 20% of `principalLifetimeIds` (250,000) |
| Intent bytes (transient; released when the request settles) | avg 96 KB, max 191 KB | 96 MB (one at a time) | - | per request well under `principalIntentBytes` (32 MiB) |
| Reserved receipt bytes (30-day window) | 16 KiB | 16 MiB | 819 MB | 51% of `principalTerminalBytes` (1,536 MiB) |

One request id per page per extraction generation (each later page edit adds
one). At 50k pages the backfill alone uses 20% of the writer's permanent
request ids, above Decision 9's 10% switch threshold, and reserves half of
its receipt bytes for the retention window (compacted receipts keep about
4 KiB each, about 13% long term). Per Decision 9 (A) this wave keeps outcomes
as receipted facts rows and reports the number; the threshold is crossed, so
Garry's call on 9B (a non-guarded outcome side table for
non-extractable/terminal outcomes) or batching outcomes across pages is the
follow-up.

## Functions touched in GBRA-52's file (`src/commands/extract-conversation-facts.ts`)

`ExtractConversationFactsResult` (two optional counters), `ExtractCoreState`
(`managed` is now the publisher or null), `processPage` (three managed call
sites), `runExtractConversationFactsCore` (preflight line, run-stop errors in
the two page loops), `runExtractConversationFacts` (aggregate and print the
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
