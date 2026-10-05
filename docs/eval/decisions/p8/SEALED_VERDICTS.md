# P8 held-out verdicts

Each part's held-out result, measured by the custodian (P0) against the gates in
[PREREGISTRATION.md](PREREGISTRATION.md). A part turns on by default only when its row says PASS.

| Part | Gate | Held-out result | Verdict | Default |
|---|---|---|---|---|
| Write cost (section 2) | commit-path generative attempts = 0 in both arms | 0 in the extraction-on and extraction-off arms | PASS | Guard on; cost published |
| Quote grounding (section 6) | supported spans wrongly flagged, Wilson 95% upper bound ≤ 5% | 4.7% wrongly flagged, upper bound 7.6% | FAIL | `think.quote_verify` and `dream.quote_verify` off by default (opt-in) |
| Semantic withdrawal review (section 3) | precision LB ≥ 0.90, end-to-end recall ≥ 0.60, zero proposals on corrected values, N5 unchanged | precision LB 0.970 (124/124 eval families, 248 actions), end-to-end recall 0.977, 0 proposals on corrected values, N5 contracts pass | PASS | `review_withdraw` on (proposes where the conflict slot is on with a TypeSafe key); reference calibration shipped |
| Advertised tool surface (section 7) | pooled success ≥ control − 3 pts, no leak rise, hidden-tool family ≥ control − 5 pts | pending | — | new installs advertise `full` |
| HTTP graph freshness (report-only) | remote `put_page`: timeline row at commit; mention links after the `links` effect; typed edges only after extract | as stated, on PGLite (`test/remote-graph-freshness.test.ts`) | REPORT | no switch |
| Duplicate review kinds (section 4) | per kind, as section 3 | not run until P1/P5 enqueue candidates | — | off |

## Quote grounding

The held-out failure keeps the new quote grounding (think answers and the `synthesize` verb, `think --save`,
concept narratives, pattern pages) opt-in: `gbrain config set think.quote_verify true` and
`gbrain config set dream.quote_verify true`. The dream synthesis quote check that predates P8
(`dream.synthesize.quote_verify`, default on) matches master exactly: the matching tolerance P8 adds (markdown
link syntax read as its text, punctuation and elision at a quote's edges) applies only to the opt-in coverage's
sources (`groundSource(…, { tolerant: true })`), because the held-out run measured it only as part of that
coverage, which failed.

Follow-up: the over-flagging. The dev runs measured 1.3% after the edge-punctuation and link-syntax fix; the
held-out set flags 4.7%, so supported quotes still fail on forms the dev questions did not contain. The next step
is to read the held-out wrongly-flagged spans with the custodian (without tuning on the sealed questions) and
re-run on a fresh held-out set.

## HTTP graph freshness (report-only)

Measured on master with #6025 (remote bulk writes and mention links) merged in. A remote OAuth `put_page` with a
dated timeline bullet and `[[people/alice-example]] … works at [[companies/acme-example]]`:

| Stage | What is queryable | Time from submit (PGLite, local run) |
|---|---|---|
| Commit | the page and its dated `timeline_entries` row; no links | 206 ms |
| `links` effect drained | `mentions` edges to the two visible same-source pages; no typed edge | 259 ms |
| `extract` phase | typed `works_at` edges added beside the mentions | 390 ms |

With `mcp.remote_auto_links=false` no mention pass is queued. Times are one local run on a small PGLite brain and
include no worker scheduling delay; on a served brain the mention links wait for the effect worker and typed edges
for the next extract (dream cycle or `gbrain extract`). #6025's own contract tests cover confinement, revoked
clients, restarts, superseded revisions and reconcile on PGLite and Postgres.

Lock order: #6025's effects take the brain row before the source row (`guardEffectSource`). P8's write paths take
no brain or source row lock (the `remember.replaces` target-fact lock lives inside the publication transaction,
the review queue row commits inside the withdrawal transaction, and attribution is async context only), so there
is no inverted order. The P8 Postgres E2E and #6025's links-effect E2E pass together on direct Postgres and through
transaction-mode PgBouncer.

## Semantic withdrawal review

Held-out record: gbrain-evals `docs/benchmarks/2026-10-05-heldout-verdicts/p8-withdraw-heldout-2026-10-05.json`
(build 6c958d6e2, reviewer TypeSafe `jev-1.13.0`). 240 families with disjoint name and value pools: 66 paraphrase
pairs written by Google Gemini and checked one by one by the custodian (7 rewritten, 0 dropped; the 2026-10-05
amendment), 414 model restatements, and 240 each of corrected values, negations, past-tense versions, compound
claims and independent facts. Calibrated on the 116-family half (threshold 0.62, precision and recall 1.0);
qualified on the 124-family half: 124/124 families correct over 248 withdraw actions (Wilson lower bound 0.970).
Retrieval at the 0.80 cosine floor finds 97.7% of restatements (model 404/414, custodian-checked 65/66).

Default: `decide.slots.conflict.review_withdraw` is on unless turned off, and the binary ships the held-out
calibration as reference `conflict-review-withdraw-jev-1.13.0-2026-10-05`, so the lane proposes wherever the
conflict slot is on with a TypeSafe key. It never withdraws on its own: every proposal needs the owner's accept.
