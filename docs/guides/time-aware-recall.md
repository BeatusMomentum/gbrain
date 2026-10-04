# Time-aware recall

`gbrain think` answers in a date frame. It knows today's date in your brain's
timezone, it sees the content date of each page it reads, and it resolves
relative time words against the right one: "last month" in your question
against today, "yesterday" inside a meeting note against that note's date.
It can also take brief reading notes before answering, which helps when the
answer is spread across several dated pages.

## Say to your agent

- *"What did I decide about pricing last month?"* — your agent runs
  `gbrain think "What did I decide about pricing last month?"`; the answer is
  grounded in today's date and each page's date.
- *"Answer as if today were March 1, 2024."* — `gbrain think "…" --reference-date 2024-03-01`.
- *"Show me your reading notes."* — `gbrain think "…" --reading-notes on --json`;
  the notes come back in `reading_notes.notes`.
- *"Always read with notes for date questions."* — `gbrain config set think.reading_notes auto`.

## What the reader sees

- **Current date.** The user message carries `Current date: YYYY-MM-DD (<zone>)`
  just before the question. The zone is `brain.timezone`
  (`gbrain config set brain.timezone America/Los_Angeles`); unset means UTC.
  `--reference-date` / MCP `reference_date` replaces today with a past or
  current YYYY-MM-DD; a malformed or future date is refused with
  `invalid_params` before any model call.
- **Page dates.** Each `<page>` block carries `date="YYYY-MM-DD"` when the page
  has a content date: frontmatter `event_date`, `date` or `published`, or a
  dated filename. A page whose date fell back to when the file or row was
  created carries no date, because that time says nothing about the content.
  A day-only frontmatter date renders as written; a timestamp renders in the
  brain's timezone.
- **Search results** already carry each page's `effective_date` and
  `effective_date_source`, so an agent reading `search` or `query` output
  directly can apply the same rule.

## Reading notes

| Setting | Behavior |
|---|---|
| `think.reading_notes off` (default) | The reader answers directly. |
| `think.reading_notes on` | The reader first writes brief notes (the facts and dates each relevant page gives, under 150 words), then answers. |
| `think.reading_notes auto` | Notes only for time and knowledge-update questions, or when think gathered 8 or more pages. |

Per call: `gbrain think "…" --reading-notes on|off|auto`, or MCP
`think { reading_notes: "on" }`. Notes add up to 512 output tokens, so they
cost a little more and take a little longer. They return in
`reading_notes: { mode, notes }` and never appear in `answer`, citations or a
saved synthesis (`--save`). If the model's output is cut off before the
answer, the call reports `synthesis_status: output_truncated` with the warning
`READING_NOTES_TRUNCATED`, saves nothing, and can be retried with
`--reading-notes off`.

## Measuring it

The LongMemEval harness carries eval-only arms for the next steps of
time-aware retrieval — fact keys merged into chunk embeddings and a soft time
scope driven by the question's explicit time words. They run only inside
`gbrain eval longmemeval` (`--fact-keys`, `--time-scope`); see
[`docs/eval-bench.md`](../eval-bench.md) and the
[evaluation key files](../architecture/key-files/evaluation.md).
