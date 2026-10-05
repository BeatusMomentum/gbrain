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

## Harness

gbrain-evals `eval/runner/p4-stream/` (branch `capy/p4-streaming-harness`,
`4c98318` at preregistration; the sealed run pins its own commit here first):

- Each cell (question × arm × model) gets a fresh PGLite brain built by the
  arm's gbrain build, served as `gbrain serve --surface starter` over stdio.
  The agent sees the starter tools and the first 2,048 characters of the
  server instructions (Claude Code's per-server cap).
- Haystack sessions stream in date order. A session's turns up to its last
  user message are replayed as history; the last user message is a live turn
  with a 700-token reply cap. Before each live turn the build's real
  `gbrain hook user-prompt` runs against a Claude Code-shaped transcript and
  its `additionalContext` is injected as a system reminder.
- When the next session would pass 95% of the window, `gbrain hook compact`
  runs, the model summarizes the conversation (2,500-token cap), a
  `compact_boundary` line is written, the history is replaced by the summary,
  and `gbrain hook session-start` (source `compact`) is injected.
- The question is a final live turn; its answer is judged 10 times with the
  LongMemEval judge prompt and `gpt-4o-2024-08-06`.

## Arms

| Arm | gbrain build | What the agent gets |
|---|---|---|
| A | master `6622a119e` | Baseline. |
| A′ | gbrain#6025 head `5c82936a2` | Baseline with the MCP instructions reordered so prompt-critical clauses start under the 2,048-char cap (built from that PR's commit, per the custodian's direction; master once it merges). |
| B | A′ merged with this PR (`73bd681cb`); `memory.core.enabled=false`, `memory.pressure.enabled=true`, `memory.pressure.context_window` = the window | Notice at 80% fill; `remember` with `items`. |
| C | same build; `memory.core.enabled=true`, `memory.pressure.enabled=false` | The profile page is core and loaded every session. |
| D | same build; pressure on, core on, `memory.core.remote_edit=notify` | Both, with remote edits to core allowed. |

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
- Evidence-saved rate: share of non-abstention questions where the agent saved
  at least one fact (`remember`) while a gold evidence session was live. Also
  reported: whether `recall` with the question as query returns one of those
  facts in its top five.
- Cost per question (agent, gbrain's own provider calls, profile page), from
  the budget ledger.
- Pressure notice fire rate (questions where it fired at least once) and miss
  rate (compaction segments with no notice before the compaction).

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

## Power (measured on development data before any sealed cell)

The 20-question claude-sonnet-5-5 pilot
(`docs/eval/decisions/p4-stream-dev-pilot/`) measured a per-question SD of
0.40 (B − A′) and 0.51 (C − A′). Detecting +3.0 points at 80% power with the
95% CI excluding zero needs about 1,380 (B) and 2,270 (C) questions per model,
more than LongMemEval-S holds. The sealed slice size, source and budget are
decided by the custodian and the user from these numbers and recorded here
before any sealed cell runs.

## Sealed design (written 2026-10-05, before any sealed cell)

Budget: the eval cap is $2,500 (raised from $1,400 on 2026-10-05 with Garry's
approval, relayed by the custodian), dev spend included; about $205 is spent on
development runs.

**Pressure gate (decides `memory.pressure.enabled`).**
- Gate model: claude-sonnet-5-5. Arms A′ and B; B is this PR's build with the
  growth-aware trigger, merged with the A′ build.
- n = 200 questions, window 32k, judge 10x. With the development SD of 0.69,
  200 questions detect an effect of +13.6 points at 80% power with the 95% CI
  excluding zero; the development effect was +50.0 [+20.0, +75.0].
- Source: named by the custodian before the run (proposed: 200 LongMemEval-S
  questions drawn by the custodian's seed from the 480 that never ran through
  this harness; the 20 development questions are excluded).
- Pass bar: B − A′ ≥ +3.0 points with the CI lower bound above 0 and no
  question category below −2.0 points. Cost: the development run cost +72% per
  question, so the original "cost ≤ +25%" criterion is replaced, pending the
  user's confirmation, by "cost per correct answer no higher than A′'s"
  (development: $3.83 for B against $6.68 for A′).
- Estimated cost: about $920.

**Report-only slice (decides nothing).** claude-opus-5-5, gpt-6.1-sol and
claude-fable-5-1, arms A′ and B, on the first 25 of the 200 sealed questions.
Estimated cost: about $860. Reported after the gate model, with ceilings
called out.

**Core gate (decides `memory.core.enabled`).** LongMemEval-S cannot exercise
core (see Power). The gate moves to BEAM-100k `preference_following` and
`instruction_following` questions on the 14 sealed conversations (56
questions, clustered by conversation): every arm gets the same question-blind
page of standing preferences and instructions, written by a fixed model from
the whole conversation without seeing any question; only arm C marks it core,
so C − A′ measures always-loaded delivery against retrieval of the same page.
Pass bar: C − A′ ≥ 0 and neither category below −2.0 points. This arm runs
only after the harness supports BEAM (one stream per conversation, all its
questions asked at the end, BEAM rubric judge) and a development check on the
6 development conversations (about $30) shows the arms run as intended.
Estimated sealed cost: about $80.

E2 (live delivery, $4 cap) and E3 (latency) run as specified below.

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
