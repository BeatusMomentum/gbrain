/**
 * gbrain fact-keys — status, refresh and clear for fact keys in chunk
 * embeddings (docs/designs/FACT_KEYS.md, docs/guides/time-aware-recall.md).
 *
 *   gbrain fact-keys status [--json]
 *   gbrain fact-keys refresh [--page SLUG] [--source ID] [--limit N] [--dry-run] [--json]
 *   gbrain fact-keys clear [--page SLUG] [--source ID] [--limit N] [--json]
 *
 * refresh re-runs facts extraction (a paid model call per page) for eligible
 * pages without keys for their current revision; extraction publishes the
 * keys. clear strips keys whatever `search.fact_keys` says, re-embedding the
 * keyed chunks first, so no vector is ever left without its keys' provenance.
 */
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { factKeysStatus, FACT_KEYS_ELIGIBLE_SQL as ELIGIBLE_SQL } from '../core/facts/fact-keys-status.ts';
import { clearPageFactKeys, factKeysEnabled, FACT_KEYS_CONFIG_KEY } from '../core/facts/fact-keys-publish.ts';

const HELP = `Usage: gbrain fact-keys <status|refresh|clear> [options]

Fact keys merge facts extracted from a page into the embedding input of the
page's own chunks, so a question phrased like a fact finds the page. Stored
chunk text and search results are unchanged. Setting: ${FACT_KEYS_CONFIG_KEY} (on|off).

  status [--json]                  keyed pages and chunks, eligible pages without keys, leftovers while off
  refresh [--page SLUG] [--source ID] [--limit N] [--dry-run] [--json]
                                   re-run facts extraction for eligible pages without current keys
                                   (one paid model call per page; default limit 50; --dry-run lists them)
  clear [--page SLUG] [--source ID] [--limit N] [--json]
                                   strip keys (re-embeds keyed chunks first); run after turning the setting off

Guide: docs/guides/time-aware-recall.md
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function refreshCandidates(engine: BrainEngine, opts: { slug?: string; sourceId?: string; limit: number }) {
  return engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id,p.slug FROM pages p
    WHERE ${ELIGIBLE_SQL} AND ($1::text IS NULL OR p.slug=$1) AND ($2::text IS NULL OR p.source_id=$2)
      AND NOT EXISTS (SELECT 1 FROM page_fact_keys k WHERE k.page_id=p.id AND k.page_revision=p.knowledge_revision::text)
    ORDER BY p.updated_at DESC, p.id LIMIT $3`, [opts.slug ?? null, opts.sourceId ?? null, opts.limit]);
}

