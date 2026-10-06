/**
 * `gbrain providers` — pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRecipeTable, formatEnvOutput, envReady, resolveProviderEndpoint, redactBaseUrlForDisplay } from '../src/commands/providers.ts';
import type { DbPlaneRead } from '../src/core/ai/db-plane-config-read.ts';
import { applyOpenAICompatConfig, resolveNativeBaseUrl } from '../src/core/ai/gateway.ts';
import { buildGatewayConfig, COMPAT_BASE_URL_ENVS } from '../src/core/ai/build-gateway-config.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';
import type { Recipe } from '../src/core/ai/types.ts';

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    // Ollama has no auth_env.required.
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ✓ ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    // openai row should be ready
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✓ ready');
  });

  test('shows ✗ missing <ENV> for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    // openai should show missing OPENAI_API_KEY
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('✗ missing OPENAI_API_KEY');
  });

  test('shows keyless Ollama chat as available', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const ollamaLine = out.split('\n').find(line => line.startsWith('ollama'));
    expect(ollamaLine).toBeDefined();
    // Master-skew fixup: on this branch ollama also carries an expansion
    // touchpoint (#4073), so the EXPAND column reads `yes`, not `—`.
    // System One: RERANK and DECIDE columns follow CHAT (ollama declares neither).
    expect(ollamaLine).toMatch(/ollama\s+openai-compat\s+yes\s+yes\s+yes\s+—\s+—\s+✓ ready/);
  });

  test('TypeSafe shows the rerank and decide capabilities and accepts either key name', () => {
    const line = (env: Record<string, string>) => formatRecipeTable(listRecipes(), env).split('\n').find(l => l.startsWith('typesafe '));
    expect(line({})).toMatch(/typesafe\s+openai-compat\s+—\s+—\s+—\s+yes\s+yes\s+✗ missing TYPESAFE_API_KEY/);
    expect(line({ JEV_TYPESAFE_API_KEY: 'k' })).toContain('✓ ready');
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (voyage) shows yes/—/— for tiers', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const voyageLine = out.split('\n').find(line => line.startsWith('voyage'));
    expect(voyageLine).toBeDefined();
    // Voyage has embedding but no expansion or chat
    expect(voyageLine).toContain('yes');
    expect(voyageLine).toContain('—');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const voyage = getRecipe('voyage');
    expect(openai && voyage).toBeTruthy();
    const out = formatRecipeTable([openai!, voyage!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    // header + separator + 2 recipe rows
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('✓ ready');
    expect(lines[3]).toContain('voyage');
    expect(lines[3]).toContain('✗ missing VOYAGE_API_KEY');
  });
});

describe('formatEnvOutput (providers env <id>)', () => {

  test('living provider control: setup funnel intact', () => {
    const voyage = getRecipe('voyage')!;
    const out = formatEnvOutput(voyage, {});
    expect(out).not.toContain('DEPRECATED');
    expect(out).toContain('Setup:');
  });

  test('keyless recipe (ollama): Required: (none) arm renders', () => {
    const ollama = getRecipe('ollama')!;
    const out = formatEnvOutput(ollama, {});
    expect(out).toContain('Required: (none)');
    expect(out).not.toContain('DEPRECATED');
  });

  test('optional-env arm renders when a recipe declares optional vars', () => {
    const fake = {
      id: 'fake-optional',
      name: 'Fake Optional',
      tier: 'native',
      touchpoints: {},
      auth_env: { required: ['FAKE_KEY'], optional: ['FAKE_ORG'], setup_url: 'https://example.com' },
      setup_hint: 'Get a key at example.com.',
    } as unknown as Recipe;
    const out = formatEnvOutput(fake, { FAKE_ORG: 'org-1' });
    expect(out).toContain('Optional:');
    expect(out).toContain('FAKE_ORG');
    expect(out).toContain('✓ set');
    // Living provider keeps its funnel:
    expect(out).toContain('Setup: https://example.com');
    expect(out).toContain('Get a key at example.com.');
  });
});

// ── #5302: resolved base URL with provenance ──────────────────────────────────

const homeRoot = mkdtempSync(join(tmpdir(), 'gbrain-providers-endpoint-'));
afterAll(() => rmSync(homeRoot, { recursive: true, force: true }));
let homeN = 0;

/** Every env var that can steer a base URL, cleared so ambient values never leak in. */
const BASE_URL_ENV_KEYS = [...Object.values(COMPAT_BASE_URL_ENVS), 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'];

function nativeProvider(recipe: Recipe): 'anthropic' | 'openai' | undefined {
  return recipe.id === 'anthropic' || recipe.id === 'openai' ? recipe.id : undefined;
}

/** The URL the gateway's call sites use for `recipe` under `cfg` (native: resolveNativeBaseUrl; compat: applyOpenAICompatConfig). */
function gatewayUrl(recipe: Recipe, cfg: GBrainConfig): string | null {
  const gw = buildGatewayConfig(cfg);
  const native = nativeProvider(recipe);
  if (recipe.tier === 'native') return native ? resolveNativeBaseUrl(native, gw) ?? null : null;
  try { return applyOpenAICompatConfig(recipe, gw).baseURL; } catch { return null; }
}

/** A config-table reader holding the given DB-plane rows. */
function dbReader(rows: Record<string, string>) {
  return {
    getConfig: async (k: string) => rows[k] ?? null,
    listConfigKeys: async (prefix: string) => Object.keys(rows).filter(k => k.startsWith(prefix)),
  };
}

type Plane = 'env' | 'file' | 'db' | 'none';

/** Run `fn` with a temp GBRAIN_HOME holding `file` and only `env` among the base-URL vars. */
async function inBrain<T>(file: GBrainConfig, env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const home = join(homeRoot, `h${homeN++}`);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(file));
  const overrides: Record<string, string | undefined> = { GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined };
  for (const k of BASE_URL_ENV_KEYS) overrides[k] = env[k];
  return withEnv(overrides, fn);
}

