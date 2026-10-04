// v0.42.x — Life Chronicle (#2390) config flags.
import type { BrainEngine } from '../engine.ts';
import { CHRONICLE_CONFIG, CHRONICLE_DEFAULTS } from './contract.ts';

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

/**
 * Automatic extraction is ON by default (#5876, the standing default-on rule):
 * one paid judge call per new or changed meeting, conversation or calendar
 * page, bounded by the daily limit, the recency window and the per-page cap.
 * Opt out with `gbrain config set auto_chronicle false`. A value outside the
 * known true/false words reads as off (doctor warns `auto_chronicle_invalid`).
 */
export async function isAutoChronicleEnabled(engine: BrainEngine): Promise<boolean> {
  return autoChronicleSetting(await engine.getConfig(CHRONICLE_CONFIG.enabled)) === 'on';
}

/** How a stored `auto_chronicle` value reads: unset is on; an unknown word is off and invalid. */
export function autoChronicleSetting(raw: string | null | undefined): 'on' | 'off' | 'invalid' {
  if (raw == null) return 'on';
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(v)) return 'on';
  if (FALSE_WORDS.includes(v)) return 'off';
  return 'invalid';
}

export interface ChronicleSettings {
  jobBudgetUsd: number;
  /** The operator set chronicle.job_budget_usd (an unpriced model then refuses instead of running uncapped). */
  explicitBudget: boolean;
  dailyLimit: number;
  recentDays: number;
  settleSeconds: number;
  /** When the automatic path activated on this brain; revisions decided earlier are history. */
  activatedAt: Date | null;
}

function positiveNumber(raw: string | null, fallback: number, integer: boolean): number {
  if (raw == null) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) return fallback;
  return n;
}

/** Numeric knobs; a malformed stored value falls back to its default (doctor warns). */
export async function chronicleSettings(engine: BrainEngine): Promise<ChronicleSettings> {
  const get = (key: string) => engine.getConfig(key).catch(() => null);
  const [budget, limit, recent, settle, activated] = await Promise.all([
    get(CHRONICLE_CONFIG.jobBudgetUsd), get(CHRONICLE_CONFIG.dailyLimit), get(CHRONICLE_CONFIG.recentDays),
    get(CHRONICLE_CONFIG.settleSeconds), get(CHRONICLE_CONFIG.activatedAt),
  ]);
  const jobBudgetUsd = positiveNumber(budget, CHRONICLE_DEFAULTS.jobBudgetUsd, false);
  const activatedAt = activated ? new Date(activated) : null;
  return {
    jobBudgetUsd,
    explicitBudget: budget != null && jobBudgetUsd === Number(budget.trim()),
    dailyLimit: positiveNumber(limit, CHRONICLE_DEFAULTS.dailyLimit, true),
    recentDays: positiveNumber(recent, CHRONICLE_DEFAULTS.recentDays, true),
    settleSeconds: settle != null && settle.trim() === '0' ? 0 : positiveNumber(settle, CHRONICLE_DEFAULTS.settleSeconds, true),
    activatedAt: activatedAt && !Number.isNaN(activatedAt.getTime()) ? activatedAt : null,
  };
}

/** Pinned timezone for the when→date projection cast (plan: default UTC). */
export async function chronicleTz(engine: BrainEngine): Promise<string> {
  const val = await engine.getConfig('chronicle.tz');
  return (val && val.trim()) || 'UTC';
}
