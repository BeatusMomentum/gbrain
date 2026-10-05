# Fact keys in chunk embeddings — design note

Status: **proposed, awaiting engineering review.** There is no product code for
it yet. This note covers obligations 1–9 from the preregistered plan
([`docs/eval/TIME_AWARE_RETRIEVAL_PREREG.md`](../eval/TIME_AWARE_RETRIEVAL_PREREG.md)).
Development results are in
[`docs/eval/TIME_AWARE_RETRIEVAL_RESULTS.md`](../eval/TIME_AWARE_RETRIEVAL_RESULTS.md).

## What it does

gbrain already extracts facts when an eligible page is written
(`facts/backstop.ts`, on by default, `facts/eligibility.ts`). Fact keys take
those facts for the current revision of a page and place each one in the
embedding input of the chunk it best matches:

```
<context>{title}
{fact; fact; fact}
</context>
{chunk text}
```

The vector then matches questions phrased the way the fact is phrased. The
stored `chunk_text`, keyword index, reranker input, snippets and returned
evidence don't change, because only the embedding input gets the facts.

## Evidence

All numbers come from development data. Held-out verdicts set the default.

| Arm (strict recall_all@5, `balanced`) | LongMemEval-S | LongMemEval-M |
|---|---:|---:|
| baseline | 450/470 | 367/470 |
| chunk keys, published user-fact prompt | 451/470 | 383/470 (+3.4 pts, CI [+1.5, +5.5]) |
| chunk keys, gbrain's extractor as shipped (Haiku 4.5 pinned) | 452/470 | 381/468 vs 366 (+3.2 pts, CI [+1.3, +5.1]) |
| page keys (every fact on every chunk) | 435/470 (rejected) | — |

On M, gbrain's own extractor can't be told apart from the published prompt
(−0.2 pts, CI [−2.1, +1.7]). So the feature needs no new extraction call: it
reuses the facts the backstop already pays for.

## Design

### 1. Occurrence keys, bound to a page revision

The keys are stored in a new table:

```sql
CREATE TABLE page_fact_keys (
  page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_revision    UUID    NOT NULL,
  item_fingerprint TEXT    NOT NULL,   -- gbrain_fact_fingerprint(item_text)
  item_text        TEXT    NOT NULL,
  visibility       TEXT    NOT NULL,
  subject          TEXT    NOT NULL,   -- entity slug or '*', as fact_withdrawals
  extractor_version TEXT   NOT NULL,
  PRIMARY KEY (page_id, page_revision, item_fingerprint)
);
CREATE INDEX page_fact_keys_fingerprint ON page_fact_keys (item_fingerprint);
```

- Each row holds the extractor's own output for that revision, recorded before
  dedup. It is never the canonical dedup winner, because a cosine ≥ 0.95 match
  can carry a different amount or date (`backstop.ts` dedup phase,
  `capture-dedup.ts`).
- A row is used only when `page_revision` equals the page's current revision.
  When a newer revision's extraction lands, it deletes the older rows in the
  same transaction. Until then, a new revision without fresh extraction has no
  keys.
- Graduation inventory (#6022): `page_fact_keys` is **derived**. It can be
  rebuilt by re-extraction and isn't carried user data, so it is listed as
  operational.

### 2. Protected content

Extraction reads raw `compiled_truth`; chunks use the stricter remote
sanitizer (`remote-body.ts`). A page whose sanitized body differs from its raw
body gets no keys. The writer skips it, and doctor counts it as
`retrieval_enrichment.protected_skipped`. So keys can only repeat text the
page's own chunks already expose, and key visibility always equals page
visibility.

### 3. Both publication paths

The keys are written in the same transaction as the facts they came from:

- managed: `persistence/facts-maintenance.ts` `publishManagedFacts` and
  `persistence/facts-prepare.ts`;
- legacy: the unmanaged `backstop.ts` write fence.

Both paths hold the page's revision from the guarded snapshot (the
`revision_conflict` check in `prepareManagedFactsSession`). The writer
refuses to install keys for a superseded revision, the same way facts are
refused today.

### 4. Withdrawal

`forget` already deletes the chunks of affected pages and queues a rebuild
in the same transaction (`facts/withdrawal.ts`). Fact keys add two things:

- Discovery (`withdrawal-discovery.ts`) also returns pages whose current
  `page_fact_keys` rows match the withdrawn fingerprint and subject. Those pages
  take the existing delete-and-rebuild path, so withdrawn enrichment stops
  influencing retrieval at commit time.
- The key builder filters out items that match `fact_withdrawals`, so a
  rebuild never reinstalls a withdrawn key.

The existing 256-page discovery ceiling applies unchanged. A larger fan-out
is refused the same way it is today and is covered by a test. This changes
what `forget` means for enrichment only: the page's own prose is untouched.

### 5. Stale detection

`embed --stale` today selects only null vectors and signature drift. Fact keys
add `content_chunks.needs_reembed BOOLEAN NOT NULL DEFAULT false`:

- Installing or removing keys sets it on every chunk whose key text changed.
  The old vector stays searchable until the new one lands, so a page doesn't
  lose recall while it waits.
- Stale selection (`engine-sql/chunks.ts`, `commands/embed-stale.ts`),
  readiness counts (`embedding-readiness.ts`), the effects worker's completion
  check (`persistence/effects.ts`) and doctor all read `needs_reembed OR vector
  IS NULL`, for every embedding column.
