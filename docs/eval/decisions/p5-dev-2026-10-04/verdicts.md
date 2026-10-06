# P5 first run: held-out verdicts

The custodian (P0) ran every first-run cell on frozen build `21befeb5b` against baseline master `6622a119e`, under
`preregistration.md` and its amendments. Each verdict sets the default the preregistration's feature table names.
Delta-run verdicts (H7 to H11) are in `../p5-delta-2026-10-05/verdicts.md`.

| Hypothesis | Result | Verdict | Outcome |
|---|---|---|---|
| H1, link typing does not regress (world-v1) | any-type match 0.493 → 0.493; type accuracy 0.747 → 0.767; 240/240 pages extract identically with the grammar on and off | PASS | counts toward `line_grammar.enabled` |
| H2, written relation types reach the graph (template set B) | typed recall 0.811 → 1.000; 0 of 120 decoy types added | PASS | counts toward `line_grammar.enabled` |
| H4, forward references heal (local writes) | edges lost 1,849/3,810 → 0/3,738; withheld-entity recall 0 → 1.000 | PASS | `wanted_pages.enabled` on by default |
| H5a, similar-page hint on held-out name pools | lexical recall@3 0 → 0.980; hint on no-referent names 4.7% | PASS | H5b decides the default |
| H5b, agent loop duplicates (Claude Sonnet 5.5 and `gpt-6.1-sol`, 60 held-out tasks each) | duplicate-page rate 3.06% → 2.22% (−27% relative; 95% CI of the difference [−2.8, +1.1] points, crosses 0); wrong-merge rate 2.50% → 3.75% (+1.25 points against a bar of at most +1) | FAIL | `put_page.similar_pages` off by default; still available with `gbrain config set put_page.similar_pages true` |
| H3, junk stays out | | pending | `line_grammar.enabled` needs H3 and H6 |
| H6, typed lines help answers | | pending | runs after H3 |

## H5b by model

| Model | Duplicate-page rate | Wrong-merge rate |
|---|---|---|
| Claude Sonnet 5.5 | unchanged | unchanged |
| `gpt-6.1-sol` | 2.8% → 1.1% | 5.0% → 7.5% |

All of the movement is in the GPT arm, where duplicates fell and wrong merges rose. The wrong-merge bar fails, so the
hint ships off by default. The duplicate reduction would not have passed on its own either, since its interval
includes zero.
