# Verify scheduling and the nightly E2E report

How `bun run verify` schedules its checks, why `typecheck` sets its own heap
ceiling, and how the nightly full-corpus E2E report tells a cancelled run from
a failed one. Test tiers and the rest of CI live in [TESTING.md](../TESTING.md).

## Verify solo checks

`scripts/run-verify-parallel.sh` runs `CHECKS` through a worker pool sized to
the CPU count, heaviest first, then runs each `SOLO_CHECKS` entry alone after
the pool has drained. A solo check is one that enforces its own wall-clock
budget: today only `check:guard-self-test` (30 s, `BUDGET_SECONDS` in
`scripts/guard-self-test.sh`). Inside the pool that budget measured the
neighbours instead of the guards: `typecheck`, two `bun build --compile`
checks and the admin build each use more than one core, so the self-test
(15-19 s alone on a Ubicloud standard-2 or standard-8) reached 31 s on the
8-vCPU verify runner and 32 s on macOS 26.

Add a new check as one line in the right block of `CHECKS`. Add to
`SOLO_CHECKS` only a check that times itself. The 120 s per-check cap
(`GBRAIN_VERIFY_TIMEOUT`) applies to both phases.

Every run writes `outcomes.tsv` in the log directory with each check's
outcome and wall seconds, and the summary line names the five slowest checks,
so an overrun shows whether the check or its neighbours grew.

## Typecheck heap

`bun run typecheck` runs `node --max-old-space-size=6144
node_modules/typescript/bin/tsc`. tsc needs about 3.5 GB of heap on this repo
(`--extendedDiagnostics`: about 7,350 files, 1.3 M lines). Node's default heap
limit follows host memory, about 2 GB on an 8 GB host, so without the flag
typecheck aborts with `JavaScript heap out of memory` on 8 GB machines such as
a Ubicloud standard-2. The value is a ceiling, not a reservation: peak RSS is
about 3.7 GB with ceilings of 3,800, 4,096 or 6,144 MB, and wall time is the
same. If tsc reaches the ceiling, find what grew the program (the
`Files`/`Memory used` lines of `--extendedDiagnostics`) before raising it.

## macOS typecheck skip

The macOS 26 validation job (`macos-validation.yml`) runs `bun run verify`
with `GBRAIN_VERIFY_TYPECHECK_COVERED_BY` naming `test.yml`'s Linux verify
job, so `typecheck` is recorded as a skip with that reason in
`outcomes.tsv`, the receipt and the step summary. tsc output does not depend
on the OS, the Linux verify job gates it on every PR and push, and a cold tsc
takes 110-142 s alone on the 3-core arm64 runner (no swap, memory 57-76%
free), past the 120 s per-check cap. A day-old incremental cache does not
help: one edit to a widely imported file costs a 124 s recheck. The runner
refuses the variable on any other OS (exit 2 with the next step), and
`test/scripts/run-verify-parallel.test.ts` pins that only this workflow sets
it.

## Full-corpus report states

`coverage-full-report` in `.github/workflows/e2e.yml` first runs
`scripts/classify-full-e2e-shards.ts`, which reads this run attempt's four
`coverage-full-e2e` jobs and their check-run annotations:

| Shards | Report | Job | Next step |
|---|---|---|---|
| All succeeded | Merges, renders and gates the full corpus | per gates | none |
| Every unfinished shard carries GitHub's run-cancel annotation (`Canceling since a higher priority waiting request …` or `The run was canceled by …`) | `Full E2E shards cancelled` warning and step summary; no coverage | success | `gh workflow run e2e.yml --ref master -f full_corpus=true`, or wait for the next schedule |
| A shard failed, hit its `timeout-minutes`, or the evidence cannot be read | `Full E2E shards failed` error | failure | `gh run view <run-id> --log-failed`, fix the shard, `gh run rerun <run-id> --failed` |

The workflow cannot decide this from expressions. `cancelled()` reads false in
an `always()` job that starts after the run was cancelled, and a shard that
hits `timeout-minutes` also reports `cancelled` through `needs`. Unreadable
evidence is a failure, never a cancellation on a guess.

Scheduled E2E runs use their own `-nightly` concurrency group, as `test.yml`
does, so a push to master does not cancel the nightly full corpus.

## Changelog

- 2026-10-05: created (green master wave, lane C): solo verify phase,
  typecheck heap ceiling, full-corpus shard classification, macOS typecheck
  skip (#6040, #6056).
