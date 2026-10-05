# Time-aware recall

`gbrain think` answers in a date frame. It knows today's date in your brain's
timezone, it sees the content date of each page it reads, and it resolves
relative time words against the right one: "last month" in your question
against today, "yesterday" inside a meeting note against that note's date.

## Say to your agent

- *"What did I decide about pricing last month?"* — your agent runs
  `gbrain think "What did I decide about pricing last month?"`; the answer is
  grounded in today's date and each page's date.
- *"Answer as if today were March 1, 2024."* — `gbrain think "…" --reference-date 2024-03-01`.

## What the reader sees

- **Current date.** The user message carries `Current date: YYYY-MM-DD (<zone>)`
  just before the question. The zone is `brain.timezone`
  (`gbrain config set brain.timezone America/Los_Angeles`); unset means UTC.
  `--reference-date` / MCP `reference_date` replaces today with a past or
  current YYYY-MM-DD; a malformed or future date is refused with
  `invalid_params` before any model call.
- **Page dates.** Each `<page>` block carries `date="YYYY-MM-DD"` when the page
  has a content date: frontmatter `event_date`, `date` or `published`, or a
  dated filename. A page whose date fell back to when the file or row was
  created carries no date, because that time says nothing about the content.
  A day-only frontmatter date renders as written; a timestamp renders in the
  brain's timezone.
- **Search results** already carry each page's `effective_date` and
  `effective_date_source`, so an agent reading `search` or `query` output
  directly can apply the same rule.

## Measured effect

On the LongMemEval-S development sample, `think` answered 90.0% of questions
correctly with the date frame against 80.7% without it (+9.3 points, 95% CI
[+4.0, +15.3]); on the LoCoMo development conversations, 89.1% against 76.7%.
Retrieval is unchanged. Results:
[`docs/eval/TIME_AWARE_RETRIEVAL_RESULTS.md`](../eval/TIME_AWARE_RETRIEVAL_RESULTS.md).

## Fact keys

Fact keys help search find a page when a question is phrased like a fact
the page states but not like its wording. They're off by default until the
held-out verdict is in. When `search.fact_keys` is on, every eligible page
write that runs facts extraction also places the extracted facts into the
embedding input of the page's own chunks:

```
<context>{title}
Facts: {fact}; {fact}
</context>
{chunk text}
```

The stored chunk text, keyword search, the reranker and the returned page
are unchanged. A key never appears as text in any result.

- **Turn on:** `gbrain config set search.fact_keys on`. New writes key
  themselves. Keyed chunks are embedded a second time once extraction lands,
  so ask the user before turning this on for a large brain.
- **Coverage:** `gbrain fact-keys status`, or doctor's `retrieval_enrichment`
  check. Only pages in the `title` embedding tier are keyed, which is the
  `balanced` default. Pages with protected facts or takes fences, or with
  `embed_skip`, are not keyed. Private facts never key a world-visible page.
  Facts default to private unless `facts.default_visibility` is `world`,
  which bootstrap sets for single-user brains.
- **Backfill:** `gbrain fact-keys refresh --dry-run` lists eligible pages
  without keys. `gbrain fact-keys refresh` re-runs facts extraction for them,
  at one paid model call per page (default limit 50).
- **Turn off:** `gbrain config set search.fact_keys off`, then run
  `gbrain fact-keys clear` until it reports no pages left. Clearing re-embeds
  each keyed chunk without keys before swapping the vector in.
- **Forget:** forgetting a fact also finds the pages its key was merged into,
  and rebuilds them without it.

Design: [`docs/designs/FACT_KEYS.md`](../designs/FACT_KEYS.md).

## Measuring it

The LongMemEval harness measures fact keys (`--fact-keys chunk
--fact-extractor pipeline` runs the shipping path; `paper` and `production`
are the development arms) and the rejected soft time scope (`--time-scope`).
`--mode tokenmax` builds production per-chunk synopses for comparison. See
[`docs/eval-bench.md`](../eval-bench.md) and the
[evaluation key files](../architecture/key-files/evaluation.md).
