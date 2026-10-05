# Fix wave 9, lane E (session capture): release notes for the integrator

Branch `capy/w9-lane-e`, based on origin/master `17c5765b`. No version bump,
no CHANGELOG header and no migration in this lane.

## CHANGELOG lines

- **Codex 0.153+ sessions keep your side of the conversation (#5163).** Codex
  now records the typed turn as an `item_completed` UserMessage; gbrain read
  only the older `user_message` event, so imports and session-end corpus files
  held the assistant side alone. Both parsers read the new record (a turn
  recorded both ways is kept once).
- **Assistant-only sessions are flagged (E-N4).** A Codex or Claude Code file
  that parses to assistant turns with no user turn now counts as drift in
  `gbrain transcripts ingest` (the watermark holds) and the session-end hook
  heartbeats `degraded` / `no_user_turns`.
- **`gbrain transcripts recover codex` restores sessions imported before the
  fix (D15).** Preview by default; `--apply` re-imports the sessions whose
  rollouts are still on disk and lists the ones that cannot be restored. No
  facts are extracted and the `--since last` watermark is untouched.
- **Busy-writer harvests retry instead of failing (#5557).** A serve-side
  writeback turn refused because the canonical writer was busy is re-queued
  after 5, 15 and 45 s, error reasons keep their code
  (`operationerror:writer_lock_unavailable`), and `gbrain doctor`
  `memory_writeback` warns when more than 20% of at least 10 harvests failed
  in 7 days. Contributed by @andreineacsu (#5973).
- **`gbrain serve --http` drains the session corpus (X8).** Every 10 minutes,
  while a captured session file is still unextracted, the HTTP serve runs one
  bounded sweep (60 s budget). `GBRAIN_SWEEP=0` turns it off with the other
  serve sweeps.
- **Sweep budgets stop between files, never mid-extraction (E-N2).** A slow
  extraction (claude-cli often 8 to 25 s) used to be cut off at the 5 s
  default budget on every `gbrain sweep --once`, paying for a call that wrote
  nothing.
- **Captured turns nothing has extracted are kept longer (E-N1).** Corpus
  retention removes an unextracted session file only at 3x
  `dream.synthesize.corpus_retention_days` (90 days by default), and
  `gbrain doctor` `memory_writeback` reports the backlog and warns before the
  deletion day.
- **`mentions.exclude_slugs` keeps a page out of mention linking (#5829).**
  For an entity whose name is also a common word. The next sweep removes
  mention links already written to it. The unused `extraIgnore` gazetteer
  option is gone.

## Upgrade-note rows

| Change | Who notices | What to do |
|---|---|---|
| Codex user turns now import (#5163) | Codex users | Run `gbrain transcripts recover codex` to preview restoring older sessions, then `--apply`. Facts for restored sessions are a separate, explicit `gbrain transcripts ingest <rollout> --facts --max-cost-usd <n>`. |
| Assistant-only files count as drift (E-N4) | Anyone with a genuinely assistant-only session file | The `--since last` watermark holds while such a file is in scope (re-scans stay cheap through the content-hash skip). |
| Harvest error reasons carry a code (#5557) | Anyone parsing the hooks heartbeat | `reason` changes from `operationerror` to `operationerror:<code>`. |
| `serve --http` sweeps (X8) | HTTP-served brains with captured sessions and an extraction model | The drain spends extraction calls on captured files the stdio serve would already have swept: at most one 60 s sweep (20 files, 32 windows) per 10 minutes, only while unextracted files exist. Keyless brains spend nothing. `GBRAIN_SWEEP=0` disables it. |
| Sweep budget semantics (E-N2) | Anyone running `gbrain sweep --once` with a short `--budget-ms` | A sweep can now run past its budget by one extraction call; it starts no new file after the budget. |
| Corpus retention keeps unextracted files (E-N1) | Hosts with a growing corpus dir | Unextracted session files stay up to 90 days by default instead of 30; `gbrain doctor` names the backlog and the `gbrain sweep --once --budget-ms 600000` that clears it. |
| `mentions.exclude_slugs` (#5829) | Brains with Hangul or common-word entity names | Optional. Existing word-internal Hangul links: `gbrain extract links --by-mention --rebuild --source db`. |

## Items not built here

- D15 metadata-label fact re-extraction (D-N2): depends on lane P's D-N2
  parser fix, which is not on master; build it on top of lane P.
- #5829 key name: `mentions.exclude_slugs`, not the plan's
  `by_mention.exclude_slugs`, because master adopted the `mentions.*`
  namespace (`mentions.ignore`, `mentions.entity_types`) after the plan.
- X8 runs inside `serve --http` rather than as an autopilot phase: the HTTP
  serve owns the corpus dir and the PGLite lock (autopilot cannot open a
  PGLite brain a serve holds), it needed no edit to `autopilot-dispatch.ts`,
  and it calls the same `runMaintenanceSweep` the plan named.
