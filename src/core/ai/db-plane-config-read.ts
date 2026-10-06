/**
 * Best-effort DB-plane config read for engine-free diagnostics (`gbrain
 * providers env`, #5302). Opens the configured brain only when that cannot
 * wait on another process (a held PGLite lock is reported, not waited out),
 * skips thin clients (the remote brain owns its DB plane), merges with
 * loadConfigWithEngine exactly as connectEngine does, and always disconnects.
 */
import { isThinClient, loadConfigWithEngine, toEngineConfig, type GBrainConfig } from '../config.ts';

/** The runtime-merged config, or why the DB plane was not read. */
export type DbPlaneRead = { read: true; merged: GBrainConfig } | { read: false; reason: string };

export async function readDbPlaneConfig(fileCfg: GBrainConfig | null): Promise<DbPlaneRead> {
  if (!fileCfg) return { read: false, reason: 'no brain configured' };
  if (isThinClient(fileCfg)) return { read: false, reason: 'thin client; the remote brain owns its DB plane' };
  if (fileCfg.engine === 'pglite') {
    const { peekLock } = await import('../pglite-lock.ts');
    if (peekLock(fileCfg.database_path).held) return { read: false, reason: 'the brain is in use by another gbrain process' };
  }
  try {
    const { createEngine } = await import('../engine-factory.ts');
    const engineCfg = toEngineConfig(fileCfg);
    const engine = await createEngine(engineCfg);
    await engine.connect(engineCfg);
    try {
      const merged = await loadConfigWithEngine(engine, fileCfg);
      return merged ? { read: true, merged } : { read: false, reason: 'the brain returned no config' };
    } finally {
      await engine.disconnect().catch(() => {});
    }
  } catch {
    return { read: false, reason: 'the brain could not be opened' };
  }
}
