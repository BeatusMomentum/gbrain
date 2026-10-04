// Life Chronicle (#2390, #5876) config: the auto_chronicle switch and the chronicle.* knobs.
import type { BrainEngine } from '../engine.ts';

export const AUTO_CHRONICLE_KEY = 'auto_chronicle';
/** The one documented opt-out. Unsetting the key restores the default, which is on. */
export const AUTO_CHRONICLE_OPT_OUT_ARGV = ['gbrain', 'config', 'set', 'auto_chronicle', 'false'] as const;
export const AUTO_CHRONICLE_KEEP_ARGV = ['gbrain', 'config', 'set', 'auto_chronicle', 'true'] as const;
/** Stamped by `gbrain config set auto_chronicle <value>`: the operator has seen the default-on change. */
export const CHRONICLE_ACK_KEY = 'chronicle.default_on_acknowledged';
/** Stamped when the one-shot post-upgrade notice prints. */
export const CHRONICLE_NOTICE_SHOWN_KEY = 'chronicle.default_on_notice_shown';
/** Written by the ledger migration: automatic extraction covers revisions decided after it. */
export const CHRONICLE_ACTIVATED_AT_KEY = 'chronicle.activated_at';

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

/**
 * `default`: unset, so on. `explicit`: a recognized true/false word.
 * `invalid`: any other value, read as off (fail closed on spend) and reported by doctor.
 */
export interface AutoChronicleSetting {
  enabled: boolean;
  source: 'default' | 'explicit' | 'invalid';
  raw: string | null;
}

export function parseAutoChronicle(raw: string | null | undefined): AutoChronicleSetting {
  if (raw == null || raw.trim() === '') return { enabled: true, source: 'default', raw: raw ?? null };
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return { enabled: true, source: 'explicit', raw };
  if (FALSE_WORDS.includes(word)) return { enabled: false, source: 'explicit', raw };
  return { enabled: false, source: 'invalid', raw };
}

export async function readAutoChronicle(engine: BrainEngine): Promise<AutoChronicleSetting> {
  return parseAutoChronicle(await engine.getConfig(AUTO_CHRONICLE_KEY));
}

/**
 * Automatic extraction is ON by default (the default-on rule for new features); the opt-out is
 * `gbrain config set auto_chronicle false`. Each eligible new or changed page costs one chat call,
 * bounded by `chronicle.job_budget_usd` per page and `chronicle.auto_daily_limit` per rolling day.
 */
export async function isAutoChronicleEnabled(engine: BrainEngine): Promise<boolean> {
  return (await readAutoChronicle(engine)).enabled;
}

/**
 * True while the operator has not answered the default-on change: the feature is on and nobody ran
 * `gbrain config set auto_chronicle ...` since this release (an explicit `true` written before it
 * was a no-op, so it does not count as an answer).
 */
export async function autoChronicleNeedsAcknowledgement(engine: BrainEngine): Promise<boolean> {
  const setting = await readAutoChronicle(engine);
  if (!setting.enabled) return false;
  const ack = await engine.getConfig(CHRONICLE_ACK_KEY);
  return ack == null || ack.trim() === '';
}

interface NumericKeySpec {
  fallback: number;
  min: number;
  max: number;
  integer: boolean;
  meaning: string;
}

export const CHRONICLE_NUMERIC_KEYS = {
  'chronicle.job_budget_usd': { fallback: 0.25, min: 0.01, max: 10, integer: false,
    meaning: 'USD cap for one page extraction (a per-call cap, not a daily budget)' },
  'chronicle.auto_daily_limit': { fallback: 200, min: 1, max: 10_000, integer: true,
    meaning: 'automatic extraction calls per rolling 24 hours; to stop them, set auto_chronicle false' },
  'chronicle.auto_recent_days': { fallback: 30, min: 1, max: 3650, integer: true,
    meaning: 'days back a page date may be for automatic extraction; older pages are left to chronicle-backfill' },
  'chronicle.auto_settle_seconds': { fallback: 180, min: 0, max: 86_400, integer: true,
    meaning: 'seconds a page must stay unchanged before automatic extraction' },
  'chronicle.judge_max_tokens': { fallback: 4000, min: 1, max: 128_000, integer: true,
    meaning: 'output-token cap for one extraction call' },
} as const satisfies Record<string, NumericKeySpec>;

