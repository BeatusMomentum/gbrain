# Date-grounded extraction: held-out verdict (PASS)

Decision `p2-e2-heldout-2026-10-04` ran on the 7 sealed LoCoMo conversations (1,076 questions). The evaluation
custodian ran it under preregistration amendment 1 (gbrain-evals `docs/benchmarks/2026-10-04-p2-ranking-extraction-preregistration.md`).

The candidate was `extraction.date_grounding=true` on the frozen build. The baseline was the same build with the
setting absent. Both arms ran the decision kit's facts lane: gbrain's conversation-facts extractor on dated
conversation pages, two extractions per arm, and a fixed reader that answers from the saved facts with 10
replicates. The gate is correctness first. It decides on the share of saved facts that still hold a relative date
("yesterday", "3 days ago") with no absolute date. QA has to stay non-inferior.

| Gate | Baseline → candidate | 95% CI | Result |
|---|---|---|---|
| Primary: unresolved relative-date share in saved facts | 8.95% → 2.05% (−77% relative; bar ≥ 50%) | [−8.3, −5.5] pts | pass |
| Temporal QA from saved facts (lower bound ≥ −3 pts) | 67.5 → 68.3 | [−1.2, +2.7] | pass |
| Overall QA from saved facts (lower bound ≥ −3 pts) | 53.6 → 54.7 | [+0.6, +1.7] | pass |
| Page recall@5 (lower bound ≥ −1 pt) | unchanged | — | pass |
| Facts per conversation (within ±5%) | −0.3% | — | pass |

All 7 conversations improved individually on the primary metric.

## Default

`extraction.date_grounding` defaults on for fact extraction: the page hook, `extract_facts`, conversation facts and
the backstop. `false`, `off` or `0` opts out.

The verdict measured fact extraction only. The four other prompts that know the rule stay on their current prompts
unless the setting is set to `true` explicitly:
- life chronicle events;
- dream synthesis;
- extract_atoms;
- propose_takes.

The preregistration requires a per-consumer check before any of them changes. `gbrain doctor` (`extraction_date_grounding`)
reports which mode a brain is in.

Facts extracted before the default changed keep their original wording. Re-extracting a source is an explicit,
previewed action that needs the user's consent: `gbrain extract-conversation-facts --source-id <id> --dry-run`.

Development record: `../p2-date-grounding-dev/`.
