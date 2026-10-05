# Wave 9 lane C: the nightly quality probe tells the truth

For the integrator: CHANGELOG lines and upgrade-note rows for this lane. No
version header, no migration.

## CHANGELOG lines

- **The nightly quality probe uses your models.** The reader follows `models.eval.longmemeval` and then the reasoning tier, the trajectory extractor follows the utility tier, and the three judges follow the new `models.eval.cross_modal.slot_a` / `slot_b` / `slot_c` keys. Before, the probe ignored every brain-side model setting and paid for `anthropic:claude-sonnet-4-6`, `claude-haiku-4-5` and `claude-opus-4-7` even on brains routed to `claude-cli`. `gbrain models` now prints the probe's routes under "Nightly quality probe". (#5872, contributed by @andreineacsu, #6005)
- **`autopilot.nightly_quality_probe.max_usd` is a real cap now.** One budget covers every paid call of a run: the LongMemEval reader, extractor and query embeddings, then the judges. Before, the LongMemEval stage ran uncapped and the judges' cap was skipped by `--yes`. A run that hits the cap stops, makes no further paid call and records `budget_exceeded`, never `fail`. Under the default $5 cap a model with no price on file warns and runs; once you set `max_usd`, it is refused with the `no_pricing` guidance (`gbrain pricing set ...`).
- **A judge panel that is one model voting twice no longer reports pass or fail.** When one model holds two of the slots that judged (the sonnet/opus/sonnet panel an Anthropic-only brain got by default), or fewer than two models judged, the run is `inconclusive` with `reason: panel_collapsed` and the slot-key command to fix it. (#5506)
- **A probe run that did not pass keeps its evidence.** The audit row names the judge panel, each failing question with per-judge scores, the reader and extractor, metered chat spend (`chat_cost_usd`) and the run cap; the batch summary and LongMemEval output are kept under `~/.gbrain/audit/nightly-probe/<timestamp>/` (newest 7). (#5506, contributed by @andreineacsu, #6005)
- **Compiled installs run both nightly probes.** The quality probe and the conversation-parser probe now carry their fixtures inside the binary. Before, the quality probe failed every night with `nightly fixture not found at <your brain repo>/test/fixtures/...` and the parser probe skipped silently while doctor said ok. If a fixture is ever unreadable, the run records `skipped` with the reason and doctor warns instead of reporting ok. (#5187, C-N6; skip reporting reworked from @Masashi-Ono0611's #5257)
- **The probe no longer disturbs the autopilot daemon's AI gateway.** It keeps the daemon's brain-resolved gateway and no longer swaps the process-wide embedding transport for its run (the LongMemEval embedding cache is off for the probe). (C-N5)
- **Docs:** the probe is described as what it is, a synthetic 10-question smoke test of retrieval, answering and judging, not a health score for your brain; the cost section now uses metered spend.

## Upgrade-note rows (behavior changes)

| Change | Who notices | What to do |
|---|---|---|
| The nightly probe's reader, extractor and judges follow your brain's model settings | Brains with the probe enabled and `models.tier.*` / `models.eval.longmemeval` set | Nothing; check the routes with `gbrain models`. To keep the judges off metered APIs, set `models.eval.cross_modal.slot_a/b/c` to three different models. |
| A collapsed judge panel reports `inconclusive` instead of pass/fail | Anthropic-only brains with no slot keys (panel sonnet/opus/sonnet) | `gbrain config set models.eval.cross_modal.slot_a <model>` (and `slot_b`, `slot_c`) with three different models; one provider is enough. |
| `max_usd` caps the whole run, and a set value refuses unpriced models | Brains that set `autopilot.nightly_quality_probe.max_usd` and route the probe through a model with no price on file (for example a local or proxy model with no `pricing.overrides` entry) | Register the rate with the `gbrain pricing set` command the audit row names, or unset `max_usd` to go back to the warn-and-run default cap. A `max_usd` of 0 now means a $0 cap. |
| Compiled installs start running the nightly probes | Binary installs with the quality probe enabled, or `search.mode=tokenmax` (parser probe default-on) | Nothing; the first real run happens within 24h. Doctor's `nightly_quality_probe_health` / `conversation_parser_probe_health` show the result. |
| New audit outcome `skipped` | Anyone reading `quality-probe-*.jsonl` / `parser-probe-*.jsonl` | Treat it as "no signal": the probe could not run; the row's `reason`/`detail` says why. |
