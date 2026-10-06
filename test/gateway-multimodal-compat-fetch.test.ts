/**
 * The openai-compatible multimodal embedding path honors the recipe's compat
 * fetch (#5990), as the text-embedding and chat paths already do.
 *
 * embedMultimodalOpenAICompat called the global fetch directly, so a recipe
 * whose multimodal wire shape needs translating (its compat.fetch rewrites the
 * request) never reached its translator and the provider rejected the body.
 * The tests install a compat fetch on the shared LiteLLM recipe (the
 * openai-compatible multimodal recipe in the registry) for the duration of
 * each test and drive the real gateway entry point, embedMultimodal().
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embedMultimodal, resetGateway } from '../src/core/ai/gateway.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import type { Recipe } from '../src/core/ai/types.ts';

const recipe = getRecipe('litellm') as Recipe;
const originalCompat = recipe.compat;
const origFetch = globalThis.fetch;
let globalCalls = 0;

type Call = { url: string; init: RequestInit };

function embeddingResponse(status = 200): Response {
  const body = status === 200 ? { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] } : { error: { message: 'nope' } };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installCompat(status = 200): Call[] {
  const calls: Call[] = [];
  (recipe as { compat?: Recipe['compat'] }).compat = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return embeddingResponse(status);
    }) as typeof fetch,
  };
  return calls;
}

beforeEach(() => {
  globalCalls = 0;
  globalThis.fetch = (async () => { globalCalls++; return embeddingResponse(); }) as unknown as typeof fetch;
  configureGateway({
    embedding_model: 'litellm:vl-embed',
    embedding_dimensions: 4,
    base_urls: { litellm: 'http://localhost:4000/v1' },
    env: { LITELLM_API_KEY: 'sk-litellm-test' },
  });
});

afterEach(() => {
  (recipe as { compat?: Recipe['compat'] }).compat = originalCompat;
  globalThis.fetch = origFetch;
  resetGateway();
});

const image = { kind: 'image_base64' as const, data: Buffer.from('img').toString('base64'), mime: 'image/png' };

describe('embedMultimodal on an openai-compatible recipe', () => {
  test('sends each request through the recipe compat fetch, with headers, timeout signal and body intact', async () => {
    const calls = installCompat();
    const vecs = await embedMultimodal([image, { kind: 'text', text: 'caption' }]);
    expect(vecs.map(v => Array.from(v).map(x => Number(x.toFixed(1))))).toEqual([[0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4]]);
    expect(globalCalls).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toBe('http://localhost:4000/v1/embeddings');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer sk-litellm-test');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe('vl-embed');
    expect(body.input[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } });
  });

  test('falls back to the global fetch when the recipe has no compat fetch', async () => {
    (recipe as { compat?: Recipe['compat'] }).compat = undefined;
    await embedMultimodal([{ kind: 'text', text: 'caption' }]);
    expect(globalCalls).toBe(1);
  });

  test('compat fetch responses keep the existing error classification', async () => {
    installCompat(401);
    await expect(embedMultimodal([image])).rejects.toBeInstanceOf(AIConfigError);
    installCompat(503);
    await expect(embedMultimodal([image])).rejects.toBeInstanceOf(AITransientError);
    expect(globalCalls).toBe(0);
  });
});
