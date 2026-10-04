import type { BrainEngine } from '../engine.ts';
import type { ImportResult, ParsedPage } from '../import-file.ts';

/** Parsing/provider work is complete. apply must run under the coordinator's transaction. */
export interface PreparedContentImport {
  slug: string;
  parsedPage: ParsedPage;
  observedRevision: string | null;
  noop: boolean;
  /** The imported content hash, when apply writes the page (`coordinated` callers verify their read-back against it). */
  contentHash?: string;
  result: ImportResult;
  validate(tx: BrainEngine): Promise<void>;
  apply(tx: BrainEngine): Promise<void>;
}
