# Wave 9 follow-ups, lane J: judge thinking caps (item 5)

Branch `capy/w9f-lane-j`, based on origin/master 9cc7c4677 (v0.60.99.0). No version bump, no CHANGELOG header; the release lines below are for the integrator.

## Verdict

Item 5 is confirmed on current master and fixed on this branch. Re-verification on 9cc7c4677:

- `chat()` raised a `thinking: 'off'` call's cap to 32,000 only for a thinking-by-default route without a switch (`gateway.ts:3461` on master), but the takes-quality projection priced `estimateCost(m, 5000, 2000)` (`takes-quality-eval/runner.ts:223`, `:259`) and the cross-modal preflight priced `maxTokens` (`cross-modal-eval/runner.ts:410`).
- `thinking-off.ts` had no Google or OpenAI row and `recipes/google.ts` declares no `thinking_by_default`, so `google:gemini-2.5-flash` on the default takes-quality panel ran with dynamic thinking inside the 2,000-token cap.
- The live probe below settles the open question: Gemini thoughts are billed inside `maxOutputTokens`. At a 128-token cap with no thinking config, gemini-2.5-flash spent 120 tokens thinking and returned `{"score": ` with `finishReason: length` (case G1b); gemini-3.8-flash did the same (G4b).

## The capability table (`src/core/ai/thinking-off.ts`)

`thinkingOffControl(modelStr)` returns the provider-options namespace and keys to set and whether they turn reasoning off (`disables`). `applyThinkingOff` and `thinkingOffMaxOutputTokens` (runtime, inside `chat()`) and gateway.ts `thinkingOffOutputCap` (the takes-quality and cross-modal estimates) all read it, so an estimate prices the cap the call sends.

| Route | Option sent under `thinking: 'off'` | Reasoning off? | Cap sent |
|---|---|---|---|
| `anthropic:*`, `deepseek:*`, `openrouter:deepseek/*` | `thinking: {type:'disabled'}` (unchanged) | yes | requested |
| `google:gemini-2.5-flash*`, `-2.5-flash-lite*` | `thinkingConfig: {thinkingBudget: 0}` | yes (probe G2: 0 reasoning tokens) | requested |
| `google:gemini-2.5-pro*` | `thinkingConfig: {thinkingBudget: 128}` (never `thinkingLevel`; probe G3: a 400 on 2.5) | no (128 is the documented minimum) | 32,000 |
| `google:gemini-3.7-flash`, `-3.8-flash`, `-3-pro*`, `-3.1-pro*` | `thinkingConfig: {thinkingLevel: 'low'}` | no (probe G5: 90 reasoning tokens) | 32,000 |
| `google:gemini-3-flash*`, `-3.5-flash`, `-3.6-flash`, `-3.1-flash-lite*`, `-3.5-flash-lite*` | `thinkingConfig: {thinkingLevel: 'minimal'}` | no (`minimal` does not guarantee off) | 32,000 |
| other `google:gemini-3+`, `gemini-*-latest` aliases | none (an unsupported level is a 400; probe G6) | no | 32,000 |
| `google:` image, TTS, audio, live, transcribe, computer-use ids; Gemini < 2.5 | none, no row | n/a | requested (or `isThinkingModel`) |
| `openai:gpt-5.1`, `-5.2`, `-5.4`(`-mini`/`-nano`), `-5.5`, `-5.6-{luna,sol,terra}` | `reasoningEffort: 'none'` | yes (probe O2) | requested |
| `openai:gpt-5`, `-5-mini`, `-5-nano` | `reasoningEffort: 'minimal'` | no | 32,000 |
| `openai:o1`, `o3`, `o3-mini`, `o4-mini` | `reasoningEffort: 'low'` | no | 32,000 |
| other OpenAI reasoning ids (`-pro`, `-codex`, gpt-6 family, unknown gpt-5+/o-series) | none | no | 32,000 |
| `openai:*-chat*`, `gpt-4o*` | none, no row | n/a | requested |
| every other route | none, no row | when `isThinkingModel` (claude-cli Claude 5, GLM, local reasoning) | 32,000 if thinking, else requested |

Rules the table enforces:

