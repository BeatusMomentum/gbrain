# Wave 9 lane SG: CHANGELOG lines and upgrade-note rows

Integrator: fold these into CHANGELOG.md and docs/UPGRADING_DOWNSTREAM_AGENTS.md at release time.

## CHANGELOG lines

- **Long page filenames publish again (#5861).** Atomic and journaled writes stage through a short hidden sibling (`.<sha256 of the target path>.tmp.<uuid>`) instead of appending a suffix to the full basename, so a valid basename near the 255-byte limit no longer fails with ENAMETOOLONG or leaves a write request recovering. Recovery still accepts historical stage names and, under the owner lock, durably swaps in a short name only for a recorded stage the filesystem cannot name. Timeline write-through uses the same allocator (D-NEW-3).
- **One image no longer stops managed sync (#5493).** With multimodal embedding on, managed sync holds each image import as `managed_image_sync_unsupported` instead of refusing the whole run, so Markdown and code beside it import and the checkpoint advances. The image is recorded as incomplete coverage (a durable hold in `gbrain sources status`, doctor `git_held_files`, and the `held_files` read notice), re-screened when it changes, leaves the source, or on `gbrain sources retry-held`; deleting or renaming an image still reconciles its page. Image holds never escalate. Reworked from a contribution by @andreineacsu (#5975).
- **`gbrain sources set-path` repairs a stale `local_path` (#5569).** Pointing set-path at the checkout the source is already bound to used to no-op even when `sources.local_path` still named an old directory; it now updates the path. The 0.53.0 shared-skills migration retakes an inventory that never completed at the corrected root instead of recording a conflict on every run; a completed inventory whose root moved still refuses.
- **Bundled-size skill packs adopt in one publication (#5476, A-NEW-4).** One canonical adoption may now write up to 128 files (one SKILL.md per skill plus skillpack.json, the persistence bundle bound) instead of 64, so the 75-skill bundled set adopts. A pack declaring 128 or more skills is refused at inventory as an action instead of failing after it. When skill files change after inventory, the conflict lists the changed paths and an exact `gbrain apply-migrations --migration 0.53.0 --accept-reviewed-inventory <source>=<digest> --yes` acceptance command.
- **Portable canonical skills list their usable tools (#5150).** A shared skill published without `tools:` now inherits the caller's available brain tools as `usable_tools` (list, detail, and the v1 compatibility catalog), matching host-repository skills; `tools: []` still permits none. Revisions published before this release re-read their SKILL.md on `get_skill`; `list_skills` keeps them empty until republished.
- **`put_skill` refuses an empty SKILL.md (A-NEW-5).** An empty or whitespace-only entry point is `invalid_params` instead of publishing a blank skill.

## Upgrade-note rows

| Change | Who is affected | Doctor / check | How to opt back |
|---|---|---|---|
| Staging files are now hidden `.<hash>.tmp.<uuid>` siblings (#5861) | Anyone with page basenames over ~214 bytes; operators who glob for `*.tmp.*` leftovers (the new names still contain `.tmp.`) | `gbrain sources writer status --json` shows any recovery that still holds a stage | None needed; historical journals keep working |
| Managed sync holds images instead of refusing the run (#5493) | Managed brains with `embedding_multimodal` on whose sources contain images | doctor `git_held_files` warns with `managed_image_sync_unsupported` paths (never fails for them) | Exclude images with `sync.exclude`, or turn multimodal embedding off; either clears the holds on the next sync |
| set-path updates a stale `sources.local_path` (#5569) | Sources whose DB path drifted from their writer binding | `gbrain sources list --json` shows the corrected path | None |
| 0.53.0 migration: re-inventory, 128-file pack adoption, reviewed acceptance (#5476) | Brains adopting shared skills with >63 skills or edited packs | `gbrain apply-migrations --migration 0.53.0 --dry-run --json` shows per-source stages | Don't pass `--accept-reviewed-inventory`; the conflict stays until reviewed |
| Canonical skills without `tools:` inherit brain tools (#5150) | Clients reading `usable_tools` for shared skills | `gbrain call get_skill '{"name":"<skill>"}'` | Declare `tools:` in the skill to narrow it |
| Empty SKILL.md refused (A-NEW-5) | Editors publishing placeholder skills | none | Write a non-empty SKILL.md |
