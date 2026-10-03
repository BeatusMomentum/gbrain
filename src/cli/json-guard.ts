/**
 * Agent contract v1 (D2): which `--json` guard mode this invocation runs
 * under. The guard is on only for commands whose command-table record
 * declares `json` (they write their result through writeStdoutFinal /
 * writeNdjsonLine), so undeclared commands keep their current stdout.
 * Also wires the E11 `json_document_missing` record for the exit-0 bug case.
 */
import { jsonRequested, setJsonDocumentMissingHook } from '../core/cli-force-exit.ts';
import { recordAgentContractEvent } from '../core/agent-contract-log.ts';
import { findCliCommand } from './command-table.ts';

export function agentJsonGuardMode(argv: readonly string[]): { json?: 'document' | 'ndjson' } {
  const command = argv.find(a => !a.startsWith('-') && findCliCommand(a) !== undefined);
  const json = command ? findCliCommand(command)?.json : undefined;
  if (!json || !jsonRequested(argv)) return {};
  setJsonDocumentMissingHook(() => recordAgentContractEvent({ transport: 'cli', command, code: 'json_document_missing', outcome: 'committed' }));
  return { json };
}
