# Wave 9, lane W (workers and job lifecycle): release notes for the integrator

No version bump, no CHANGELOG header, no migration. These lines are for the
integrator to fold into the wave 9 CHANGELOG entry and its upgrade section.

## CHANGELOG lines

- **`gbrain jobs supervisor stop` no longer reports `drained` while work survives (#5062).** A SIGTERM used to reach the generic CLI cleanup handler first: it deleted the supervisor's queue lock and exited 143 before the supervisor said `stopped`, the worker died the same way, its in-flight job stayed `active`, and the job's children were orphaned to PID 1. The supervisor and `jobs work` now own their termination signals: repeated signals join one ordered shutdown that keeps the queue lock through the drain (a second supervisor is refused mid-drain), stops the worker (SIGTERM, 35s, SIGKILL by liveness, confirmed exit), hands interrupted claims back to the queue without burning an attempt, releases the lock and only then emits `stopped`, now carrying `drained`, `worker_forced`, `worker_exit_code` and `lock_released`. `stop` reports `drained` only when the supervisor's own `stopped` row says so, every worker it spawned is gone and its lock row is released; otherwise it names the failing check (`no_stopped_event`, `worker_still_running`, `lock_unverified`, `lock_still_held`, `forced`) and exits 1.
- **Shell jobs no longer leave processes behind (#5062).** On Linux and macOS a shell job runs in its own process group. Cancel, timeout and worker shutdown reach every descendant, a process that ignores SIGTERM is SIGKILLed after 5 seconds (the old check never escalated), and when the job's shell exits, anything it left running in its group is terminated before the job settles.
- **Declaring `extract_atoms` in a schema pack no longer stops autopilot from running it (#5028).** On Postgres the daemon's routine cycles run only the freshness phases, so the auto-drain was the only thing that ran `extract_atoms`, and it skipped every brain whose pack declared the phase. It now runs regardless, within the existing threshold, `autopilot.auto_drain.max_usd_per_day` cap and one slot per source per UTC day. `gbrain doctor`'s `extract_atoms_backlog` check now reads the phase's own `last_extract_atoms_at` stamp, so a brain whose cycles run but whose atoms never get extracted warns instead of reporting OK.
- **Dry runs and classic brains no longer pay to triage transcripts that are already synthesized (#5145).** Completed synthesis (both key families) is checked before the triage pass on every path. Synthesize details gain `synthesis_state: {candidates, already_synthesized}`; the triage counters and the "not yet triaged" note now cover only screened candidates.
- **`cycle.consolidate.cluster_threshold` sets consolidate's cosine threshold (#5363),** default 0.85, any value in (0, 1], validated by `gbrain config set`. The old option was never wired. Facts with typed claims now share a take only when metric, unit and period all match: monthly vs annual, USD vs EUR, and typed vs untyped facts stay separate.
- **`gbrain eval <subcommand> --help` prints that subcommand's usage (D-N1)** instead of the generic `eval --qrels` block (replay, gate, whoknows, trajectory, suspected-contradictions, retrieval-quality, compare, export, prune and the rest).
- **The v0.28.0 migration's re-chunk reminder names a command that exists (D-N5):** `gbrain reindex --markdown`, not the nonexistent `gbrain extract takes --rebuild`. The v0.28.0 skill no longer cites two doctor checks that never shipped.

## Upgrade notes (behavior changes worth a one-time notice)

| Change | Who notices | What to do |
|---|---|---|
| `jobs work` exits 0 after a SIGTERM drain (was 143); exit 17 (`WORKER_EXIT_DRAIN_FORCED`) when claims still running after 30s had to be handed back | process managers and scripts that read the worker's exit code | treat 0 as a clean stop and 17 as a stop that interrupted work |
| `jobs supervisor stop --json` gains `drained`, `checks`, `queue`; reason `timeout_40s` is now `timeout` (wait 45s); exits 1 unless the drain is verified | scripts parsing `stop` output | key on `drained` / `reason` |
| A shell job's backgrounded processes (`cmd &` with no `wait`) are terminated when the job ends | shell jobs that intentionally start daemons | start long-lived processes under your service manager, or detach them into their own session (`setsid`) |
| Brains whose pack declares `extract_atoms` start receiving the daily atom auto-drain on Postgres autopilot (bounded by `autopilot.auto_drain.max_usd_per_day`, default $2) | owners of declaring packs | `gbrain config set autopilot.auto_drain.enabled false` to opt out |
| `extract_atoms_backlog` may warn right after upgrade on declaring-pack brains until the phase runs once and stamps the source | doctor readers | run the drain command the warning names, or wait for the next auto-drain |

Recommended for the wave's `behavior_changes` notice: the shell-job process-group change and the declaring-pack auto-drain (spend that starts without a new opt-in, inside the existing default cap).
