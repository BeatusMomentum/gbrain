import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { writerLintForPutPage } from '../output/post-write.ts';
import type { WriteRequest } from './model.ts';
import { prepareFactsBackstop } from './effect-facts.ts';
import { lineGrammarOptions, parseLineGrammar } from '../line-grammar.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';

const LINE_GRAMMAR_FINDINGS_MAX = 5;

/**
 * What the line grammar read from this page body: typed relation lines and
 * fact lines, with every near-miss explained. Absent when the page has none.
 * Relations are stored with the page's links (or by the next sweep for a
 * remote writer); fact lines stay page text and are not added to `facts`.
 */
async function lineGrammarAdvisory(engine: BrainEngine, row: WriteRequest, page: ParsedPage): Promise<Record<string, unknown> | undefined> {
  const options = await lineGrammarOptions(engine);
  if (!options.enabled) return undefined;
  const pack = options.allowUndeclaredTypes ? null : (await loadActivePackForLocalEngine(engine, { sourceId: row.source_id }))?.manifest ?? null;
  const declaredTypes = pack?.link_types.length ? new Set(pack.link_types.map(lt => lt.name)) : null;
  const parsed = parseLineGrammar(page.compiled_truth, { declaredTypes });
  if (!parsed.relations.length && !parsed.facts.length && !parsed.diagnostics.length) return undefined;
  const relationsState = !(await isAutoLinkEnabled(engine)) ? 'auto_link_disabled'
    : row.authority.remote && !row.authority.autoLinkTrusted ? 'pending_sweep' : 'stored';
  return {
    relations: parsed.relations.length,
    relations_state: relationsState,
    facts: parsed.facts.length,
    ...(parsed.facts.length ? { facts_state: 'page_text_only',
      facts_message: 'Fact lines are searchable page text; they are not added to recall facts. Use remember (or the page ## Facts table) for a fact recall must return.' } : {}),
    findings: parsed.diagnostics.slice(0, LINE_GRAMMAR_FINDINGS_MAX).map(d => ({ severity: 'warning', validator: 'line-grammar',
      line: d.line, reason: d.reason, text: d.text, message: d.message })),
    total: parsed.diagnostics.length,
    details_truncated: parsed.diagnostics.length > LINE_GRAMMAR_FINDINGS_MAX,
  };
}

const LINT_MESSAGES: Record<string,string> = { citation:'Paragraph has no citation marker.',
  link:'A link target is unavailable.', 'back-link':'A reverse link is missing.', 'triple-hr':'An ambiguous timeline separator was found.' };

export function remoteLinkHint(row: WriteRequest): Record<string, unknown> {
  return row.authority.remote && !row.authority.autoLinkTrusted ? { auto_links: { skipped: 'remote',
    hint: 'Body wikilinks are saved as text but NOT reconciled into the graph. A stdio `gbrain serve` sweeps them at startup + on idle; `gbrain serve --http` does not self-sweep — run `gbrain sweep --once` (delegates to a live serve over IPC), use trusted local capture/put_page for inline link extraction, or add_link for edges needed now.' } } : {};
}
export function pageNoopAdvisories(row: WriteRequest): Record<string, unknown> {
  return { ...remoteLinkHint(row), ...(['put_page', 'capture', 'edit_page'].includes(row.operation) ? { facts_backstop: { skipped: 'not_imported' } } : {}) };
}
/** Optional lint reads are outside publication locks; its bounded result is retained in the receipt. */
export async function preparePageAdvisories(engine: BrainEngine, row: WriteRequest, page: ParsedPage) {
  const visible = row.authority.remote ? { ...page, compiled_truth: sanitizeRemoteBody(page.compiled_truth),
    timeline: sanitizeRemoteBody(page.timeline ?? '') } : page;
  const lint = await writerLintForPutPage(engine, row.slug, { sourceId: row.source_id, noLog: true, page: visible });
  const sanitized = lint && 'top_findings' in lint ? { ...lint,
    top_findings: lint.top_findings.map(finding => ({ ...finding, message: LINT_MESSAGES[finding.validator] ?? `${finding.validator} validation finding.` })) } : lint;
  const facts = ['put_page', 'capture', 'edit_page'].includes(row.operation)
    ? await prepareFactsBackstop(engine, row, page).catch(() => ({ skipped: 'backstop_error' })) : undefined;
  const grammar = await lineGrammarAdvisory(engine, row, visible).catch(() => undefined);
  return { ...remoteLinkHint(row), ...(sanitized ? { writer_lint: sanitized } : {}), ...(facts ? { facts_backstop: facts } : {}),
    ...(grammar ? { line_grammar: grammar } : {}) };
}
