# Wave 9 lane SG: CHANGELOG lines and upgrade-note rows

Integrator: fold these into CHANGELOG.md and docs/UPGRADING_DOWNSTREAM_AGENTS.md at release time.

## CHANGELOG lines

- **Long page filenames publish again (#5861).** Atomic and journaled writes stage through a short hidden sibling (`.<sha256 of the target path>.tmp.<uuid>`) instead of appending a suffix to the full basename, so a valid basename near the 255-byte limit no longer fails with ENAMETOOLONG or leaves a write request recovering. Recovery still accepts historical stage names and, under the owner lock, durably swaps in a short name only for a recorded stage the filesystem cannot name. Timeline write-through uses the same allocator (D-NEW-3).
- **One image no longer stops managed sync (#5493).** With multimodal embedding on, managed sync holds each image import as `managed_image_sync_unsupported` instead of refusing the whole run, so Markdown and code beside it import and the checkpoint advances. The image is recorded as incomplete coverage (a durable hold in `gbrain sources status`, doctor `git_held_files`, and the `held_files` read notice), re-screened when it changes, leaves the source, or on `gbrain sources retry-held`; deleting or renaming an image still reconciles its page. Image holds never escalate. Reworked from a contribution by @andreineacsu (#5975).

## Upgrade-note rows

| Change | Who is affected | Doctor / check | How to opt back |
|---|---|---|---|
| Staging files are now hidden `.<hash>.tmp.<uuid>` siblings (#5861) | Anyone with page basenames over ~214 bytes; operators who glob for `*.tmp.*` leftovers (the new names still contain `.tmp.`) | `gbrain sources writer status --json` shows any recovery that still holds a stage | None needed; historical journals keep working |
| Managed sync holds images instead of refusing the run (#5493) | Managed brains with `embedding_multimodal` on whose sources contain images | doctor `git_held_files` warns with `managed_image_sync_unsupported` paths (never fails for them) | Exclude images with `sync.exclude`, or turn multimodal embedding off; either clears the holds on the next sync |
