# Time-aware retrieval and reading: development results

Development-split results for the mechanisms preregistered in
[`TIME_AWARE_RETRIEVAL_PREREG.md`](TIME_AWARE_RETRIEVAL_PREREG.md). None of
these numbers sets a default; held-out verdicts do.

## Setup

- **Retrieval arms:** `gbrain eval longmemeval` with the eval-only
  `--fact-keys` / `--time-scope` arms, release default `balanced` (reranker on,
  autocut off), strict `recall_all@5` and NDCG@5 over distinct sessions,
  `openai:text-embedding-3-large` at 1536 dimensions, paired bootstrap (10,000
  draws) over questions. All 500 LongMemEval-S questions are development data;
  LongMemEval-M uses the same question ids with 500-session haystacks.
- **Reading arms:** the decision kit (`eval:decide`, gbrain-evals) `memory-qa`
  think lane — production `runThink` over each conversation's sessions, judged
  with the official LongMemEval prompts — on the LongMemEval-S 150-question
  stratified dev sample and the three LoCoMo dev conversations. Records:
  [`decisions/p6-think-dates/`](decisions/p6-think-dates/).

## Results

### Baselines

| Benchmark | Strict R@5 | Notes |
|---|---:|---|
| LongMemEval-S | 450/470 (95.7%) | reproduces the published 449/470 release-default row |
| LongMemEval-M | 367/470 (78.1%) | temporal-reasoning 81/127, multi-session 81/121 |

### Date frame in `think` (current date + page content dates) — passes development

| Source | Baseline | Date frame | Δ (95% CI) |
|---|---:|---:|---:|
| LongMemEval-S think, 150 questions | 80.7% | 90.0% | +9.3 pts [+4.0, +15.3] |
| LoCoMo dev think, 3 conversations | 76.7% | 89.1% | +12.4 pts (3 clusters) |
| Retrieval (LME-S, LoCoMo, BEAM-100K) | — | identical | 0.0 |

### Time scope — killed

| Arm | Benchmark | Questions with a range | Wins / losses (strict R@5) | NDCG@5 Δ (95% CI) |
|---|---|---:|---:|---:|
| reserved slots | LME-S | 59 | 0 / 3 | −0.013 [−0.027, −0.002] |
| full partition | LME-S | 59 | 0 / 11 | −0.101 [−0.150, −0.056] |
| reserved slots | LME-M | 59 | 0 / 1 | −0.011 [−0.030, +0.001] |

Questions without an explicit time cue are byte-identical in every arm. The
range is not selective on these haystacks: 48% of distractor sessions fall
inside the parsed range, and 39 of 135 gold sessions fall outside it (for
example "last Saturday" questions whose evidence spans several Saturdays, or
preference questions about "this weekend" whose evidence predates it).

### Fact keys

| Arm | Benchmark | Strict R@5 | NDCG@5 Δ (95% CI) | Wins / losses (NDCG) |
|---|---|---:|---:|---:|
| chunk keys, published user-fact prompt (Haiku 4.5) | LME-S | 451/470 | +0.008 [+0.002, +0.015] | 21 / 8 |
| page keys, published prompt | LME-S | 435/470 | −0.018 [−0.027, −0.010] | 13 / 41 |
| chunk keys, gbrain's facts extractor as shipped (Haiku 4.5) | LME-S | 452/470 | +0.005 [+0.0001, +0.011] | 16 / 8 |
| chunk keys, published prompt | LME-M | pending | pending | pending |

Page keys (every fact on every chunk) are rejected: the shared prefix makes a
session's chunks look alike and pushes gold sessions down. The published
prompt extracts 404 facts per question against 174 for gbrain's extractor,
which reads the first 8,000 characters of a page and keeps notable facts.

### Notes-first reading — no gain, removed

Same build with the date frame on, notes on vs off
([`decisions/p6-think-notes/`](decisions/p6-think-notes/)):

| Source | Notes off | Notes on | Δ (95% CI) |
|---|---:|---:|---:|
| LongMemEval-S think, 150 questions | 88.7% | 88.0% | −0.7 pts [−3.3, +2.0] |
| LoCoMo dev think, 3 conversations | 89.4% | 87.9% | −1.5 pts [−3.4, 0.0] |

With the date frame in place, asking the reader for notes before its answer
added output tokens and no accuracy, so the mode was removed rather than kept
as an unmeasured option. The published reading-notes gain was measured on
oracle sessions with direct-answer readers; gbrain's `think` already returns a
structured answer with citations and gaps.

## Deviations

- The preregistered comparison against the `tokenmax` contextual-synopsis
  bundle was not run: the benchmark harness does not generate per-chunk
  synopses at import, so `--mode tokenmax` measured the same embeddings as
  `balanced`.
- The reading-arm think lane passed each question's date as the reference
  date through a local harness change pending in gbrain-evals.
