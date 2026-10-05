# Wave 9 lane A: pricing, caps, budget reservations

Integrator notes for the release files. No version stamp or CHANGELOG header
was written on this branch.

## CHANGELOG lines

- **DeepSeek caps now bound what DeepSeek bills.** `deepseek-flash` (new row) and the legacy `deepseek-v4-flash` price at $0.30 / $1.20 per 1M tokens and `deepseek-v4-pro` at $1.32 / $3.96, DeepSeek's peak rates (read 2026-10-05). The old $0.14 / $0.28 and $0.435 / $0.87 rows let a cap under-enforce by up to about 4.5x on output. Estimates that use a DeepSeek row say `(DeepSeek at peak rates, an upper bound; off-peak bills half)`. The recipe lists `deepseek-flash` first for chat and expansion. The OpenRouter `deepseek/deepseek-v4-flash-0731` row is now OpenRouter's own rate ($0.0152 / $1.28). (A-N1, #5847)
- **`gbrain brainstorm` and `gbrain lsd` run on a model gbrain has no price for.** With no cap flag the $5 default warns and runs it (priced calls stay metered; the estimate, mid-run and new pre-judge checks count it at Sonnet rates, so an oversized run still stops). `pricing.overrides` now reaches the run. An explicit `--max-usd N` refuses a run that would call an unpriced chat, judge or embedding model before any work and names the `gbrain pricing set` command. `gbrain doctor`'s `brainstorm_health` names an unpriced brainstorm model. Builds on #5959 by @andreineacsu. (#5873)
- **`gbrain skillopt` no longer refuses a valid model only because it has no price.** The $5 default warns and runs it; an explicit cap refuses it in the preflight, before any spend, with the shared guidance. The preflight no longer invents Sonnet rates: it uses `pricing.overrides` and the claude-cli sibling rate, and shows `Est. cost: unpriced (...)` for a model nothing prices. (#5563, A-N4)
- **One cost-cap flag everywhere: `--max-usd N|off`.** `brainstorm`, `lsd`, `skillopt`, `enrich`, `onboard` and `eval longmemeval` share one parser. Legacy spellings keep working (`--max-cost`, `--max-cost-usd`, `--no-max-cost`). A malformed value, a bare `0` or two disagreeing cap flags are refused before any paid call; `enrich` and `onboard` used to ignore them silently. brainstorm, lsd and skillopt print one `cap: ...` line naming the cap and how to remove it; brainstorm's `--json` result carries `cost.cap_usd` and `cost.cap_source`. (D19)
- **`gbrain pricing set 'claude-cli:*' --rate 0`** prices every claude-cli model at once for subscription users. Only providers that bill by subscription accept a wildcard; an exact model entry still wins; `gbrain pricing list` names the models it covers and labels it an operator assumption. (D20)
- **synthesize_concepts meters claude-cli models and `pricing.overrides` correctly** instead of the Sonnet fallback, and names any model it had to meter at the fallback in `details.pricing_fallback_models`. (A-N2, #5166)
- **Concurrent paid calls can no longer slip past a cost cap.** Each budget reservation is settled by its own id: a small call finishing first no longer frees a large in-flight call's hold, and an attempt that never reached the provider (unknown provider, invocation policy refusal) no longer keeps its hold or gets charged. (eng I6)
- **CI: every model a recipe lists is priced or declared unpriced** (`bun run check:recipe-pricing`). (X1)

## Upgrade-note rows

| Who | What changes | What to do |
| --- | --- | --- |
| DeepSeek users with a cost cap | Caps and estimates use rates up to about 4.5x the old DeepSeek rows; a run that fit before may now stop at the cap | Raise the cap, or register your own rate: `gbrain pricing set deepseek:deepseek-flash --input <usd> --output <usd>` |
| brainstorm / lsd / skillopt on an unpriced model, no cap flag | Runs with a warning instead of exiting with `no_pricing` | Nothing; to meter it, `gbrain pricing set <model> ...` |
| Scripts passing `--max-cost 5` / `--max-cost-usd 5` on an unpriced model | Still refused, now before any work, with the registration command | Register the rate, or pass `--max-usd off` |
| `enrich` / `onboard` scripts passing `--max-usd 0` or a typo | Refused (exit 2 / usage error) instead of silently falling back | Pass a positive amount or `--max-usd off` |
| `skillopt --max-cost-usd 0` | Still uncapped, with a deprecation note | Write `--max-usd off` |
| Queued skillopt jobs from before the upgrade | Keep the old fail-closed cap behavior (no `max_cost_source` stored) | Nothing |
| claude-cli subscription users | Can price all claude-cli models at $0 in one line; this voids every cap for claude-cli calls | `gbrain pricing set 'claude-cli:*' --rate 0` only if that is what you want |

## Notes for the integrator

- No migrations.
- `src/core/budget/no-pricing.ts` is unchanged (interface and guidance text); brainstorm and skillopt call `noPricingGuidance` / `noPricingMessage` / `noPricingFix` / `pricingSetCommand`.
- `BudgetTracker.reserve()` now returns a `BudgetReservation | undefined`; `record()` settles only the id it is given and `release(id)` frees an unbilled attempt. Lane B's fallback hops and Lane C's probe budget should keep the id from each `reserve()` and pass it to `record()` or `release()`; an id-less `record()` settles nothing.
- `priceFor(model, kind, overrides)` in `src/core/budget/reservation-cost.ts` is the shared resolver for Lanes B and C.
- Regenerated: `src/core/cli-flag-registry.generated.ts` (new `--max-usd` on brainstorm, lsd, skillopt).
