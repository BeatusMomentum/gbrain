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
- The streaming agent loop, splits, judge prompt and judge model come from the
  shared held-out harness (gbrain-evals `p0-heldout-harness`, inspected at
  `2ab6eff`). At that commit the agent-compaction scenario is scheduled for the
  harness's milestone M2 and LongMemEval-S has no held-out portion (all 500
  questions are development data). The sealed source for E1 is therefore
  named by the harness custodian with M2 and recorded here, with the harness
  commit, before any sealed cell runs. Until then E1 runs on development data
  only and sets no default.
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

The newest frontier model of each family, per the gbrain eval model rules
(checked 2026-10-04): claude-sonnet-5-5, claude-opus-5-5, gpt-6.1-sol and
claude-fable-5-1, each on the same fixed slice of the sealed source (drawn by
the harness seed before any run; size set with the sealed source so the
budget below holds). claude-sonnet-5-5, the model most users run, is reported
first.

Change log: the first draft named gpt-6-luna (full split) and
claude-sonnet-5-5 (150-question slice). It was revised on 2026-10-04, before
any cell ran, to follow the eval model rules (newest model of each family);
the budget is re-estimated with the slice size.

## Metrics

- Judged accuracy, 10 judge passes per answer, reported as mean ± SD, overall
  and per LongMemEval question category.
- Evidence-saved Recall@5: share of questions whose gold evidence session has a
  saved fact in the top 5 recall results for the question.
- Cost per question (agent + judge), from provider receipts.
- Pressure notice fire rate (questions where it fired at least once) and miss
  rate (compactions with no notice in the preceding segment).

## Pass bars (sealed source, paired bootstrap 95% CI over questions)

- **Pressure notice stays on by default** if, on claude-sonnet-5-5, B − A′ ≥
  +3.0 accuracy points with the CI lower bound above 0, no question category
  drops by more than 2.0 points, cost per question rises by at most 25%, and
  B − A′ is not negative on any other model. A model at 100% on every arm is
  reported as a ceiling and does not count either way. Otherwise
  `memory.pressure.enabled` ships `false`.
- **Core delivery stays on by default** if C − A′ ≥ 0 on every model and no
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

Hard cap $1,400 for all E1 runs, dev and sealed; the sealed slice size is chosen
so the four-model estimate fits it. The live
delivery check (E2) is capped at $4. Latency check (E3): session-start p95 under
1,500 ms with a full 4,000-char core, and non-core `put_page` overhead under
5 ms.
