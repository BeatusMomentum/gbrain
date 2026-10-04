# Time-aware retrieval and reading: preregistration

This file fixes, before any development-split run, what each mechanism must
show to proceed, and what the sealed confirmation must show for a default to
change. Mechanisms that fail are reported here as negative results and their
code is removed.

## Mechanisms

| ID | Mechanism | Where it runs |
|---|---|---|
| R1 | `think` date frame: current date line + content dates on page blocks | product (on) |
| R2 | `think` notes-first reading (`think.reading_notes`) | product (default set by the verdict) |
| F1 | Fact keys, benchmark user-turn fact prompt (replication of key expansion) | eval arm `--fact-keys … --fact-extractor paper` |
| F2 | Fact keys, gbrain's production facts extractor as shipped | eval arm `--fact-extractor production` |
| F3 | Fact keys merged into the keyword index instead of embeddings | eval probe |
| F4 | Facts as separately ranked keys (rank merging) | eval probe, expected to lose |
| T1 | Soft time scope, reserved slots (top ⌈k/2⌉ kept) | eval arm `--time-scope reserved` |
| T2 | Soft time scope, full partition (published replication) | eval arm `--time-scope partition` |

The time-range grammar (`src/core/temporal-grammar.ts`) is frozen at this
commit. Its goldens are the published LongMemEval time-range examples and
generic English; four development-slice question texts were read while
finalizing the duration-question rule ("how many days did I spend … this
year" counts inside a window and keeps its range).

## Data

- **Development:** the frozen development split of LongMemEval-S and -M
  (same question ids in both), defined by the eval harness owner. Every
  mechanism choice (chunk vs page assignment, reserved vs partition, notes
  on/off/auto) uses only these questions.
- **Sealed:** LoCoMo (never used by gbrain for tuning) and the sealed split of
  LongMemEval-M. LongMemEval-S questions were all used for earlier ranking
  decisions, so M-sealed is reported as disclosed confirmation, never as sole
  proof. Sealed runs are executed once, by the eval custodian, after every
  candidate is frozen.
- **Non-regression:** BrainBench retrieval, NamedThingBench, and a time-cue
  fire-rate audit on a synthetic notes brain (how often a range fires and how
  often it is wrong, counting code and changelog text).

## Metrics

Strict `recall_all@5` (headline), `recall_all@10`, `recall_any@5`, NDCG@5/@10,
per question type; judged answer accuracy (official LongMemEval prompts,
`gpt-4o-2024-08-06` judge) through production `think` for R1/R2. Time-scope
rows carry the unscoped top-k from the same candidate pool; the paired
comparison is scoped vs unscoped per question.

## Kill gates (development split)

A mechanism proceeds only with paired wins > losses and a paired bootstrap
95% interval excluding zero on its target metric:

- F1/F2: NDCG@5 or strict `recall_all@5` on LongMemEval-M development
  questions, and F1/F2 must also beat the `tokenmax` contextual-synopsis
  bundle. F2 runs only if F1 passes; F2 extraction uses Haiku for the gate and
  the shipped Sonnet default only if the gate passes.
- T1/T2: temporal-reasoning recall@5 on questions where a range fires; on
  questions where no range fires, rankings must be byte-identical to the
  baseline.
- R2: judged accuracy through `think`, with p50/p95 latency and $/call reported.

## Default-on bar (sealed)

The exact shipping configuration per mode bundle must show: a paired interval
excluding zero on its target (judged accuracy for R2; retrieval target for
F/T on LoCoMo and M-sealed), no question type down by more than one question,
BrainBench and NamedThingBench non-regression, embedding multiplier ≤ 1.3×
for fact-bearing pages, `think` p95 latency ≤ +20%, sync wall time ≤ +5%.
Anything that fails ships off or is removed.

## Budget

Estimates and approved caps (caps are 2× estimates): early-kill path ≈ $500
cap; full path ≈ $2,290 cap. Spend stops at a cap and is reported.
