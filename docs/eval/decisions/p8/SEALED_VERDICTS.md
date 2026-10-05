# P8 held-out verdicts

Each part's held-out result, measured by the custodian (P0) against the gates in
[PREREGISTRATION.md](PREREGISTRATION.md). A part turns on by default only when its row says PASS.

| Part | Gate | Held-out result | Verdict | Default |
|---|---|---|---|---|
| Write cost (section 2) | commit-path generative attempts = 0 in both arms | 0 in the extraction-on and extraction-off arms | PASS | Guard on; cost published |
| Quote grounding (section 6) | supported spans wrongly flagged, Wilson 95% upper bound ≤ 5% | 4.7% wrongly flagged, upper bound 7.6% | FAIL | `think.quote_verify` and `dream.quote_verify` off by default (opt-in) |
| Semantic withdrawal review (section 3) | precision LB ≥ 0.90, end-to-end recall ≥ 0.60, zero proposals on corrected values, N5 unchanged | pending (paraphrase sourcing amended 2026-10-05) | — | `review_withdraw` off |
| Advertised tool surface (section 7) | pooled success ≥ control − 3 pts, no leak rise, hidden-tool family ≥ control − 5 pts | pending | — | new installs advertise `full` |
| Duplicate review kinds (section 4) | per kind, as section 3 | not run until P1/P5 enqueue candidates | — | off |

## Quote grounding

The held-out failure keeps the new quote grounding (think answers and the `synthesize` verb, `think --save`,
concept narratives, pattern pages) opt-in: `gbrain config set think.quote_verify true` and
`gbrain config set dream.quote_verify true`. The dream synthesis quote check that predates P8
(`dream.synthesize.quote_verify`, default on) is unchanged.

Follow-up: the over-flagging. The dev runs measured 1.3% after the edge-punctuation and link-syntax fix; the
held-out set flags 4.7%, so supported quotes still fail on forms the dev questions did not contain. The next step
is to read the held-out wrongly-flagged spans with the custodian (without tuning on the sealed questions) and
re-run on a fresh held-out set.