describe('providers env base URL parity with the gateway (#5302)', () => {
  const recipes = listRecipes();
  const planes: Plane[] = ['env', 'file', 'db', 'none'];
  const cases = recipes.flatMap(r => planes.map(plane => ({ id: r.id, plane })));

  test.each(cases)('$id × $plane: displayed URL equals the URL the gateway calls', async ({ id, plane }) => {
    const recipe = getRecipe(id)!;
    const url = `https://${plane}.example.invalid/v1`;
    const envKey = COMPAT_BASE_URL_ENVS[id] ?? (nativeProvider(recipe) ? `${id.toUpperCase()}_BASE_URL` : undefined);
    const file: GBrainConfig = { engine: 'pglite', ...(plane === 'file' ? { provider_base_urls: { [id]: url } } : {}) } as GBrainConfig;
    const env = plane === 'env' && envKey ? { [envKey]: url } : {};
    const rows = plane === 'db' ? { [`provider_base_urls.${id}`]: url } : {};
    await inBrain(file, env, async () => {
      const fileCfg = loadConfig();
      const merged = (await loadConfigWithEngine(dbReader(rows), fileCfg))!;
      const db: DbPlaneRead = { read: true, merged };
      const endpoint = resolveProviderEndpoint(recipe, fileCfg, db);
      expect(endpoint.url).toBe(gatewayUrl(recipe, merged));

      const native = recipe.tier === 'native';
      if (plane === 'none') expect(endpoint.source).toBe(native ? 'provider SDK default' : recipe.resolveOpenAICompatConfig ? 'not configured' : 'recipe default');
      if (plane === 'file' && !recipe.resolveOpenAICompatConfig && (!native || nativeProvider(recipe))) {
        expect(endpoint.source).toBe(`provider_base_urls.${id} (file plane)`);
      }
      if (plane === 'env' && envKey && !recipe.resolveOpenAICompatConfig) expect(endpoint.source).toBe(`${envKey} env var`);
      if (plane === 'db' && !native && !recipe.resolveOpenAICompatConfig) expect(endpoint.source).toBe(`provider_base_urls.${id} (db plane)`);
      if (plane === 'db' && native) {
        expect(endpoint.url).toBeNull();
        expect(endpoint.dbPlane).toContain('not used (mount safety');
      }
    });
  });
});

