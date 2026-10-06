/**
 * reconfigureGatewayWithEngine — the clobber regression suite.
 *
 * The historical bug: reconfigure resolved `models.chat` with tier
 * 'reasoning', and the key-blind tier default beat the caller fallback — an
 * explicit `chat_model: "openai:gpt-5.2"` in ~/.gbrain/config.json was
 * silently replaced with the Anthropic default on every engine connect.
 *
 * Post-fix contract: DB-plane overrides win as before; when resolution falls
 * to the tier default, the SHARED effective-model resolver consults the RAW
 * file config — a SERVABLE pin survives, an unservable pin (provider switch)
 * falls to the key-aware default with one warn.
 *
 * Hermetic: GBRAIN_HOME points at a temp dir (the file-plane read), provider
 * key envs are pinned, gateway env is injected via configureGateway.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway,
  reconfigureGatewayWithEngine,
  getChatModel,
  resetGateway,
  chat,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { TIER_DEFAULTS, _resetDeprecationWarningsForTest, openaiStaticTierFallback } from '../src/core/model-config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig() {}
}

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;
let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);

function writeFileConfig(cfg: Record<string, unknown>): void {
  // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-reconf-'));
  process.env.GBRAIN_HOME = tmpHome;
  stub = new StubEngine();
  resetGateway();
  _resetDeprecationWarningsForTest();
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Shard hygiene (same pattern as facts-extract-silent-no-op.test.ts): restore
// the legacy embedding pin so later fresh-schema files in this shard's
// process don't size vector columns from this file's leftover gateway state.
afterAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('reconfigureGatewayWithEngine — no-clobber', () => {
  test('servable file pin survives reconnect (THE regression)', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('openai:gpt-5.2');
  });

  test('DB-plane models.chat still wins over everything', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    stub.set('models.chat', 'anthropic:claude-opus-4-7');
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('anthropic:claude-opus-4-7');
  });

  test('provider switch: unservable openai pin + anthropic-only key → key-aware default + one warn', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
    expect(stderrCapture).toContain('openai:gpt-5.2');
    expect(stderrCapture).toContain('no usable');
  });

  test('keyless + no pin → tier default (today\'s shape, honest downstream)', async () => {
    writeFileConfig({});
    configureGateway({ env: {} });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
  });

  test('openai-only, no pin → key-aware tier default routes chat to openai', async () => {
    writeFileConfig({ openai_api_key: 'sk-file-plane' });
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(openaiStaticTierFallback().reasoning);
  });
});

describe('expansion-side effective resolution (review-army addition)', () => {
  test('servable expansion_model file pin survives reconnect', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe('openai:gpt-4o-mini');
  });

  test('unservable expansion pin falls to the key-aware utility default + warn', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe(TIER_DEFAULTS.utility);
    expect(stderrCapture).toContain('expansion_model');
  });
});

describe('model_not_found names the setting that selected the model (#5304)', () => {
  const raw404 = (model: string) => Object.assign(new Error(`The model \`${model}\` does not exist or you do not have access to it`), { status: 404 });

  /** Runs the real chat() throw site with a provider that answers 404 (401 when `status` says so). */
  async function chatFailure(model?: string, status = 404): Promise<AIConfigError> {
    __setGenerateTextTransportForTests((async (args: { model: { modelId: string } }) => {
      throw status === 404 ? raw404(args.model.modelId) : Object.assign(new Error('invalid x-api-key'), { status });
    }) as never);
    try {
      await chat({ messages: [{ role: 'user', content: 'hello' }], ...(model ? { model } : {}), allowFallback: false });
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      return err as AIConfigError;
    } finally {
      __setGenerateTextTransportForTests(null);
    }
    throw new Error('chat() resolved; expected a provider failure');
  }

  test('DB tier key: why names models.tier.reasoning, fix points at gbrain models, rendered through the contract', async () => {
    writeFileConfig({});
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    stub.set('models.tier.reasoning', 'anthropic:claude-gone-1');
    await reconfigureGatewayWithEngine(stub as never);
    const err = await chatFailure();
    expect(err.why).toBe('The model was selected by the DB-plane key models.tier.reasoning; gbrain config set models.tier.reasoning <provider>:<model> replaces it.');
    expect(err.fix).toContain('gbrain models');
    const rendered = renderCliError(err, { json: false, command: 'think', tty: false }).stderr ?? '';
    expect(rendered).toContain('Why: The model was selected by the DB-plane key models.tier.reasoning');
    const envelope = JSON.parse(renderCliError(err, { json: true, command: 'think', tty: false }).stdout!);
    expect(envelope.why).toBe(err.why);
  });

  test('a second configure does not rewrite an earlier call\'s explanation', async () => {
    writeFileConfig({});
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    stub.set('models.tier.reasoning', 'anthropic:claude-gone-1');
    await reconfigureGatewayWithEngine(stub as never);
    const before = await chatFailure();
    stub.set('models.chat', 'anthropic:claude-other-2');
    await reconfigureGatewayWithEngine(stub as never);
    // The first call's error keeps its own why; configuration B describes only B's model.
    expect(before.why).toContain('models.tier.reasoning');
    expect((await chatFailure()).why).toContain('DB-plane key models.chat');
    expect((await chatFailure('anthropic:claude-gone-1')).why).toContain('The call named this model itself');
  });

  test('file pin: names the chat_model pin in config.json and the models.chat override, not config set chat_model', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const why = (await chatFailure()).why ?? '';
    expect(why).toContain('the chat_model pin in ~/.gbrain/config.json');
    expect(why).toContain('gbrain config set models.chat <provider>:<model>');
    expect(why).toContain('gbrain config set chat_model writes the DB plane, which does not replace the pin');
  });

  test('env: names the variable, never its value', async () => {
    process.env.GBRAIN_CHAT_MODEL = 'openai:gpt-secret-canary';
    writeFileConfig({});
    configureGateway({ chat_model: 'openai:gpt-secret-canary', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const why = (await chatFailure()).why ?? '';
    expect(why).toContain('the GBRAIN_CHAT_MODEL environment variable');
    expect(why).not.toContain('gpt-secret-canary');
  });

  test('tier default: names the built-in default and the models.chat override', async () => {
    writeFileConfig({});
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect((await chatFailure()).why).toBe('The model is the built-in reasoning-tier default; gbrain config set models.chat <provider>:<model> overrides every other setting.');
  });

  test('a non-404 provider error carries no provenance', async () => {
    writeFileConfig({});
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    stub.set('models.tier.reasoning', 'anthropic:claude-gone-1');
    await reconfigureGatewayWithEngine(stub as never);
    expect((await chatFailure(undefined, 401)).why).toBeUndefined();
  });
});