- Never both Google fields: the Google option replaces any configured `thinkingConfig` wholesale (probe G7: both fields together are a 400 on 3.8 Flash).
- A namespace alone is not an off switch: only the native `google` and `openai` recipes get these rows. `openrouter:openai/gpt-5.2`, `openrouter:google/...` and `litellm:` routes get nothing.
- gpt-6 has no option because the pinned `@ai-sdk/openai` 3.0.58 lists only `o1`/`o3`/`o4-mini`/`gpt-5*` as reasoning models (`getOpenAILanguageModelCapabilities`) and drops `reasoningEffort` for gpt-6 with a warning. The unit test caught this; a TODO covers it.
- Sources: Google's generateContent thinking guide (levels per model, budget ranges), OpenAI's reasoning guide (supported efforts per model), and the probe.

Out of scope on purpose: the Google and OpenAI recipes still declare no `thinking_by_default`, so calls without `thinking: 'off'` keep today's default caps. Flipping them would raise default caps (and budget reservations) for every Gemini and gpt-5.5+ caller, which is a wider change than item 5.

## Files and functions touched

- `src/core/ai/thinking-off.ts`: new `ThinkingOffControl`, `thinkingOffControl` (the table: `googleControl`, `openaiControl`); `applyThinkingOff` reads it; `thinkingOffMaxOutputTokens` now takes `thinkingByDefault` and raises the cap when a row keeps reasoning. Removed `thinkingOffNamespace` (no callers outside the module).
- `src/core/ai/gateway.ts`: new export `thinkingOffOutputCap(modelStr, requested)` after `defaultMaxOutputTokens`, and `chat()` uses it (net +2 lines; `scripts/module-size-limits.tsv` ceiling 4425 → 4427 with a note). No change to `instantiateChat`/`instantiateEmbedding`/`instantiateExpansion` (GBRA-52's area).
- `src/core/takes-quality-eval/runner.ts`: `JUDGE_MAX_TOKENS`, `judgeCallCostUsd`; `callOneModel` sends `JUDGE_MAX_TOKENS`; `runEval` projection and correction pricing use `judgeCallCostUsd` and announce a raised cap on stderr.
- `src/core/cross-modal-eval/runner.ts`: `estimateCost` prices each slot at `thinkingOffOutputCap(slot.model, maxTokens)`, notes a raised cap, and `perCallTokens` uses the largest cap.
- `src/commands/eval-cross-modal.ts`: the batch preflight (`--max-usd`) prints the estimate notes, as the single run already did.
- `docs/architecture/key-files/core-ai.md`, `docs/architecture/key-files/evaluation.md`: entries updated.
- `TODOS.md`: one edit. It removes the two wave 9 lines this wave resolves or replaces (item 5 judge estimates; item 9 stall detection) and adds the section "Fix wave 9 follow-ups, round 2" at the top: item 9 (both transports), receipts for the pages/timeline/alias writers, the production fail-closed receipt guard, repair owner delegation, typed `ShutdownInterruptedError`, the judge-panel refresh, and the gpt-6 SDK gap from this lane. The integrator may want to fold other lanes' removals from the wave 9 section into the same hunk.

## Tests

Fail on master source (src stashed, branch tests kept), pass on the branch:

- `test/ai/chat-thinking-off.test.ts` (real gateway against a local stub; the Google request is caught at `fetch`): 27 of 36 fail on master. These are the Google and OpenAI request-body rows (option and cap per model id), configured-value replacement (never both Google fields; OpenAI effort replaced, `prompt_cache_key` kept), the provider-options snapshot per model id, and estimate parity for every default takes-quality panel model and cross-modal slot plus a route that keeps reasoning (`openai:gpt-5`: sent cap = estimated cap = 32,000). The 9 that pass on master are the #5331 rows and three unchanged-behaviour guards (`gpt-4o-mini`, `gpt-5.2-chat-latest`, Google without thinking off). Branch: 36 pass.
- `test/eval-takes-quality-runner.serial.test.ts`: new case "a model that cannot turn thinking off is projected at the output cap its call sends". It fails on master (cycle runs under a $0.30 cap priced at 2,000 tokens) and passes on the branch (aborts before the call, priced at 32,000). Branch: 16 pass.
- Related suites, all green on the branch: `test/ai/` (910 pass), `cross-modal-default-slots`, `cross-modal-eval-prompt`, `default-model-panels`, `eval-cross-modal-batch`, `eval-takes-quality-boundaries`, `eval-takes-quality-pricing`, `nightly-quality-probe`, `cycle/synthesize-gateway-adapter`, `e2e/cross-modal-eval`.

## Release notes for the integrator

CHANGELOG lines (user voice):

- Eval judges on Google and OpenAI now really turn thinking off where the model allows it. `gemini-2.5-flash` on the default takes-quality panel used to think inside its 2,000-token reply budget and could return a cut-off verdict; it now sends `thinkingBudget: 0`. `gpt-5.2` judges now send `reasoning.effort: none` explicitly.
- Models that can't turn thinking off (Gemini 2.5 Pro and 3.x, gpt-5/-mini/-nano, o-series, gpt-6) now run judges at their lowest supported thinking setting with room to finish, and `eval takes-quality --budget-usd` and `eval cross-modal --max-usd` price that larger reply cap and say so, instead of under-estimating it 8-16x.

`BEHAVIOR_CHANGES` candidates (`src/core/behavior-change-notice.ts`):

- `thinking: 'off'` callers (takes-quality and cross-modal judges, the synthesize triage judge) on native Google and OpenAI routes now send a thinking option (table above) and, where reasoning cannot be turned off, a 32,000-token cap. Budget reservations for those calls grow accordingly.
- Judge cost preflights for those routes rise to the 32,000-token cap. A `--budget-usd`/`--max-usd` that passed before can now refuse or abort earlier.

Upgrade notes: none (no migration, no config).

## Live compatibility probe (Decision 6)

One run of `~/.capy/work/w9f-lane-j/probe.ts` (scratch, not committed), with the real AI SDK (`ai` 6.0.174, `@ai-sdk/google` 3.0.67, `@ai-sdk/openai` 3.0.58) and the provider options produced by the branch's `applyThinkingOff`. Caps were reduced from the judge's 2,000 so that the worst case stayed under the $0.02 bound. A plumbing dry run with invalid keys came first; it cost nothing (every call returned 400/401). Prices for the bound: gemini-2.5-flash $0.30/$2.50, gemini-3.8-flash $0.825/$4.125 (the non-global intro rate, an upper bound), gpt-5.2 $1.75/$14 (list price, above the repo's canonical $1.25/$10). gemini-3.8-flash is the newest Gemini 3.x Flash in `models.list` on 2026-10-07.

Summary:

| Case | Model | Options | Cap | Result | Reasoning / text tokens |
|---|---|---|---|---|---|
| G1 | gemini-2.5-flash | none (master) | 600 | stop | 193 / 21 |
| G1b | gemini-2.5-flash | none (master) | 128 | **length**, text `{"score": ` | 120 / 3 |
| G2 | gemini-2.5-flash | `thinkingBudget: 0` (branch) | 600 | stop | 0 / 30 |
| G3 | gemini-2.5-flash | `thinkingLevel: 'low'` | 64 | 400 "Thinking level is not supported for this model." | n/a |
| G4 | gemini-3.8-flash | none | 600 | stop | 130 / 20 |
| G4b | gemini-3.8-flash | none | 128 | **length**, text `{"score": 1` | 119 / 5 |
| G5 | gemini-3.8-flash | `thinkingLevel: 'low'` (branch) | 600 | stop | 90 / 20 |
| G6 | gemini-3.8-flash | `thinkingLevel: 'minimal'` | 64 | 400 "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level." | n/a |
| G7 | gemini-3.8-flash | `thinkingLevel: 'low'` + `thinkingBudget: 0` | 64 | 400 "You can only set only one of thinking budget and thinking level." | n/a |
| O1 | gpt-5.2 | none (master) | 200 | stop; server echoes `reasoning.effort: "none"` | 0 / 31 |
| O2 | gpt-5.2 | `reasoningEffort: 'none'` (branch) | 200 | stop | 0 / 30 |

What it changed in the table: nothing had to move. It confirmed that `thinkingLevel` must never reach 2.5, that `minimal` is a 400 on 3.8 Flash, that both fields together are a 400, and that 3.8 Flash at `low` still reasons (so it gets headroom). It also showed gpt-5.2 already defaults to effort `none`, so the branch's explicit `none` changes no gpt-5.2 output; it pins the behaviour against a configured effort.

### Exact requests and responses

Bodies are the JSON the SDK sent and received, pretty-printed. Headers were not logged; the logger refused any URL carrying a key, and the Google key travelled in the `x-goog-api-key` header. The opaque `thoughtSignature` blobs are elided by length.

Run at 2026-10-07T00:50:09.448Z. Worst-case bound (every call hitting its cap at the upper-bound prices): $0.0162. Actual spend from reported usage: $0.00397.

#### G1: `google:gemini-2.5-flash`, maxOutputTokens 600 (master behaviour: no thinkingConfig)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The calculation for the arrival time is correct.\"}"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 21,
    "totalTokenCount": 302,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 193,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "M5fFatSsOdX1jMcPr4yekAM"
}
```

#### G1b: `google:gemini-2.5-flash`, maxOutputTokens 128 (master behaviour, small cap: do thoughts consume maxOutputTokens?)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 128
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": "
          }
        ],
        "role": "model"
      },
      "finishReason": "MAX_TOKENS",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 3,
    "totalTokenCount": 211,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 120,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "NZfFau_8CNnb-8YPoKy1gQQ"
}
```

#### G2: `google:gemini-2.5-flash`, maxOutputTokens 600 (branch thinking:'off' mapping)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600,
    "thinkingConfig": {
      "thinkingBudget": 0
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"3:40 + 2h 35m = 6:15\"}"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 30,
    "totalTokenCount": 118,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "NpfFapH9AvmtsOIPuOuLiAQ"
}
```

#### G3: `google:gemini-2.5-flash`, maxOutputTokens 64 (negative: thinkingLevel on 2.5 (table never sends it))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "Thinking level is not supported for this model.",
    "status": "INVALID_ARGUMENT"
  }
}
```

#### G4: `google:gemini-3.8-flash`, maxOutputTokens 600 (no thinkingConfig (default medium))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The arrival time calculation is completely correct.\"}",
            "thoughtSignature": "<elided: 584-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 20,
    "totalTokenCount": 238,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 130,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "NpfFapyvKuHJ39IPp7WqmQE"
}
```

#### G4b: `google:gemini-3.8-flash`, maxOutputTokens 128 (no thinkingConfig, small cap)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 128
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 1",
            "thoughtSignature": "<elided: 520-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "MAX_TOKENS",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 5,
    "totalTokenCount": 212,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 119,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "OZfFavmMAbCc-8YPsIH3WQ"
}
```

