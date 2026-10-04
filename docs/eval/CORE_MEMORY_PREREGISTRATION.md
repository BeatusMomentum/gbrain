# Core memory and pre-compaction save: preregistered evaluation

This file fixes the arms, metrics and pass bars for the always-loaded core
memory tier and the save-before-compaction path
([guide](../guides/core-memory.md)) before any sealed result exists. The
defaults these features ship with follow the sealed verdicts below; nothing in
this file changes after the first sealed run.

## Question

Does an agent that loses its context to compaction answer later questions
better when (a) it is told to save what matters before compaction and can save
several facts in one call, and (b) a small owner-designated profile is loaded in
every session?

## Benchmark

- **E1, streaming LongMemEval-S with forced compaction.** The agent reads each
  question's history session by session as a live conversation, with a 32k
  token context window (a 128k slice runs as a secondary check), so compaction
  fires several times per question. It answers the question at the end from
  its context plus whatever it saved in gbrain.
- Splits, judge prompt and judge model come from the shared streaming harness
  (P0): a frozen dev split for iteration and a sealed split that only the
  custodian runs. The harness commit is pinned in the dev report before the
  first dev run and is not changed afterwards.
- Every arm gets the same question-blind profile page (who the user is, built
  from the first session only, never from the question). Only arms C and D mark
  it as core.

## Arms

| Arm | gbrain build | What the agent gets |
|---|---|---|
| A | master | Baseline. |
| A′ | master + the MCP instructions reorder (separate change) | Baseline with prompt-critical instructions inside the 2,048-char cap. |
| B | A′ + `remember` `items[]` + pressure notice | Notice at 80% fill; batch save. `memory.pressure.context_window` set to the simulated window. |
| C | A′ + core delivery | The profile page is core and loaded every session. |
| D | B + C, agent may edit core | Both, with remote edits to core allowed (`memory.core.remote_edit=notify`). |

## Models

- gpt-6-luna on the full sealed split.
- claude-sonnet-5-5 on a fixed 150-question slice of the sealed split (slice
  drawn by the harness seed before any run).

## Metrics

- Judged accuracy, 10 judge passes per answer, reported as mean ± SD, overall
  and per LongMemEval question category.
- Evidence-saved Recall@5: share of questions whose gold evidence session has a
  saved fact in the top 5 recall results for the question.
- Cost per question (agent + judge), from provider receipts.
- Pressure notice fire rate (questions where it fired at least once) and miss
  rate (compactions with no notice in the preceding segment).

## Pass bars (sealed split, paired bootstrap 95% CI over questions)

- **Pressure notice stays on by default** if, on claude-sonnet-5-5, B − A′ ≥
  +3.0 accuracy points with the CI lower bound above 0, no question category
  drops by more than 2.0 points, cost per question rises by at most 25%, and
  gpt-6-luna's B − A′ is not negative. Otherwise `memory.pressure.enabled`
  ships `false`.
- **Core delivery stays on by default** if C − A′ ≥ 0 on both models and no
  category drops by more than 2.0 points. Otherwise `memory.core.enabled`
  ships `false`.
- D is reported but does not gate a default.

## Procedure

1. Iterate only on the dev split (this thread). Dev results never move a bar.
2. The custodian runs the sealed split once per arm and model at the final PR
   head, and records the verdicts with the run receipts in gbrain-evals.
3. The verdicts above set the shipped defaults; a failed bar flips the default
   off in the same PR before merge.

## Budget

Estimated $860 to $1,280 for all sealed and dev runs; hard cap $1,400. The live
delivery check (E2) is capped at $4. Latency check (E3): session-start p95 under
1,500 ms with a full 4,000-char core, and non-core `put_page` overhead under
5 ms.
