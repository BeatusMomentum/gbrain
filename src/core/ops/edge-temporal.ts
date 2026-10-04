/**
 * Temporal edge policy for graph read operations (get_links, get_backlinks,
 * traverse_graph). Graph reads return live relationships by default; `status`
 * ('live' | 'ended' | 'all'), `as_of` (YYYY-MM-DD) and `during` (YYYY,
 * YYYY-MM, YYYY-MM-DD or FROM..UNTIL) choose history. `graph.edge_validity off`
 * turns the policy off (every edge, as before). Hidden former relationships are
 * reported through the `gbrain.temporal` response meta and a model-visible
 * `former_relationships_hidden` notice so an empty result is never mistaken
 * for "no relationship ever existed".
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import type { Notice } from '../agent-output.ts';
import type { Link } from '../types.ts';
import { edgeMatchesTemporal, edgeValidityEnabled, parseTemporalParams, utcToday, type EdgeTemporalOpts, type TemporalAnnotation } from '../link-validity.ts';

export const TEMPORAL_EDGE_PARAMS: Record<'status' | 'as_of' | 'during', ParamDef> = {
  status: { type: 'string', enum: ['live', 'ended', 'all'], description: "Relationship status: live (default: what is true now, or at as_of), ended (former only), all (history)." },
  as_of: { type: 'string', description: 'Answer as of this date (YYYY-MM-DD) instead of today.' },
  during: { type: 'string', description: 'Relationships true at any point in a period: YYYY, YYYY-MM, YYYY-MM-DD or FROM..UNTIL (e.g. 2022, 2021..2023-06).' },
};


/** Validate the temporal params and resolve the effective policy for this call. */
export async function resolveEdgeTemporal(ctx: OperationContext, p: Record<string, unknown>, opName: string): Promise<EdgeTemporalOpts> {
  const parsed = parseTemporalParams({ status: p.status, as_of: p.as_of, during: p.during });
  if (!parsed.ok) {
    throw opError('invalid_params', `${opName}: ${parsed.message}`,
      `Pass ${parsed.param} like status: "all", as_of: "2022-06-30" or during: "2022"; omit it for what is true today.`);
  }
  const enabled = await edgeValidityEnabled(ctx.engine);
  return { ...parsed.opts, disabled: !enabled };
}

/** Keep the rows matching the policy; count what was hidden. Rows must carry a temporal annotation. */
export function filterTemporalLinks(links: Link[], temporal: EdgeTemporalOpts): { kept: Link[]; hidden: number } {
  if (temporal.disabled) return { kept: links, hidden: 0 };
  const kept = links.filter(l => edgeMatchesTemporal(l as Link & TemporalAnnotation, temporal));
  return { kept, hidden: links.length - kept.length };
}

/**
 * Publish what the temporal policy did: response meta always (when the policy
 * is on), and a notice when it hid relationships, naming the exact call that
 * shows them.
 */
export function reportTemporal(ctx: OperationContext, opName: string, p: Record<string, unknown>, temporal: EdgeTemporalOpts, hidden: number | null): void {
  if (temporal.disabled) return;
  const effective = { status: temporal.status ?? 'live', as_of: temporal.asOf ?? utcToday(), ...(temporal.during ? { during: temporal.during } : {}), ...(hidden !== null ? { hidden } : {}) };
  ctx.emitResponseMeta?.('gbrain.temporal', effective);
  if (!hidden || (temporal.status ?? 'live') === 'all') return;
  const args: Record<string, unknown> = {};
  for (const key of ['slug', 'source_id', 'all_sources', 'depth', 'link_type', 'direction']) if (p[key] !== undefined) args[key] = p[key];
  args.status = 'all';
  const notice: Notice = {
    code: 'former_relationships_hidden',
    kind: 'info',
    why: `${hidden} relationship${hidden === 1 ? '' : 's'} that ${hidden === 1 ? 'is' : 'are'} not ${temporal.status === 'ended' ? 'ended' : 'true'} as of ${effective.as_of} ${hidden === 1 ? 'was' : 'were'} left out of this ${opName} result.`,
    fix: {
      mcp: { tool: opName, arguments: args },
      consent: [],
      actor: 'agent',
      why: 'Shows every relationship with its status and dates (live, ended, ended_unknown_date); use as_of: YYYY-MM-DD for a past date.',
      requires_exclusive: false,
    },
  };
  ctx.emitNotice?.(notice);
}
