/**
 * Capability readiness (agent operator contract v1, A7): one place that says
 * what this install can do, why not, and the fix. Two tiers:
 *
 * - config plane (`configReadiness`): synchronous, memoized, in-memory config
 *   only; the one file read allowed is a memoized `peekLock()` for lock_owner.
 *   Used by MCP initialize, whoami and write receipts.
 * - probed tier (`probedReadiness`): worker, backup, migrations; bounded,
 *   cached, never `getStats`/`getHealth`. Used by doctor and
 *   `gbrain://capabilities`.
 */
import type { GBrainConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import type { Action, Transport } from './agent-output.ts';

export type ReadinessState = 'ok' | 'disabled_by_choice' | 'not_applicable' | 'missing' | 'degraded' | 'unknown';
export type CapabilityId =
  | 'embeddings' | 'chat_llm' | 'worker' | 'writeback' | 'backup' | 'tool_surface'
  | 'sync' | 'migrations' | 'harness_wiring';

export interface ReadinessEntry {
  capability: CapabilityId;
  state: ReadinessState;
  /** Closed vocabulary per capability. */
  reason: string;
  why: string;
  fix?: Action;
  tier: 'config' | 'probed';
  /** backup: which asset. */
  asset?: string;
  /** false → stripped from the HTTP view. */
  http_visible: boolean;
}

export interface LockOwner { pid: number; transport: 'stdio' | 'http'; started_at?: string; is_self: boolean }
export interface ConfigReadiness { entries: ReadinessEntry[]; lock_owner: LockOwner | null }

/** Probe cache for the probed tier (process-wide on stdio/CLI; one per ServeHttpContext on HTTP). */
export interface ReadinessCache {
  get(key: string): { at: number; value: ReadinessEntry[] } | undefined;
  set(key: string, value: { at: number; value: ReadinessEntry[] }): void;
}

export function configReadiness(cfg: GBrainConfig, ctx: { transport: Transport }): ConfigReadiness {
  void cfg; void ctx;
  return { entries: [], lock_owner: null };
}

export async function probedReadiness(engine: BrainEngine, opts: { cache?: ReadinessCache } = {}): Promise<ReadinessEntry[]> {
  void engine; void opts;
  return [];
}

export function embeddingEnablement(cfg: GBrainConfig): Action {
  void cfg;
  return {
    argv: ['gbrain', 'doctor', '--json'],
    consent: [],
    actor: 'agent',
    why: 'Embeddings are not configured on this brain.',
    requires_exclusive: false,
  };
}
