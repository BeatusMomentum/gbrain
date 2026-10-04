# P3 preregistration: use-attributed retrieval feedback and relational triplet scoring

This file fixes, before any held-out data is opened, what the P3 held-out runs measure, on which data, and which
result turns each feature on by default. The custodian freezes it (with any edits recorded below the line at the end)
before the first sealed cell runs. Dev results that informed it are listed in [Dev evidence](#dev-evidence); none of
them is eligible to set a default.

## Builds

| Arm | Build | Settings |
|---|---|---|
| Baseline | gbrain `master` at the P3 merge base (`5bd9e8497`) | as shipped |
| Feedback | P3 pull-request head (frozen SHA recorded at handoff) | `feedback.enabled=true`, `feedback.influence=0.1`, `search.triplet_scoring=false` |
| Triplet | same build | `feedback.enabled=false`, `search.triplet_scoring=true`, `search.triplet_penalty=3.0` |

Every arm runs on its own copy of the trained database, and scoring runs with `feedback.learn=false`, so scoring
calls, judge repetitions and sealed questions never change the state under test. Embeddings come from one
content-addressed cache that is warm before either arm runs, so both arms read identical vectors (a cold cache lets
fresh provider vectors and cached vectors differ in the last float bits, which reorders near-ties; see the dev
guardrail note below).

`feedback.influence` (λ) is fixed at **0.1**, the shipped default. λ = 0.05 and 0.2 are reported as exploratory rows.

## Data and splits

| Corpus | Split | Unit |
|---|---|---|
| LoCoMo | P0 split `eval/decisions/splits/locomo.json` (gbrain-evals): 3 dev conversations, 7 sealed | conversation = one brain |
| LongMemEval-S | P0 split `eval/decisions/splits/lme-s.json` | question (own haystack) |
| world-v1 relational (template + paraphrase) | proposed: [`world-v1-relational-split.json`](world-v1-relational-split.json), 73 dev / 72 sealed base questions, P0 method (`sha256(salt, NUL, id)` order, salt `gbrain-evals-heldout-split-v1`, first half dev); template and paraphrase forms of one question share a half | one shared brain |
| NamedThingBench core + relational | as committed | query |

The world-v1 split is a proposal: P0 has no world-v1 split yet. Only its dev half was read. The custodian adopts it
or replaces it before any sealed world-v1 cell; a replacement must still exclude every dev base question listed in it.

## Experiments and pass bars

All bars apply to sealed data only. Confidence intervals are cluster bootstraps (cluster = conversation for LoCoMo,
base question for world-v1), 1,000 resamples or more.

**E1. Feedback with oracle ratings (judge-free upper bound).** Per brain, questions stream in a fixed seeded order.
After a training question, each returned page gets a targeted rating (5 if gold, 1 if not). Arms: (a) train on dev,
freeze, score sealed; (b) online predict-then-update over the whole stream, metrics on sealed questions only;
(c) 20% of labels flipped; (d) exposure-frequency weights from dev with no ratings. Metrics: NDCG@10 (primary) and
Recall@5. The cold-start subgroup (sealed questions whose gold pages never appeared as gold in a training answer) is
reported separately.

**E2. Feedback from the implicit citation signal only.** LoCoMo: `think` on dev questions drives the `cited` signal;
frozen and online arms; full density and a 25% subsampled sparse arm. Sealed: `think` in both arms, judge mean of 10
repetitions ± SD (P0 judge) plus judge-free Recall@5 of the gather. Reported: implicit events per 100 answers.
The `think` model is the frozen build's default.

**E3. No-regression guards.** LongMemEval-S sealed: retrieval lists identical between baseline and feedback arms
(no ratings exist, so the stage must be a no-op). NamedThingBench core + relational with weights trained on world-v1
dev: 0 hit@1 losses. p50/p95 read latency deltas.

**E4. Triplet scoring.** E4a (wider relational fetch only) and E4b (wider fetch + triplet scoring) against baseline on
relational-paraphrase-v1, NamedThingBench relational and a constrained-relational set over world-v1. Precondition:
the relational arm fires on at least 80% of E4 questions. Metrics: NDCG@10 and hit@3.

Default decisions (the per-corpus E1 reading and the fixed λ were approved on 2026-10-04, before any sealed data was opened):

- **Feedback ON by default** iff all hold: E2 judge mean +1.0 point or more with CI excluding 0 in the frozen and
  online arms, and the sparse arm still positive; E1 NDCG@10 improves with CI excluding 0 and beats arm (d); the
  cold-start subgroup loses at most 1.0 NDCG@10 point; no category drops more than 1.0 point; E3 shows zero
  LongMemEval change, 0 NamedThingBench hit@1 losses and p95 latency +10 ms or less.
- E1 is evaluated **per corpus** (LoCoMo and world-v1 separately); "E1 passes" requires both. If world-v1 passes and
  LoCoMo fails, feedback ships with `feedback.enabled=false` (opt-in, explicit ratings only, `feedback.implicit=false`).
- If E1 passes but E2 does not: ship with `feedback.enabled=false` as above.
- If E1 fails on both corpora: the feedback subsystem leaves the pull request.
- **Triplet scoring ON** iff E4b sealed NDCG@10 +2.0 points or more with CI excluding 0 and 0 hit@1 losses on the
  plain relational sets; E4a ships alone if it alone passes the same bar. Otherwise `search.triplet_scoring` stays off.
- Declared single-value relations (plan E5) are not part of this pull request.

Budget caps: E1 $16, E2 $180, E3 $20, E4 $12 (plan total cap $260, which also covered the dropped E5).

## Harness requirements

The P0 decision kit (milestone M1) runs independent-question memory-qa sources and category runners as-is. These runs
additionally need, from milestone M2 or the custodian: the sequential replay mode with a per-question rating callback
(frozen and online orders, `feedback.learn=false` scoring, per-arm database copies); `think` replay with judge 10x for
E2; arm config applied to category runners (E4 sets `search.triplet_scoring`); the relational-arm fire rate.

## Dev evidence

Dev data only; nothing here can set a default.

**Guardrail (P0 kit, decision `p3-feedback-guardrail-dev-v2`).** Baseline `master` against the P3 build with
feedback on and no ratings ([`../p3-feedback-guardrail-dev-v2/`](../p3-feedback-guardrail-dev-v2/), build `5e5fdcbbe`):
identical retrieval lists on all 587 LoCoMo dev questions and on a 100-question LongMemEval-S dev subset (Recall@5
0.7565 and 0.9479 on both arms), mean read latency +1.2 ms and +1.1 ms, p95 +3.0 ms and +0.9 ms. An earlier run
with a cold embedding cache showed adjacent near-tie swaps in 18 of 587 LoCoMo lists (and 6 of 100 LongMemEval-S
lists) with identical metrics; the same comparison with a warm cache shows 0 of 587, and a master-against-master run
shows 0, so the swaps came from cache warm-up, not from the feature.

**E1-shaped replay on dev questions** (oracle ratings; a held-back half inside the dev questions is scored; build
`ce8092562`; cost $0.02). ΔNDCG@10 in points against feedback off, with a dev-only question-resampling 95% interval:

| Corpus (scored questions) | λ | Frozen | Online | 20% noise | Frequency only |
|---|---|---|---|---|---|
| LoCoMo dev (236) | 0.05 (positive-only labels) | −0.35 [−0.9, 0.2] | +0.02 [−0.5, 0.5] | −0.29 | −1.15 |
| LoCoMo dev (236) | 0.1 | −0.34 [−1.4, 0.7] | −1.08 [−2.4, 0.1] | −2.13 | −4.02 |
| LoCoMo dev (236) | 0.2 | −3.67 [−5.6, −1.4] | −2.72 [−4.4, −0.8] | −4.56 | −7.89 |
| world-v1 relational dev (74) | 0.05 | +1.32 [0.4, 2.6] | +1.77 [0.6, 3.4] | +0.84 | +0.17 |
| world-v1 relational dev (74) | 0.1 | +1.71 [0.5, 3.3] | +2.48 [0.7, 4.6] | +0.42 | −0.80 |
| world-v1 relational dev (74) | 0.2 | +2.20 [0.6, 3.9] | +4.70 [2.7, 7.3] | +1.46 | −1.33 |

Reading: on a shared entity brain, where the same people and company pages answer many different questions,
learned usefulness transfers and beats exposure frequency. On conversation sessions, where a session that answers one
question is usually wrong for the next, a page-level weight does not transfer and costs ranking quality, more so at
higher λ. That is why E1 is judged per corpus above. Raw summaries: [`dev/`](dev/).

---

Custodian edits (dated, with reason) go below this line.
