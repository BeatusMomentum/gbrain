/**
 * `gbrain init --json`'s first-run decision bundle (agent contract v1 D2,
 * spec G5): ONE `kind: 'ask'` notice whose `decisions[]` carry what the human
 * output relays through `[AGENT]` lines, plus one `user_message`. Init stays
 * non-blocking (exit 0); the agent relays the message and applies the chosen
 * options' argv.
 *
 * Ownership: Lane G5 owns the bundle's content (adding `writeback` and
 * `skills_scaffold`, the `user_message` wording, the harness smoke follow-up);
 * Lane D ships this seam and the decisions it can build today:
 * `search_mode` (the picker's recommendation and cost matrix) and
 * `harness_wiring` (the A7 readiness fix). Extend `buildInitFirstRunNotices`
 * rather than adding a second notice.
 */
import { shellQuote, type Decision, type Notice } from '../core/agent-output.ts';
import type { GBrainConfig } from '../core/config.ts';
import { configReadiness, embeddingEnablement } from '../core/readiness.ts';
import type { SearchMode } from '../core/search/mode.ts';

export interface InitFirstRunInputs {
  /** The search mode init applied and why (from the install-time picker). */
  searchMode?: { mode: SearchMode; reason: string };
  /** The config init saved; harness wiring is read from its config-plane readiness. */
  config?: GBrainConfig | null;
}

const SEARCH_MODE_COST =
  'Per-query search payload cost at 10K queries/month (Haiku 4.5 / Sonnet 4.6 / Opus 4.7): ' +
  'conservative $40 / $120 / $200, balanced $100 / $300 / $500, tokenmax $200 / $600 / $1,000 per month.';

function searchModeDecision(applied: { mode: SearchMode; reason: string }): Decision {
  const modes: SearchMode[] = ['conservative', 'balanced', 'tokenmax'];
  return {
    id: 'search_mode',
    question: `Which search mode should this brain use? ${SEARCH_MODE_COST}`,
    options: modes.map(m => ({ id: m, label: m === applied.mode ? `${m} (applied)` : m, argv: ['gbrain', 'config', 'set', 'search.mode', m] })),
    default: applied.mode,
    default_reason: applied.reason,
  };
}

function harnessWiringDecision(config: GBrainConfig): Decision | null {
  const entry = configReadiness(config, { transport: 'cli' }).entries.find(e => e.capability === 'harness_wiring');
  if (!entry?.fix || entry.state === 'ok') return null;
  return {
    id: 'harness_wiring',
    question: entry.fix.user_message ?? entry.why,
    options: [
      { id: 'wire', label: entry.fix.why, ...(entry.fix.argv ? { argv: entry.fix.argv } : {}) },
      { id: 'skip', label: 'Do not register gbrain with an agent harness now.' },
    ],
    default: entry.fix.argv ? 'wire' : 'skip',
    default_reason: entry.why,
  };
}

/** The bundle: empty when there is nothing to decide. */
export function buildInitFirstRunNotices(inputs: InitFirstRunInputs): Notice[] {
  const decisions: Decision[] = [];
  if (inputs.searchMode) decisions.push(searchModeDecision(inputs.searchMode));
  if (inputs.config) {
    const wiring = harnessWiringDecision(inputs.config);
    if (wiring) decisions.push(wiring);
  }
  if (decisions.length === 0) return [];
  const defaults = decisions.map(d => `${d.id}: ${d.default}`).join('; ');
  return [{
    code: 'first_run_decisions',
    kind: 'ask',
    why: 'The brain is ready. These settings were applied with defaults or need the user\'s choice; none blocks using the brain.',
    user_message: `gbrain is installed. Reply 'defaults' to keep the recommended settings (${defaults}), or tell me what to change.`,
    decisions,
  }];
}

/**
 * The deferred-setup line init prints for `--no-embedding`: the same enable
 * command readiness gives doctor, embed and MCP (A7 `embeddingEnablement`:
 * resolved datastore, a provider that fits, pages and facts kept).
 */
export function deferredEmbeddingHint(cfg: GBrainConfig): string {
  const enable = embeddingEnablement(cfg);
  const step = enable.argv ? shellQuote(enable.argv) : 'gbrain doctor --only embeddings --json';
  return `  --no-embedding: deferred setup — enable later with \`${step}\` (\`config set embedding_model\` is refused by design)`;
}
