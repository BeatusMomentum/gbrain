# Wave 9 lane SG: CHANGELOG lines and upgrade-note rows

Integrator: fold these into CHANGELOG.md and docs/UPGRADING_DOWNSTREAM_AGENTS.md at release time.

## CHANGELOG lines

- **Long page filenames publish again (#5861).** Atomic and journaled writes stage through a short hidden sibling (`.<sha256 of the target path>.tmp.<uuid>`) instead of appending a suffix to the full basename, so a valid basename near the 255-byte limit no longer fails with ENAMETOOLONG or leaves a write request recovering. Recovery still accepts historical stage names and, under the owner lock, durably swaps in a short name only for a recorded stage the filesystem cannot name. Timeline write-through uses the same allocator (D-NEW-3).

## Upgrade-note rows

| Change | Who is affected | Doctor / check | How to opt back |
|---|---|---|---|
| Staging files are now hidden `.<hash>.tmp.<uuid>` siblings (#5861) | Anyone with page basenames over ~214 bytes; operators who glob for `*.tmp.*` leftovers (the new names still contain `.tmp.`) | `gbrain sources writer status --json` shows any recovery that still holds a stage | None needed; historical journals keep working |
