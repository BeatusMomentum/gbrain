/**
 * #4494 — propose_takes extractor output caps are configurable.
 *
 * Pre-fix, PROPOSE_TAKES_MAX_TOKENS=2048 / PROPOSE_TAKES_RETRY_MAX_TOKENS=4096
 * were hardcoded exports with no config read. Thinking models spend reasoning
 * tokens INSIDE maxTokens, so dense pages truncated at 2048, retried at 4096,
 * truncated again, threw, and were re-billed every cycle forever.
 *
 * Post-fix: dream.propose_takes.max_tokens / dream.propose_takes.retry_max_tokens
 * (floor 256; retry clamped >= base) resolve at the phase's engine.getConfig
 * seam (dream.triage.max_tokens precedent) and thread into defaultExtractor.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  runPhaseProposeTakes,
  defaultExtractor,
  PROPOSE_TAKES_MAX_TOKENS,
  PROPOSE_TAKES_RETRY_MAX_TOKENS,
  type ProposeTakesExtractor,
} from '../src/core/cycle/propose-takes.ts';
import { parsePhaseConfigValue } from '../src/core/cycle/phase-config-values.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON = '[{"claim_text":"Acme doubles ARR by Q4","kind":"bet","holder":"brain","weight":0.7}]';

const baseInput = {
  pagePath: 'companies/acme-example',
  pageBody: 'I bet Acme doubles ARR by Q4.',
  existingTakes: [],
};

describe('defaultExtractor configurable caps (#4494)', () => {
  test('input.maxTokens overrides the base cap', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 8192 });
    expect(seen).toHaveLength(1);
    expect(seen[0].maxTokens).toBe(8192);
  });

  test('truncation retry uses retryMaxTokens (clamped >= base)', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? chatResult('[{"claim_text":"tru', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 6000, retryMaxTokens: 3000 });
    expect(seen).toHaveLength(2);
    expect(seen[0].maxTokens).toBe(6000);
    // retry clamp: a retry cap below base escalates to at least base.
    expect(seen[1].maxTokens).toBe(6000);
  });

  test('floor: sub-256 maxTokens is raised to 256', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor({ ...baseInput, maxTokens: 16 });
    expect(seen[0].maxTokens).toBe(256);
  });

  test('defaults unchanged when no overrides are passed', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? chatResult('trunc', 'length')
        : chatResult(GOOD_JSON, 'end');
    });
    await defaultExtractor(baseInput);
    expect(seen[0].maxTokens).toBe(PROPOSE_TAKES_MAX_TOKENS);
    expect(seen[1].maxTokens).toBe(PROPOSE_TAKES_RETRY_MAX_TOKENS);
  });
});

// ─── phase-level config threading ───────────────────────────────────

function buildMockEngine(config: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    async getConfig(key: string): Promise<string | null> {
      return config[key] ?? null;
    },
    async executeRaw<T>(sql: string): Promise<T[]> {
      if (sql.includes('SELECT slug, source_id, compiled_truth')) {
        return [{
          slug: 'wiki/page-0',
          source_id: 'default',
          compiled_truth: 'prose with a bold claim in it',
        }] as T[];
      }
      if (sql.includes('SELECT id FROM take_proposals')) return [];
      if (sql.includes('INSERT INTO take_proposals')) return [{ id: 1 } as unknown as T];
      return [];
    },
  } as unknown as BrainEngine;
}

function buildCtx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('runPhaseProposeTakes threads dream.propose_takes.* config (#4494)', () => {
  test('configured caps reach the extractor input', async () => {
    const engine = buildMockEngine({
      'dream.propose_takes.max_tokens': '5000',
      'dream.propose_takes.retry_max_tokens': '9000',
    });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].maxTokens).toBe(5000);
    expect(seen[0].retryMaxTokens).toBe(9000);
  });

  test('unset config keeps the #3763 defaults; retry clamps to >= base', async () => {
    const engine = buildMockEngine({ 'dream.propose_takes.max_tokens': '6000' });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen[0].maxTokens).toBe(6000);
    // Default retry (4096) < configured base (6000) → clamped up to base.
    expect(seen[0].retryMaxTokens).toBe(6000);
  });

  test('garbage values fall back to defaults', async () => {
    const engine = buildMockEngine({
      'dream.propose_takes.max_tokens': 'banana',
      'dream.propose_takes.retry_max_tokens': '',
    });
    const seen: Array<{ maxTokens?: number; retryMaxTokens?: number }> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push({ maxTokens: input.maxTokens, retryMaxTokens: input.retryMaxTokens });
      return [];
    };
    await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen[0].maxTokens).toBe(PROPOSE_TAKES_MAX_TOKENS);
    expect(seen[0].retryMaxTokens).toBe(PROPOSE_TAKES_RETRY_MAX_TOKENS);
  });
});

// #5958 / #5874: dream.propose_takes.call_timeout_ms. A stored value the phase
// cannot use warns with the key named (never the value); an out-of-range number
// is held to 1000..300000; the configured bound never outlasts the remaining
// phase deadline beyond the default 90s floor.
describe('runPhaseProposeTakes threads dream.propose_takes.call_timeout_ms (#5958)', () => {
  const KEY = 'dream.propose_takes.call_timeout_ms';
  test.each([
    ['an in-range value threads through', '240000', 240_000, false],
    ['unset keeps the output-cap scaling', undefined, undefined, false],
    ['blank reads as unset', '  ', undefined, false],
    ['a non-number keeps the scaling with a warning', 'banana', undefined, true],
    ['zero keeps the scaling with a warning', '0', undefined, true],
    ['a negative value keeps the scaling with a warning', '-7', undefined, true],
    ['a fractional value floors with a warning', '1500.7', 1_500, true],
    ['below 1000 is held to 1000 with a warning', '20', 1_000, true],
    ['above 300000 is held to 300000 with a warning', '300001', 300_000, true],
    ['a value AbortSignal.timeout would reject is held to 300000', '1e16', 300_000, true],
  ] as const)('call_timeout_ms: %s', async (_name, raw, expectedMs, warns) => {
    const engine = buildMockEngine(raw === undefined ? {} : { [KEY]: raw });
    const seen: Array<number | undefined> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push(input.callTimeoutMs);
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen).toEqual([expectedMs]);
    const warnings = (result.details as { warnings: string[] }).warnings;
    const named = warnings.filter((w) => w.includes(KEY));
    expect(named.length > 0).toBe(warns);
    for (const w of named) {
      expect(w).toContain(`gbrain config set ${KEY}`);
      expect(w).toContain(`gbrain config get ${KEY}`);
      if (raw !== undefined && raw.trim().length > 2) expect(w).not.toContain(raw);
    }
    if (warns) expect(result.status).toBe('warn');
  });

  test('a failed config read keeps the scaling and does not stop the phase', async () => {
    const engine = buildMockEngine({});
    const getConfig = engine.getConfig.bind(engine);
    engine.getConfig = async (key: string) => {
      if (key === KEY) throw new Error('config plane down');
      return getConfig(key);
    };
    const seen: Array<number | undefined> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push(input.callTimeoutMs);
      return [];
    };
    const result = await runPhaseProposeTakes(buildCtx(engine), { extractor });
    expect(seen).toEqual([undefined]);
    expect(result.status).not.toBe('fail');
  });

  test('the configured bound is held to the remaining phase deadline, never below the 90s default', async () => {
    const seen: Array<number | undefined> = [];
    const extractor: ProposeTakesExtractor = async (input) => {
      seen.push(input.callTimeoutMs);
      return [];
    };
    await runPhaseProposeTakes(buildCtx(buildMockEngine({ [KEY]: '240000' })), { extractor, deadlineMs: 150_000 });
    expect(seen[0]).toBeGreaterThan(149_000);
    expect(seen[0]).toBeLessThanOrEqual(150_000);
    await runPhaseProposeTakes(buildCtx(buildMockEngine({ [KEY]: '240000' })), { extractor, deadlineMs: 10_000 });
    expect(seen[1]).toBe(90_000);
  });
});

describe('config set validation for dream.propose_takes.call_timeout_ms (#5958)', () => {
  const KEY = 'dream.propose_takes.call_timeout_ms';
  test('the key is registered and an in-range whole number is accepted', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(KEY);
    expect(parsePhaseConfigValue(KEY, '1000')).toBe(1_000);
    expect(parsePhaseConfigValue(KEY, '300000')).toBe(300_000);
  });

  for (const bad of ['999', '300001', '1500.5', 'banana', '0']) {
    test(`${JSON.stringify(bad)} is refused with the rendered contract and never echoed`, () => {
      let err: unknown;
      try { parsePhaseConfigValue(KEY, bad); } catch (e) { err = e; }
      const rendered = renderCliError(err, { json: true, command: 'config', tty: false });
      expect(rendered.exitCode).toBe(2);
      const env = JSON.parse(rendered.stdout!);
      expect(env).toMatchObject({
        code: 'invalid_params',
        fix: { argv: ['gbrain', 'config', 'set', KEY, '<VALUE>'], verify: { argv: ['gbrain', 'config', 'get', KEY] } },
      });
      expect(env.message).toContain('1000 to 300000');
      expect(env.why).toContain('Nothing was written');
      if (bad.length > 1) expect(rendered.stdout).not.toContain(bad);
    });
  }
});

