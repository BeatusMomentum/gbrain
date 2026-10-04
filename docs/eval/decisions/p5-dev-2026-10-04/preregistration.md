# P5 preregistration: typed line grammar, wanted pages, similar-page hint

Decision id `p5-dev-2026-10-04`, kit `bun run eval:decide` (gbrain-evals). The candidate SHA in `decision.json` is the
dev-run build; the custodian pins the frozen build at confirmation. Sealed runs are executed by the custodian only.

## Features and the default each verdict decides

| Feature | Config key | Default if the held-out bar passes | If it fails |
|---|---|---|---|
| Wanted pages: unresolved authored links recorded and re-linked when the target appears | `wanted_pages.enabled` | on | off |
| Typed relation lines (`- works_at [[companies/x]]`) | `line_grammar.enabled` | on | off |
| Similar-page hint when a write creates a page | `put_page.similar_pages` | on | off |
| Validity ranges stored on edges (`@effective[start,end)`) | needs the edge-validity schema | measured after it lands | — |

Fact lines (`- [category] claim`) are parsed, linted and reported; they are not projected into `facts`, and no
default rides on them. The per-edge verb attachment fix in link-type inference is a correctness fix covered by the
type-accuracy guardrail (H1).

## Hypotheses, metrics and bars

**H1 — no regression in link typing.** BrainBench `type-accuracy` on world-v1 (240 pages), baseline vs candidate.
Metric: `anyTypeMatch` per gold edge (noninferiority, tolerance 0.01), plus type accuracy and strict F1.
Bar: noninferior; pages without relation lines extract identically with the grammar on and off.

**H2 — written relation types reach the graph.** world-v1 variant: half of the person pages state their outgoing gold
relationships only as relation lines (prose removed), plus decoy lines (prose after the link, two links, multi-word
unquoted type, stoplisted word, machine-written section, undeclared verb). Metrics: typed-edge recall on rendered
lines; decoy lines whose stated type reaches the graph, candidate minus baseline. Bar (held-out generator seed with
templates not used in dev): recall >= 0.98; decoy types added by the grammar = 0.

**H3 — junk stays out.** False-positive audit: grammar lines minted per 1,000 list lines and precision on 300
held-out list lines labeled by two judge models with human adjudication. Corpora: LongMemEval-S haystack sessions as
markdown, LoCoMo transcripts, a permissively licensed public notes vault. Bar: precision >= 0.95; zero lines minted
from timecodes, task markers, citations, dates or machine-written sections. gbrain's own docs and skills,
amara-life-v1, transcript-distill-v1 and world-v1 were read in development and are dev data only.

**H4 — forward references heal.** world-v1 written page by page in a seeded shuffled order with a stale sweep every
10 pages, against an all-at-once import (reference); and a withheld variant with 20% of person/company pages removed.
Metrics: reference edges missing after the sequential import; recall of withheld entities among `wanted_pages`
targets; share of wanted targets that are not entity-shaped. Bar: zero edges lost; recall >= 0.9; non-entity share
<= 10%. An HTTP-transport arm runs once remote link reconciliation writes wanted rows.

**H5 — fewer duplicate pages.** (a) N4 entity ledger: a create titled with each solvable mention and each no-referent
name; metrics: recall@3 of the true page per mention family, and the hint rate on no-referent names. Bar: recall@3 >=
0.9 on lexically detectable families (exact name, exact slug, typo, initials, declared alias, changed name); hint rate
on no-referent names <= 10% (the held-out set needs at least 50 no-referent names). (b) Agent loop, Claude Sonnet 5.5
and GPT-6 sol, "save these notes" tasks with 30% existing entities under variant names and 20% similar-but-different
entities, no tool-result caps: duplicate-page rate down >= 25% relative and wrong-merge rate up <= 1 point.

**H6 — typed lines help answers.** Agents ingest amara-life-v1 conversations and write the brain: arm A is master with
equally good guidance for the existing mechanisms (frontmatter link fields, add_link, the Facts table, remember); arm
B adds the relation-line convention and the feature. 400 sealed paired relational and temporal questions; judge 10x
mean±SD, paired bootstrap 95% CI. Bar: B − A >= +3 points with CI lower bound > 0, no regression > 1 point elsewhere.
`line_grammar.enabled` needs H1, H2, H3 and H6. H6 runs only if H1–H3 pass.

Guardrail: LongMemEval-S retrieval (`lme-s-dev` in `decision.json`), noninferior.

## Budget

Cap $1,300. H1, H2, H4, H5a are deterministic ($0). H3 ≈ $20 in judge labels. H5b ≈ $300. H6 ≈ $700–1,000.
LME-S guardrail ≈ $24 per run.

## Dev disclosures

- Dev seeds used: H2 and H4 generator seeds 1–3 (dev diagnostics, not kit receipts); H5a N4 ledger seeds 1–3. The
  custodian should draw held-out seeds outside {1, 2, 3}.
- Guard tuning used gbrain docs/skills (all of it): categories reject digits and all-caps markers.
- The link-type attachment fix was developed against two failure shapes reported from the edge-validity plan's dev run
  and measured on world-v1 type-accuracy (dev).
