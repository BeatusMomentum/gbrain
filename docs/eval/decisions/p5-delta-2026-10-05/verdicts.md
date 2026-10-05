# P5 delta: held-out verdicts

Delta build `970c3088b`, run by the custodian (P0). Each verdict sets the default the preregistration names.

| Hypothesis | Verdict | Result | Default |
|---|---|---|---|
| H7, validity ranges on typed relation lines | PASS | as-of accuracy on range pages 0.228 → 1.000, 95% CI of the difference [+0.695, +0.846]; prose pages unchanged | `line_grammar.effective_ranges` on |
| H9, link typing changes | PASS on both corpora (relation-line-variants world, temporal-edges held-out set) | noninferior to the frozen extractor | typing changes kept |
| N4 resolver guardrail | PASS | no new wrong merge; resolver outcomes noninferior | — |

Pending: H8 (blocked on the first run by `writer_coordinator_required` from the sweep's raw timeline insert on a
managed brain; fixed in `9d6b789f5`, rerun by the custodian), and the set G runs of H10 and H11 (second custodian).
