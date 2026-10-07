# Wave 9 follow-ups, lane F: repair old label facts

Integrator notes for the release PR (no version stamped).

## CHANGELOG lines

- New `gbrain repair conversation-labels` retires conversation facts that the
  parser before v0.60.69 extracted from meeting-note labels (`**Date:**`,
  `**Attendees:**`, …) read as speakers, often dated 1970-01-01. It previews
  every candidate with its class and a hash, makes no model calls, and needs
  the user's consent to apply (`--apply --expect <hash> --yes`). Retired facts
  are expired, not deleted. Prose and undated pages are recorded as not
  extractable at no cost; other pages re-enter the extraction backlog and the
  preview prints the capped re-extract commands
  (`gbrain extract-conversation-facts --slugs … --dry-run`).
- Doctor `conversation_label_facts` counts the facts the repair would retire
  by default and points at its preview.
- `gbrain extract-conversation-facts --slugs <a,b,…>` processes exactly the
  named pages.
- A conversation page whose completion marker was expired is extracted again,
  and re-extraction no longer deletes facts an open loop or another fact's
  `superseded_by` still references (they are expired instead) or facts the
  label repair retired.

## BEHAVIOR_CHANGES candidates

> `gbrain repair conversation-labels` (new, explicit-only) retires conversation facts misattributed to meeting-note labels; it never runs from `gbrain repair --all`, doctor remediation or the upgrade, and it makes no model calls.

> Re-extracting a conversation page now keeps facts an open loop or a superseding fact references, as expired history, instead of deleting them.

## Decisions applied

- Decision 4 (A): apply expires an approved id set (captured-facts pattern);
  nothing is hard-deleted.
- Decision 5 (A): default set = rows whose context carries
  `segment 1970-01-01`; everything else on a label page is ambiguous, behind
  `--include-ambiguous` with its own hash. Confirmed no post-fix path writes
  that context: the fixed parser records an epoch-dated parse as not
  extractable (`conversationSkip`), so it never reaches segment extraction.

## Notes

- Under a live `gbrain serve` on PGLite the lock refusal is already immediate
  (`acquireLock` throws `LiveServeLockError` without waiting), and the fatal
  CLI seam's fix is the stop → rerun → restart plan; the test pins it for this
  command. Owner delegation for repair kinds stays a TODO.
- Upstream master moved to v0.60.100.0 while this lane ran; the branch is
  based on 9cc7c467 (v0.60.99.0) and does not merge it (integrator's call).
