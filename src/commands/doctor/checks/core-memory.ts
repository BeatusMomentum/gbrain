/**
 * core_memory: always-loaded core memory health (docs/guides/core-memory.md).
 * Warns when core is over its brain-wide budget (owner git edits may push it
 * there), when a stored core/pressure setting is out of range (the readers
 * fall back to the default), when the delivery sensitivity policy withholds a
 * core page, when remote edits wait for review, and when core pages exist but
 * no session-start delivered them in the last week.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import {
  CORE_CONFIG_KEYS, CORE_DOCS, coreUsage, loadCoreBlock, pendingCoreNotices, readCoreSettings, validateCoreConfigValue,
} from '../../../core/core-memory.ts';
import { PRESSURE_CONFIG_KEYS, validatePressureConfigValue } from '../../../core/context/pressure.ts';
import { readHeartbeatTail } from '../../../core/context/hook-heartbeat.ts';

const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function coreMemoryCheck(engine: BrainEngine): Promise<Omit<Check, 'name'>> {
  const settings = await readCoreSettings(engine);
  const usage = await coreUsage(engine);
  const problems: string[] = [];
  const badConfig: string[] = [];
  for (const key of [...Object.values(CORE_CONFIG_KEYS), ...Object.values(PRESSURE_CONFIG_KEYS)]) {
    const value = await engine.getConfig(key).catch(() => null);
    if (value == null) continue;
    const problem = validateCoreConfigValue(key, value) ?? validatePressureConfigValue(key, value);
    if (problem) badConfig.push(`${key}=${value} is ignored (${problem})`);
  }
  if (usage.pages.length === 0) {
    return {
      status: badConfig.length ? 'warn' : 'ok',
      message: badConfig.length ? `No core pages. ${badConfig.join('; ')}.` : 'No core pages. Start one with gbrain core init, then fill it in with the user.',
      details: { pages: 0, chars_used: 0, chars_limit: settings.maxChars, enabled: settings.enabled, bad_config: badConfig, docs: CORE_DOCS },
    };
  }
  const block = await loadCoreBlock(engine, { excludePrivate: true, settings });
  const withheld = block.omitted.filter(o => o.reason === 'withheld');
  const notices = await pendingCoreNotices(engine);
  const over = usage.chars - settings.maxChars;
  const largest = [...usage.pages].sort((a, b) => b.chars - a.chars)[0]!;
  if (over > 0) problems.push(`core is ${usage.chars} chars, over the ${settings.maxChars}-char budget by ${over}, so sessions get a truncated block; shorten the largest page (${largest.source_id}:${largest.slug}, ${largest.chars} chars) or raise memory.core.max_chars`);
  problems.push(...badConfig);
  if (withheld.length) problems.push(`${withheld.length} core page(s) withheld from delivery for sensitive content: ${withheld.map(w => `${w.source_id}:${w.slug}`).join(', ')}`);
  if (notices.length) problems.push(`${notices.length} remote edit(s) to core pages await the user's review (gbrain core diff, then gbrain core ack)`);
  let delivered: boolean | null = null;
  if (settings.enabled) {
    try {
      const cutoff = Date.now() - DELIVERY_WINDOW_MS;
      const tail = await readHeartbeatTail(2000);
      delivered = tail.some(e => e.event === 'session-start' && typeof e.core_chars === 'number' && Date.parse(e.ts) >= cutoff);
      // Only hook-wired installs write heartbeats; with none at all, delivery is unknown rather than missing.
      if (!tail.some(e => e.event === 'session-start' && Date.parse(e.ts) >= cutoff)) delivered = null;
    } catch { delivered = null; }
    if (delivered === false) problems.push('session-start hooks ran this week but none delivered core; restart the gbrain MCP server so the hook gets the core-aware serve');
  }
  const details = {
    enabled: settings.enabled, pages: usage.pages.length, chars_used: usage.chars, chars_limit: settings.maxChars, remote_edit: settings.remoteEdit,
    revision: block.revision, withheld, pending_notices: notices.length, delivered_last_7d: delivered, bad_config: badConfig, docs: CORE_DOCS,
  };
  if (!problems.length) {
    return { status: 'ok', message: `Core memory ${settings.enabled ? 'on' : 'off'}: ${usage.pages.length} page(s), ${usage.chars}/${settings.maxChars} chars.`, details };
  }
  return {
    status: 'warn', details,
    message: `Core memory: ${problems.join('; ')}.`,
    fix: agentFix(['gbrain', 'core', 'status', '--json'], 'Shows core usage, withheld pages and pending remote edits, read-only.', 'core_memory'),
  };
}

async function runCoreMemory(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('core_memory');
  try {
    checks.push({ name: 'core_memory', ...await coreMemoryCheck(engine) });
  } catch (err) {
    checks.push({ name: 'core_memory', status: 'warn', message: `Core memory could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const coreMemoryEntry: DoctorEntry = { name: 'core_memory', emits: ['core_memory'], run: runCoreMemory };
