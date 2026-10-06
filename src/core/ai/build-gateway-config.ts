import type { GBrainConfig } from '../config.ts';
import { loadConfig } from '../config.ts';
import type { AIGatewayConfig } from './types.ts';
import { mergedProviderEnv } from './provider-env.ts';

/**
 * #3350: fold FILE-plane `provider_base_urls.{anthropic,openai}` into the
 * gateway env as `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, same shape as the
 * credential folds (env wins for keys carrying a real value). Native
 * providers read their base URL exclusively from env via
 * `resolveNativeBaseUrl` (which also normalizes the `/v1` suffix), so before
 * this fold a config.json `provider_base_urls.anthropic` was silently ignored
 * by native chat/embed calls.
 *
 * MOUNT SAFETY (gateway.ts `reconfigureGatewayWithEngine` rationale): the
 * fold takes the FILE config explicitly — never a DB-merged config — so
 * DB-plane `provider_base_urls.*` (which can be merged from a shared brain)
 * can never steer this process's native bearer keys to an attacker URL.
 * `buildGatewayConfig` therefore re-reads `loadConfig()` for this fold even
 * when its caller passed a DB-merged config.
 *
 * @internal exported for tests + gateway's file-plane env refresh.
 */
export function foldNativeBaseUrlsFromFilePlane(
  fileCfg: Pick<GBrainConfig, 'provider_base_urls'> | null,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const urls = fileCfg?.provider_base_urls;
  if (!urls) return env;
  const out = { ...env };
  for (const [provider, envKey] of [
    ['anthropic', 'ANTHROPIC_BASE_URL'],
    ['openai', 'OPENAI_BASE_URL'],
  ] as const) {
    const fileUrl = urls[provider];
    // Env wins: only fold when the env carries no real value.
    if (fileUrl && fileUrl.trim() && !(out[envKey] && out[envKey]!.trim())) {
      out[envKey] = fileUrl.trim();
    }
  }
  return out;
}

/**
 * Openai-compatible recipes whose `*_BASE_URL` env var buildGatewayConfig
 * threads into `base_urls` (config values win). v0.32 codex finding #4+#5:
 * without this, `LLAMA_SERVER_BASE_URL=http://localhost:9000` let the probe
 * reach :9000 while embed calls still went to the recipe default. The
 * reranker sibling has its own var because llama-server's --reranking and
 * --embeddings modes run as separate processes. `providers env` reads the
 * same table to name the env var it reports.
 */
export const COMPAT_BASE_URL_ENVS: Readonly<Record<string, string>> = {
  'llama-server': 'LLAMA_SERVER_BASE_URL',
  'llama-server-reranker': 'LLAMA_SERVER_RERANKER_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  lmstudio: 'LMSTUDIO_BASE_URL',
  litellm: 'LITELLM_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
};

export function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  // The file-plane key fold + env merge live in mergedProviderEnv
  // (src/core/ai/provider-env.ts) — the single canonical mapping shared with
  // detectCapabilities and the key-aware model resolution. Config keys are a
  // fallback for daemons / launchd-spawned subprocesses that don't propagate
  // ~/.zshrc-sourced keys; process env wins for keys carrying a real value.

  // Local-server *_BASE_URL env vars (COMPAT_BASE_URL_ENVS) feed base_urls;
  // caller-provided cfg.provider_base_urls wins.
  const envBaseUrls: Record<string, string> = {};
  for (const [recipeId, envKey] of Object.entries(COMPAT_BASE_URL_ENVS)) {
    const value = process.env[envKey];
    if (value) envBaseUrls[recipeId] = value;
  }

  // #3350: native base-URL fold — MUST read the file plane directly, not `c`
  // (callers can pass a DB-merged config; see foldNativeBaseUrlsFromFilePlane's
  // mount-safety note). Fail-open: an unreadable config folds nothing.
  let fileCfg: GBrainConfig | null = null;
  try {
    fileCfg = loadConfig();
  } catch {
    fileCfg = null;
  }

  return {
    embedding_model: c.embedding_model,
    embedding_identity_unverified: !c.embedding_model?.trim(),
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    embedding_image_ocr_model: c.embedding_image_ocr_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    chat_fallback_on_refusal: c.chat_fallback_on_refusal,
    base_urls: { ...envBaseUrls, ...(c.provider_base_urls ?? {}) }, // config wins over env
    provider_chat_options: c.provider_chat_options,
    // #1249 empty-string drop + GEMINI alias applied inside mergedProviderEnv.
    // #3350 file-plane native base-URL fold layered on top (env wins).
    env: foldNativeBaseUrlsFromFilePlane(fileCfg, mergedProviderEnv(c, process.env)),
  };
}
