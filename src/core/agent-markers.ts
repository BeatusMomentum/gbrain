/**
 * The one builder for `[AGENT] … [/AGENT]` blocks with an optional fenced
 * `[SHOW USER] … [/SHOW USER]` relay (agent operator contract v1, A6
 * markers). Every other module asks this one for marker text, so the format
 * cannot fork; a grep test pins that markers come only from here.
 *
 * Every interpolated value passes through inertText(): newlines flatten and
 * marker tokens lose their opening bracket, so a page title or model name
 * cannot open or close a block. Field names come from the fixed vocabulary.
 */
import { inertText } from './agent-output.ts';

export const AGENT_FIELDS = ['ask', 'why', 'risk', 'consent', 'actor', 'next', 'if_yes', 'if_no', 'verify'] as const;
export type AgentField = (typeof AGENT_FIELDS)[number];

const MAX_FIELD = 1_000;

/** `[AGENT]` block, fields in vocabulary order, empty ones skipped; the relay text is fenced inside it. */
export function agentBlock(fields: Partial<Record<AgentField, string>>, opts: { showUser?: string } = {}): string {
  const lines = ['[AGENT]'];
  for (const name of AGENT_FIELDS) {
    const value = fields[name];
    if (value) lines.push(`${name}: ${inertText(value, MAX_FIELD)}`);
  }
  if (opts.showUser) lines.push('[SHOW USER]', inertText(opts.showUser, MAX_FIELD), '[/SHOW USER]');
  lines.push('[/AGENT]');
  return `${lines.join('\n')}\n`;
}