#### G5: `google:gemini-3.8-flash`, maxOutputTokens 600 (branch thinking:'off' mapping (floor))

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 600,
    "thinkingConfig": {
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 200):

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"score\": 10, \"reason\": \"The calculated arrival time is mathematically correct.\"}",
            "thoughtSignature": "<elided: 420-char opaque signature>"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 88,
    "candidatesTokenCount": 20,
    "totalTokenCount": 198,
    "promptTokensDetails": [
      {
        "modality": "TEXT",
        "tokenCount": 88
      }
    ],
    "thoughtsTokenCount": 90,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.8-flash",
  "responseId": "O5fFarjQF42hjrEP8tKMMA"
}
```

#### G6: `google:gemini-3.8-flash`, maxOutputTokens 64 (negative: thinkingLevel minimal on 3.8 Flash)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingLevel": "minimal"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.",
    "status": "INVALID_ARGUMENT"
  }
}
```

#### G7: `google:gemini-3.8-flash`, maxOutputTokens 64 (negative: both Google fields)

Request (`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; headers, including the API key header, not recorded):

```json
{
  "generationConfig": {
    "maxOutputTokens": 64,
    "thinkingConfig": {
      "thinkingBudget": 0,
      "thinkingLevel": "low"
    }
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "systemInstruction": {
    "parts": [
      {
        "text": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
      }
    ]
  }
}
```

Response (HTTP 400):

```json
{
  "error": {
    "code": 400,
    "message": "You can only set only one of thinking budget and thinking level.",
    "status": "INVALID_ARGUMENT"
  }
}
```

#### O1: `openai:gpt-5.2`, maxOutputTokens 200 (master behaviour: no reasoningEffort)

Request (`POST https://api.openai.com/v1/responses`; headers, including the API key header, not recorded):

```json
{
  "model": "gpt-5.2",
  "input": [
    {
      "role": "developer",
      "content": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "max_output_tokens": 200
}
```

Response (HTTP 200):

```json
{
  "id": "resp_0a9c3f8ec573dd13006ac5973e823c87d1905d24cd91111bf9",
  "object": "response",
  "created_at": 1791334206,
  "status": "completed",
  "access_programs": null,
  "background": false,
  "billing": {
    "payer": "developer"
  },
  "completed_at": 1791334207,
  "error": null,
  "frequency_penalty": 0,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": 200,
  "max_tool_calls": null,
  "model": "gpt-5.2-2025-12-11",
  "moderation": null,
  "output": [
    {
      "id": "msg_0a9c3f8ec573dd13006ac5973f07d487d192d47ea58083e6a8",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "annotations": [],
          "logprobs": [],
          "text": "{\"score\": 10, \"reason\": \"3:40 pm + 2:35 equals 6:15 pm.\"}"
        }
      ],
      "role": "assistant"
    }
  ],
  "parallel_tool_calls": true,
  "presence_penalty": 0,
  "previous_response_id": null,
  "prompt_cache_key": null,
  "prompt_cache_retention": "24h",
  "reasoning": {
    "context": "current_turn",
    "effort": "none",
    "mode": "standard",
    "summary": null
  },
  "safety_identifier": null,
  "service_tier": "default",
  "store": true,
  "temperature": 1,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tool_usage": {
    "image_gen": {
      "input_tokens": 0,
      "input_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "output_tokens": 0,
      "output_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "total_tokens": 0
    },
    "web_search": {
      "num_requests": 0
    }
  },
  "tools": [],
  "top_logprobs": 0,
  "top_p": 0.98,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 92,
    "input_tokens_details": {
      "cache_write_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens": 31,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 123
  },
  "user": null,
  "metadata": {}
}
```

#### O2: `openai:gpt-5.2`, maxOutputTokens 200 (branch thinking:'off' mapping)

Request (`POST https://api.openai.com/v1/responses`; headers, including the API key header, not recorded):

```json
{
  "model": "gpt-5.2",
  "input": [
    {
      "role": "developer",
      "content": "You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Score this claim for factual accuracy from 1 to 10: \"A train leaves at 3:40 pm and the trip takes 2 h 35 min, so it arrives at 6:15 pm.\" Reply exactly as {\"score\": <integer>, \"reason\": \"<10 words max>\"}."
        }
      ]
    }
  ],
  "max_output_tokens": 200,
  "reasoning": {
    "effort": "none"
  }
}
```

Response (HTTP 200):

```json
{
  "id": "resp_081f0f2437fa7263006ac59740421087d1a18274c9f986ef0e",
  "object": "response",
  "created_at": 1791334208,
  "status": "completed",
  "access_programs": null,
  "background": false,
  "billing": {
    "payer": "developer"
  },
  "completed_at": 1791334209,
  "error": null,
  "frequency_penalty": 0,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": 200,
  "max_tool_calls": null,
  "model": "gpt-5.2-2025-12-11",
  "moderation": null,
  "output": [
    {
      "id": "msg_081f0f2437fa7263006ac59740de7087d1a2a28eaf27037077",
      "type": "message",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "annotations": [],
          "logprobs": [],
          "text": "{\"score\": 10, \"reason\": \"3:40 plus 2:35 equals 6:15 pm.\"}"
        }
      ],
      "role": "assistant"
    }
  ],
  "parallel_tool_calls": true,
  "presence_penalty": 0,
  "previous_response_id": null,
  "prompt_cache_key": null,
  "prompt_cache_retention": "24h",
  "reasoning": {
    "context": "current_turn",
    "effort": "none",
    "mode": "standard",
    "summary": null
  },
  "safety_identifier": null,
  "service_tier": "default",
  "store": true,
  "temperature": 1,
  "text": {
    "format": {
      "type": "text"
    },
    "verbosity": "medium"
  },
  "tool_choice": "auto",
  "tool_usage": {
    "image_gen": {
      "input_tokens": 0,
      "input_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "output_tokens": 0,
      "output_tokens_details": {
        "image_tokens": 0,
        "text_tokens": 0
      },
      "total_tokens": 0
    },
    "web_search": {
      "num_requests": 0
    }
  },
  "tools": [],
  "top_logprobs": 0,
  "top_p": 0.98,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 92,
    "input_tokens_details": {
      "cache_write_tokens": 0,
      "cached_tokens": 0
    },
    "output_tokens": 30,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 122
  },
  "user": null,
  "metadata": {}
}
```