- Turning the feature off clears the key text and sets the marker on keyed
  chunks.

### 6. No false-current installs

`installPageEmbeddings` (`page-state/projections.ts`) currently stamps
`embedding_input_hash` from the row as it stands at install time. With keys,
the embed path captures the exact input hash before the provider call and
passes it in. Under the page lock, install recomputes the hash from the
current keys. When the hashes are equal, it stamps the hash and clears
`needs_reembed`. When they differ, it writes nothing and leaves the marker
set. Three races get tests: new keys arriving, the feature being disabled,
and a visibility change, each during an in-flight embed.

### 7. The hash covers every tier

`EmbeddingInputContext` gains `factKeys: string | null` per chunk.
`embeddingInputHash` digests it in the `none`, `title` and
`per_chunk_synopsis` tiers whenever it's non-null. A null value keeps
today's bytes, so no existing vector is invalidated by the upgrade.
`acceptedEmbeddingInputHashes` follows. Each tier gets golden tests.

### 8. tokenmax

In v1, keys are limited to the `none` and `title` tiers. Synopsis pages
(`tokenmax`) keep their synopsis and get no keys. The managed worker demotes
pending synopsis pages to title (`persistence/effects.ts`), and regenerating
synopses would be paid work this feature doesn't need. That gap is closed by
measurement, not code: the preregistered "beats `tokenmax` synopsis" arm
couldn't run because the harness doesn't generate synopses. That gap needs a
harness run before the gate is complete (open question 1).

### 9. Downgrade

There is no downgrade-safety claim. Older writers ignore the invalidation
obligations (`cycle/extract-facts.ts`). Before a downgrade, the migration note
requires `search.fact_keys off` followed by a clean `embed --stale`.

### Key selection

The selection is pure and already written: `src/core/fact-keys.ts`
`assignFactKeys`. It assigns each item to the chunk it shares the most
content words with. It never keys code or image chunks, caps each chunk's
keys at 800 characters, and sanitizes keys the same way titles are sanitized.
The dev runs used exactly this module, so production and eval build the same
bytes.

## Cost

- **Extraction:** nothing new. The backstop already extracts on every eligible
  write when `facts.extraction_enabled` is on (the default). Its default model
  is the reasoning tier, and the dev gate pinned Haiku 4.5. Sealed runs must
  use the shipping model.
- **Embedding:** an eligible page is embedded at write time (searchable at
  once), then re-embedded for keyed chunks after extraction lands. The
  preregistered bound is ≤1.3× embedding spend on a full write → extract →
  refresh cycle, measured on BrainBench's corpus before the default flips.
  Re-embeds go through the existing spend gate. A refusal leaves
  `needs_reembed` visible to `embed --stale` and doctor.
- **Backfill:** existing brains have facts but no occurrence keys, and keys
  can't come from canonical facts (obligation 1). So a backfill means
  re-extraction, which is paid. It follows the post-upgrade re-embed contract
  (`post-upgrade-reembed.ts`): non-interactive spend is deferred, and agents
  relay a spend prompt. New writes get keys with no backfill.

## Configuration and defaults

There is one config key, `search.fact_keys` (`on` | `off`). Its default is set
by the held-out verdict: on when that verdict passes and an embedding key plus
facts extraction are configured, otherwise off. That matches how other
measured features ship.

Doctor check `retrieval_enrichment` reports keyed, eligible-unkeyed,
protected-skipped and `needs_reembed` counts. Each count comes with its exact
fix command.

## Files

- Migration (`page_fact_keys`, `content_chunks.needs_reembed`), `schema.sql`
  and the generated blobs.
- `engine.ts`, both engines, and a new `engine-sql/fact-keys.ts`.
- `facts/backstop.ts`, `persistence/facts-maintenance.ts`,
  `persistence/facts-prepare.ts`, `facts/withdrawal.ts`,
  `facts/withdrawal-discovery.ts`.
- `fact-keys.ts`, `embedding-context.ts`, `embedding-input-hash.ts`,
  `page-state/projections.ts`.
- `engine-sql/chunks.ts`, `commands/embed-stale.ts`, `commands/embed.ts`,
  `persistence/effects.ts`, `embedding-readiness.ts`.
- `backfill-registry.ts` and the doctor check.

## Tests

- **Unit:** per-tier hash goldens with and without keys; assignment
  determinism.
- **Write paths:** the protected-content skip; superseded-revision refusal on
  both publication paths.
- **Lifecycle (E2E against Postgres):** extraction → keys → `needs_reembed` →
  embed → stamp; the three install races; withdrawal hides a key at commit time
  and rebuilds the page without it; the >256-page discovery refusal; disable
  clears keys and marks chunks; spend-gate refusal leaves the marker.
- **PGLite parity** for the engine methods.

## Open questions for review

1. **The `tokenmax` gate.** The preregistered gate also requires beating
   `tokenmax` synopsis, which the harness can't generate yet. The options are
   to add synopsis generation to the LongMemEval harness (paid, about the
   embed run's cost) or to amend the preregistration so the gate compares
   against the `balanced` default only, with the reason recorded.
2. **Extractor model.** The dev gate pinned Haiku 4.5, but production defaults
   to the reasoning tier. The sealed run should use the shipping default. If
   Haiku is kept for cost, `facts.extraction_model` documents that.
3. **Double embedding.** If the ≤1.3× bound fails, the fallback is to delay the
   first embed of eligible pages until extraction lands, with a deadline. That
   trades write-time searchability for cost.