describe('providers env base URL display (#5302)', () => {
  const mistral = () => getRecipe('mistral')!;

  test('the recipe default prints with provenance, the override and the DB-not-read disclosure', async () => {
    await inBrain({ engine: 'pglite' } as GBrainConfig, {}, async () => {
      const endpoint = resolveProviderEndpoint(mistral(), loadConfig(), { read: false, reason: 'no brain configured' });
      const out = formatEnvOutput(mistral(), {}, endpoint);
      expect(out).toContain('Base URL: https://api.mistral.ai/v1  (recipe default)');
      expect(out).toContain('Override: `gbrain config set provider_base_urls.mistral <url>`.');
      expect(out).toContain('DB plane not read (no brain configured)');
      expect(out).toContain('gbrain config get provider_base_urls.mistral');
    });
  });

  test('the override names an env var only when the gateway reads one for the recipe', async () => {
    await inBrain({ engine: 'pglite' } as GBrainConfig, {}, async () => {
      const ollama = resolveProviderEndpoint(getRecipe('ollama')!, loadConfig(), { read: false, reason: 'x' });
      expect(ollama.override).toContain('OLLAMA_BASE_URL');
      expect(resolveProviderEndpoint(mistral(), loadConfig(), { read: false, reason: 'x' }).override).not.toContain('MISTRAL_BASE_URL');
    });
  });

  test('a native provider normalizes /v1 like the gateway and reports a DB-plane value as not used', async () => {
    await inBrain({ engine: 'pglite' } as GBrainConfig, { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' }, async () => {
      const fileCfg = loadConfig();
      const merged = (await loadConfigWithEngine(dbReader({ 'provider_base_urls.anthropic': 'https://db.example.invalid/v1' }), fileCfg))!;
      const endpoint = resolveProviderEndpoint(getRecipe('anthropic')!, fileCfg, { read: true, merged });
      expect(endpoint).toMatchObject({ url: 'https://proxy.example.invalid/v1', source: 'ANTHROPIC_BASE_URL env var' });
      expect(endpoint.dbPlane).toBe('DB-plane provider_base_urls.anthropic https://db.example.invalid/v1: not used (mount safety; native providers read only env and file plane).');
    });
  });

  test('the file plane beats the DB plane for openai-compatible recipes, as at runtime', async () => {
    await inBrain({ engine: 'pglite', provider_base_urls: { mistral: 'https://api.eu.mistral.ai/v1' } } as GBrainConfig, {}, async () => {
      const fileCfg = loadConfig();
      const merged = (await loadConfigWithEngine(dbReader({ 'provider_base_urls.mistral': 'https://db.example.invalid/v1' }), fileCfg))!;
      const endpoint = resolveProviderEndpoint(mistral(), fileCfg, { read: true, merged });
      expect(endpoint).toMatchObject({ url: 'https://api.eu.mistral.ai/v1', source: 'provider_base_urls.mistral (file plane)' });
      expect(endpoint.dbPlane).toBe('DB plane read: provider_base_urls overrides are included.');
    });
  });

  test('displayed URLs never carry userinfo, query or fragment, and an unparseable value prints nothing of itself', async () => {
    const secret = 'https://alice-example:hunter2-secret@api.example.invalid/v1?key=sk-secret#frag-secret';
    expect(redactBaseUrlForDisplay(secret)).toBe('https://api.example.invalid/v1 (userinfo/query/fragment redacted)');
    expect(redactBaseUrlForDisplay('not a url hunter2-secret')).toBe('(invalid URL; value redacted)');
    await inBrain({ engine: 'pglite', provider_base_urls: { mistral: secret } } as GBrainConfig, {}, async () => {
      const out = formatEnvOutput(mistral(), {}, resolveProviderEndpoint(mistral(), loadConfig(), { read: false, reason: 'x' }));
      expect(out).toContain('Base URL: https://api.example.invalid/v1 (userinfo/query/fragment redacted)');
      expect(out).not.toContain('secret');
    });
  });
});