export type ChronicleNumericKey = keyof typeof CHRONICLE_NUMERIC_KEYS;

/** Every chronicle.* key gbrain reads or writes. `config set` refuses other chronicle.* leaves. */
export const CHRONICLE_CONFIG_KEYS: readonly string[] = [
  ...Object.keys(CHRONICLE_NUMERIC_KEYS),
  'chronicle.tz',
  CHRONICLE_ACTIVATED_AT_KEY,
  CHRONICLE_ACK_KEY,
  CHRONICLE_NOTICE_SHOWN_KEY,
];

function describeRange(key: ChronicleNumericKey): string {
  const spec: NumericKeySpec = CHRONICLE_NUMERIC_KEYS[key];
  return `${spec.integer ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max} (${spec.meaning}; default ${spec.fallback})`;
}

function parseNumeric(key: ChronicleNumericKey, raw: string): number | null {
  const spec: NumericKeySpec = CHRONICLE_NUMERIC_KEYS[key];
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (spec.integer && !Number.isInteger(n)) return null;
  return n >= spec.min && n <= spec.max ? n : null;
}

/** `config set` validation for auto_chronicle and chronicle.*; returns the refusal text or null. */
export function validateChronicleConfigValue(key: string, value: string): string | null {
  if (key === AUTO_CHRONICLE_KEY) {
    return parseAutoChronicle(value).source === 'explicit' ? null
      : `auto_chronicle must be true or false (got '${value}'). Nothing was written. ` +
        'To turn automatic event extraction off: gbrain config set auto_chronicle false';
  }
  if (key in CHRONICLE_NUMERIC_KEYS) {
    const k = key as ChronicleNumericKey;
    return parseNumeric(k, value) === null ? `${key} must be ${describeRange(k)} (got '${value}'). Nothing was written.` : null;
  }
  return null;
}

export interface ChronicleSettings {
  jobBudgetUsd: number;
  /** True when the operator set the cap: an unpriced model then refuses with no_pricing instead of warn-and-run. */
  jobBudgetExplicit: boolean;
  autoDailyLimit: number;
  autoRecentDays: number;
  autoSettleSeconds: number;
  judgeMaxTokens: number;
  /** Stored values outside the valid range; each fell back to its default. */
  invalid: Array<{ key: ChronicleNumericKey; raw: string; fallback: number }>;
}

/** Reads every chronicle.* knob; a malformed or unreadable row falls back to its default. */
export async function readChronicleSettings(engine: BrainEngine): Promise<ChronicleSettings> {
  const invalid: ChronicleSettings['invalid'] = [];
  const values = {} as Record<ChronicleNumericKey, number>;
  let budgetExplicit = false;
  for (const key of Object.keys(CHRONICLE_NUMERIC_KEYS) as ChronicleNumericKey[]) {
    const fallback = CHRONICLE_NUMERIC_KEYS[key].fallback;
    const raw = await engine.getConfig(key).catch(() => null);
    if (raw == null || raw.trim() === '') { values[key] = fallback; continue; }
    const parsed = parseNumeric(key, raw);
    if (parsed === null) { invalid.push({ key, raw, fallback }); values[key] = fallback; continue; }
    values[key] = parsed;
    if (key === 'chronicle.job_budget_usd') budgetExplicit = true;
  }
  return {
    jobBudgetUsd: values['chronicle.job_budget_usd'],
    jobBudgetExplicit: budgetExplicit,
    autoDailyLimit: values['chronicle.auto_daily_limit'],
    autoRecentDays: values['chronicle.auto_recent_days'],
    autoSettleSeconds: values['chronicle.auto_settle_seconds'],
    judgeMaxTokens: values['chronicle.judge_max_tokens'],
    invalid,
  };
}

/** Pinned timezone for the when→date projection cast (plan: default UTC). */
export async function chronicleTz(engine: BrainEngine): Promise<string> {
  const val = await engine.getConfig('chronicle.tz');
  return (val && val.trim()) || 'UTC';
}
