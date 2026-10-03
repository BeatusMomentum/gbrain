/**
 * A1 explicit routing for every CLI fix (docs/designs/AGENT_OPERATOR_WAVE.md,
 * DX-7): a rendered `fix.argv` names the brain and source the failing call
 * acted on, so the agent can run it later from another directory or under a
 * different GBRAIN_BRAIN_ID / GBRAIN_SOURCE / .gbrain-mount / .gbrain-source
 * and still act on the intended brain.
 *
 * The pin is applied once, at render time (`renderAction`), to every gbrain
 * argv in the action (`argv`, `preview_argv`, `verify.argv`, `then`):
 *
 * - `--brain <id>` is appended for commands that route through the brain axis:
 *   every shared op, every CLI-only command that opens its engine through the
 *   connect terminator (phase other than `pre-connect`), and pre-connect
 *   commands whose own code reads the global brain option
 *   (CLI_ROUTING_FLAG_CONSUMERS, generated).
 * - `--source <id>` is appended for commands whose target source resolves
 *   through the ambient chain: every shared op (makeContext's resolver; ops
 *   that own a `source` param are excluded) and CLI-only commands that declare
 *   `routes_source` in the command table (each one consumes `--source` per the
 *   generated registry; test/fix-routing.test.ts pins that).
 *
 * Flags already present are kept as written; the pin goes before a bare `--`
 * so it can never land in the positional lane.
 */
import { CLI_COMMANDS, type CliCommandRecord } from '../cli/command-table.ts';
import { CLI_FLAG_REGISTRY, CLI_ROUTING_FLAG_CONSUMERS } from './cli-flag-registry.generated.ts';
import { ALL_SOURCES, SOURCE_ID_RE } from './source-id.ts';

export interface FixRouting { brain?: string; source?: string }

const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const pinnableSource = (s: string) => SOURCE_ID_RE.test(s) || s === ALL_SOURCES;
const SOURCE_SELECTORS = ['--source', '--source-id', '--all-sources', '--sources'];

let cliRecords: Map<string, CliCommandRecord> | null = null;
const opCommands = new Map<string, { ownsSource: boolean }>();

/** Shared-op CLI names (primary + aliases) and whether the op owns a `source` param (then --source is not routing). */
export function registerOpRoutes(entries: Iterable<readonly [cliName: string, ownsSource: boolean]>): void {
  for (const [name, ownsSource] of entries) opCommands.set(name, { ownsSource });
}

function record(command: string): CliCommandRecord | undefined {
  cliRecords ??= new Map(CLI_COMMANDS.map(r => [r.name, r]));
  return cliRecords.get(command);
}

/** The routing flags a command accepts AND routes through (see the module comment). */
export function routingFlagsFor(command: string): { brain: boolean; source: boolean } {
  const rec = record(command);
  if (rec) {
    const accepted = CLI_FLAG_REGISTRY[command] ?? [];
    const consumed = CLI_ROUTING_FLAG_CONSUMERS[command] ?? [];
    return {
      brain: accepted.includes('--brain') && (rec.phase !== 'pre-connect' || consumed.includes('--brain')),
      source: accepted.includes('--source') && rec.routes_source === true,
    };
  }
  const op = opCommands.get(command);
  return op ? { brain: true, source: !op.ownsSource } : { brain: false, source: false };
}

const hasFlag = (head: readonly string[], flag: string) => head.some(a => a === flag || a.startsWith(`${flag}=`));

/** Append the missing routing flags to one gbrain argv (before a bare `--`). Non-gbrain argv pass through. */
export function pinRouting(argv: readonly string[], routing: FixRouting | undefined): string[] {
  if (!routing || argv[0] !== 'gbrain' || argv.length < 2) return [...argv];
  const flags = routingFlagsFor(argv[1]!);
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  const add: string[] = [];
  if (flags.brain && routing.brain && BRAIN_ID_RE.test(routing.brain) && !hasFlag(head, '--brain')) add.push('--brain', routing.brain);
  if (flags.source && routing.source && pinnableSource(routing.source) && !SOURCE_SELECTORS.some(f => hasFlag(head, f))) {
    add.push('--source', routing.source);
  }
  if (add.length === 0) return [...argv];
  return end === -1 ? [...argv, ...add] : [...argv.slice(0, end), ...add, ...argv.slice(end)];
}

// ── the CLI process's resolved routing ─────────────────────────────────────

let cliProvider: (() => FixRouting | undefined) | null = null;
let resolvedSource: string | undefined;
let recording = false;

/**
 * Installed by src/cli.ts once global flags are parsed: the default routing
 * for every CLI-surface render in this process (cliRenderContext). Also turns
 * on source recording, so the first source this invocation resolves through
 * the ambient chain becomes the pinned source.
 */
export function installCliRouting(provider: () => FixRouting | undefined): void {
  cliProvider = provider;
  recording = true;
}

/** Called by the source resolver: the first source an invocation resolves is the one its fixes pin. */
export function noteResolvedSource(sourceId: string): void {
  if (recording && resolvedSource === undefined && pinnableSource(sourceId)) resolvedSource = sourceId;
}

export function recordedSource(): string | undefined {
  return resolvedSource;
}

export function cliRouting(): FixRouting | undefined {
  try { return cliProvider?.(); } catch { return undefined; }
}

/** Test seam: drop the provider and the recorded source. */
export function __resetCliRoutingForTests(): void {
  cliProvider = null;
  resolvedSource = undefined;
  recording = false;
}
