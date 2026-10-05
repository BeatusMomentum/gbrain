# Fix wave 9, lane B: routing and judges (integrator notes)

Release files are the integrator's. This file holds the lane's CHANGELOG lines
and upgrade-note rows. No migrations. One new config key.

## CHANGELOG lines

- **Subagent turns no longer die at 5 minutes.** Each turn of a background
  subagent job now runs up to `ai.chat.per_turn_timeout_ms` (default 30 min,
  the subagent job budget) or the job's own deadline, whichever comes first,
  instead of the gateway's 300 s chat backstop. A long thinking-model or
  claude-cli turn used to be cut off with nothing written, and the retry hit
  the same wall. The oneshot synthesis call gets a quarter of the job's time
  left, up to the same cap. Calls outside a job keep the 300 s backstop. (#4921)
- **Eval judges turn thinking off.** `chat({ thinking: 'off' })` is a
  provider-agnostic per-call switch: native Anthropic, DeepSeek and
  OpenRouter DeepSeek get their thinking switch (a configured thinking budget
  is replaced, cache settings kept); a thinking-by-default model without a
  switch keeps thinking and gets the thinking output headroom. The
  takes-quality, cross-modal and synthesize triage judges use it, so a
  2000-token judge cap is no longer spent on reasoning. Thanks to @kvnloo
  (#5972) for the call-scoped override test. (#5331)
- **A malformed takes-quality judge reply gets one correction.** A reply that
  is unparseable (including empty) or misses a rubric dimension is re-asked
  once with the same model, the same sample and the validator's error,
  priced against `--budget-usd` before it is sent. Provider errors and valid
  low scores are never re-asked. Receipts gain `protocol_version: 2`,
  `correction_selection_rule` and `corrections`; `regress` reports a
  protocol change as a dissimilar input. (#5325)
- **A missing model is no longer reported as a bad key.** A provider 404
  ("model does not exist or you do not have access") is now its own class,
  `model_not_found`, instead of `auth`. The error names the model and
  provider, points at `gbrain models`, and suggests
  `deepseek:deepseek-flash` for the renamed `deepseek:deepseek-v4-flash`.
  Facts extraction logs `gateway_model_not_found`. (B-N7)
- **Fallback chain safety fixes.** The `edge_contradictions` judge keeps its
  own model (its apply mode depends on which model it certified). With
  `chat_fallback_on_refusal false`, an HTTP 400 content-policy refusal
  (OpenAI `invalid_prompt`, Azure `content_filter`, DeepSeek "Content Exists
  Risk") is no longer sent to the next model. A cancel that lands while a
  model refuses returns the refusal instead of forwarding it. (#6012 audit)

## Upgrade-note rows

| Change | Who notices | Before | Now | Action |
| --- | --- | --- | --- | --- |
| Subagent per-turn timeout | autopilot / dream synthesis users on slow or thinking models | each turn aborted at 300 s | up to 30 min per turn, bounded by the job deadline | none; tune with `gbrain config set ai.chat.per_turn_timeout_ms <ms>` |
| Judges run with thinking off | takes-quality, cross-modal, synthesize triage on Anthropic / DeepSeek with thinking configured | the configured thinking budget applied to judge calls | judge calls disable thinking on routes with a switch | none |
| Takes-quality protocol 2 | anyone comparing receipts over time | a malformed slot was dropped | one correction per malformed slot, recorded in `corrections` | compare protocol 2 receipts with each other; `regress` flags a protocol change |
| `model_not_found` class | operators reading phase halts, `ingest_log` or facts errors | a 404 read `auth` / `gateway_auth` | reads `model_not_found` / `gateway_model_not_found` | fix the model id (`gbrain models`), not the key |
| Fallback refusal and judge pinning | users with `chat_fallback_chain` set | content-policy 400s fell back even with `chat_fallback_on_refusal false`; the edge judge could fall back | neither happens | none |

## New config key

- `ai.chat.per_turn_timeout_ms` (DB plane, integer ms, default 1800000):
  the per-turn chat timeout for subagent jobs. Invalid or non-positive values
  fall back to the default.
