# Fix wave 9, lane P (fact pipelines): release notes for the integrator

Branch `capy/w9-lane-p`. The integrator owns VERSION, the CHANGELOG header and
migration numbering; the lines below go under the wave's CHANGELOG entry.

## CHANGELOG lines

- **Fences synced in by a standalone `gbrain sync` now reach the facts index.** On a brain without managed persistence, a `## Facts` fence imported by `gbrain sync` used to stay out of the facts index for good: the dream cycle's own sync saw nothing new, so `extract_facts` reconciled nothing. Each cycle now also reconciles pages whose facts are behind the page (up to 250 per run, within 60 seconds), so new fences, edited fences and removed fences all land. `gbrain doctor` (`extract_health`) names fence pages that are not reconciled yet and fences it cannot read; `gbrain dream --phase extract_facts` reconciles every page at once. (#5151)
- **Email threads extract conversation facts.** Gmail thread pages (one `## Sender · date time` heading per message) now parse into one turn per message, with the sender's name and the message time, and a thread is treated as one conversation. Before, they parsed to nothing and were retried on every run. A one-message thread is an email, not a conversation, and is recorded as not extractable. (#5025)
- **Meeting-note labels are never speakers.** `**Attendees:**`, `**Date:**`, `**Location:**`, `**Summary:**` and similar labels no longer parse as speaker turns, so facts from meeting notes are not attributed to "Date" and dated 1970-01-01. On brains without managed persistence, a meeting or email page with no speaker turns that looks like meeting notes or a calendar event is recorded as not extractable and leaves the conversation-facts backlog until the page changes (managed brains keep retrying those pages, as before); a page with time-only turns and no date is recorded the same way instead of producing epoch-dated facts (add `date:` to its frontmatter to extract it). (#5025, D-N2)
- **Adding a fact or take to an atom no longer re-buys its concept.** The `synthesize_concepts` change check and prompt ignore `## Facts` / `## Takes` sections, and concept pages hashed the old way are updated without a model call while their atoms are unchanged. On brains without managed persistence, re-synthesizing a concept keeps the page's fences, timeline, tags and frontmatter, and a concept whose narrative changed during synthesis is left as is and retried next run. (D-N3)
- **Opt-in files for generated atoms and concepts.** `gbrain config set cycle.extract_atoms.write_through true` and `gbrain config set cycle.synthesize_concepts.write_through true` write generated atoms and concepts as markdown files in the source checkout on brains without managed persistence; the next run also writes the ones generated before. Targets your `.gitignore` or `storage.db_only` covers stay database-only. A concept page that already has a file is now always rewritten in place, so an old file can no longer be synced back over the new narrative. (#5041)

## Upgrade-note rows

| Change | Who is affected | What happens on upgrade | Action |
|---|---|---|---|
| Migration `w9_p_facts_reconcile` (placeholder v209) adds `page_facts_reconcile` | every brain | empty side table; no page row is rewritten | none |
| First cycles after upgrade drain the facts watermark | unmanaged brains | each cycle reconciles up to 250 fence pages (pages without a fence are settled in one bounded statement); new fact rows embed under the existing embedding setup, keyless brains make no calls | none; `gbrain dream --phase extract_facts` drains at once |
| Concept member hash formula | brains with concept pages | unchanged concepts are rehashed without a model call on the next `synthesize_concepts` run | none |
| Prose meeting/email, one-message email and undated pages become terminal | unmanaged brains running conversation-facts backfill (undated pages on every brain) | those pages leave the backlog once scanned | none |

## Notes for the integrator

- Migration file `src/core/schema-migrations/v209-w9-p-facts-reconcile.ts` (`name: 'w9_p_facts_reconcile'`) is a placeholder number; renumbering also updates `registry.generated.ts`, `test/fixtures/goldens/migrations/records.json` and the doctor JSON goldens (schema version, Postgres RLS table count 116).
- `test/graduation-inventory.test.ts` reviewed carry count moved 105 → 106 for the new table.
- Size ratchet raises (each justified in its TSV row): `src/core/cycle.ts` +1, `src/core/cycle/extract-atoms.ts` +5, `processPage` +12, `runPhaseSynthesizeConcepts` +16, `runPhaseExtractAtoms` +2.
- Catalog goldens regenerated for the new table (`test/fixtures/goldens/catalog/*`, `pglite-upgrade-replay/catalog-after-boot.json`); renumbering the migration does not change them.
- Finding for the managed-persistence owners: on a managed brain, `extract-conversation-facts` publishes its fact and audit rows through `replaceDerivedFactsForPage` (a `withCoordinatedWrite` transaction with no persistence request), which `test/helpers/managed-connector-job-contract.ts` reports as "change without a coordinator publication receipt". Master never reached it for connector pages because they did not parse; this lane keeps it unreached for the new terminal outcomes (managed brains skip them without writing), but a multi-message Gmail thread on a managed brain now extracts through that same path.