async function clearCandidates(engine: BrainEngine, opts: { slug?: string; sourceId?: string; limit: number }) {
  return engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id,p.slug FROM pages p
    WHERE ($1::text IS NULL OR p.slug=$1) AND ($2::text IS NULL OR p.source_id=$2)
      AND (EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.fact_keys IS NOT NULL)
        OR EXISTS (SELECT 1 FROM page_fact_keys k WHERE k.page_id=p.id))
    ORDER BY p.id LIMIT $3`, [opts.slug ?? null, opts.sourceId ?? null, opts.limit]);
}

export async function runFactKeys(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help')) { process.stdout.write(HELP); return; }
  const json = args.includes('--json');
  const scope = { slug: flag(args, '--page'), sourceId: flag(args, '--source'), limit: Number(flag(args, '--limit') ?? 50) };
  if (!Number.isInteger(scope.limit) || scope.limit <= 0) {
    process.stderr.write(`--limit must be a positive integer (got: ${flag(args, '--limit')})\n`);
    setCliExitVerdict(2);
    return;
  }
  if (sub === 'status') {
    const status = await factKeysStatus(engine);
    if (json) { process.stdout.write(JSON.stringify(status, null, 2) + '\n'); return; }
    const lines = [
      `Fact keys: ${status.enabled ? 'on' : 'off'} (${FACT_KEYS_CONFIG_KEY})`,
      `Keyed: ${status.keyed_pages} page(s), ${status.keyed_chunks} chunk(s), ${status.key_rows} key row(s)`,
      `Eligible pages without keys: ${status.eligible_unkeyed_pages}`,
    ];
    if (status.enabled && status.eligible_unkeyed_pages > 0) lines.push('Next: `gbrain fact-keys refresh --dry-run` lists them; refresh re-runs paid extraction, so ask the user before a large run.');
    if (!status.enabled && (status.keyed_chunks > 0 || status.key_rows > 0)) lines.push('Keys remain while the setting is off. Next: `gbrain fact-keys clear` strips them (re-embeds the keyed chunks).');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  if (sub === 'refresh') {
    if (!await factKeysEnabled(engine)) {
      process.stderr.write(`Fact keys are off. Turn them on with \`gbrain config set ${FACT_KEYS_CONFIG_KEY} on\` (ask the user first: keys re-embed keyed chunks), then rerun.\n`);
      setCliExitVerdict(2);
      return;
    }
    const pages = await refreshCandidates(engine, scope);
    if (args.includes('--dry-run')) {
      if (json) process.stdout.write(JSON.stringify({ dry_run: true, pages }, null, 2) + '\n');
      else process.stdout.write(`${pages.length} page(s) would be re-extracted (one paid model call each):\n${pages.map(p => `  ${p.source_id}:${p.slug}`).join('\n')}\n`);
      return;
    }
    const { runFactsBackstop } = await import('../core/facts/backstop.ts');
    const results: Array<{ source_id: string; slug: string; outcome: string }> = [];
    for (const { source_id, slug } of pages) {
      const page = await engine.getPage(slug, { sourceId: source_id });
      if (!page) { results.push({ source_id, slug, outcome: 'missing' }); continue; }
      try {
        const r = await runFactsBackstop({ slug, type: page.type, compiled_truth: page.compiled_truth, frontmatter: (page.frontmatter ?? {}) as Record<string, unknown> },
          { engine, sourceId: source_id, sessionId: null, source: 'mcp:put_page', mode: 'inline', notabilityFilter: 'all' });
        const keyed = await engine.executeRaw('SELECT 1 FROM page_fact_keys k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1 AND p.slug=$2 AND k.page_revision=p.knowledge_revision::text LIMIT 1', [source_id, slug]);
        results.push({ source_id, slug, outcome: keyed.length ? 'keyed' : ('skipped' in r && r.skipped) ? String(r.skipped) : 'no_keys' });
      } catch (error) {
        results.push({ source_id, slug, outcome: `error: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (json) process.stdout.write(JSON.stringify({ pages: results }, null, 2) + '\n');
    else process.stdout.write(`Refreshed ${results.filter(r => r.outcome === 'keyed').length}/${results.length} page(s).\n${results.filter(r => r.outcome !== 'keyed').map(r => `  ${r.source_id}:${r.slug}  ${r.outcome}`).join('\n')}${results.some(r => r.outcome !== 'keyed') ? '\n' : ''}`);
    if (results.some(r => r.outcome.startsWith('error'))) setCliExitVerdict(1);
    return;
  }
  if (sub === 'clear') {
    const pages = await clearCandidates(engine, scope);
    const results: Array<{ source_id: string; slug: string; outcome: string }> = [];
    for (const { source_id, slug } of pages) {
      const r = await clearPageFactKeys(engine, source_id, slug);
      if (!r.published && r.reason === 'superseded') {
        await engine.executeRaw('DELETE FROM page_fact_keys k USING pages p WHERE p.id=k.page_id AND p.source_id=$1 AND p.slug=$2 AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.fact_keys IS NOT NULL)', [source_id, slug]);
      }
      results.push({ source_id, slug, outcome: r.published ? 'cleared' : r.reason });
    }
    if (json) process.stdout.write(JSON.stringify({ pages: results }, null, 2) + '\n');
    else process.stdout.write(`Cleared ${results.filter(r => r.outcome === 'cleared').length}/${results.length} page(s).${results.length === scope.limit ? ' More may remain; rerun.' : ''}\n`);
    if (results.some(r => r.outcome !== 'cleared')) setCliExitVerdict(1);
    return;
  }
  process.stderr.write(`Unknown subcommand: ${sub}\n\n${HELP}`);
  setCliExitVerdict(2);
}
