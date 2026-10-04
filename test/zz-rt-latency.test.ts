import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

test('managed catch-up over injected latency', async () => {
  const N = Number(process.env.RT_PAGES ?? 30);
  const home = mkdtempSync(join(tmpdir(), 'rtl-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
    const id = `rt-${randomUUID().slice(0, 8)}`; const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q');
    for (let i = 0; i < N; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nObservation ${i} about [[notes/n${(i + 1) % N}]].\n`);
    git('add', '.'); git('-c', 'user.name=E', '-c', 'user.email=e@example.invalid', 'commit', '-qm', 'x');
    await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await pg.engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(pg.engine, id, root);
    await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await disposePersistenceConsumer(pg.engine);
    const url = new URL(pg.databaseUrl); url.port = process.env.RT_PROXY_PORT ?? '6666';
    const engine = new PostgresEngine(); await engine.connect({ database_url: url.toString(), poolSize: 4 });
    const t0 = performance.now();
    const r = await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true });
    const ms = performance.now() - t0;
    const line = `${process.env.RT_LABEL ?? ''} pages=${N} status=${r.status} wall_ms=${Math.round(ms)} per_page_ms=${Math.round(ms / N)} pages_per_min=${(N / (ms / 60000)).toFixed(1)}`;
    console.log(line); appendFileSync(process.env.RT_OUT!, line + '\n');
    const reqs = await pg.engine.executeRaw<any>(`SELECT intent->>'kind' AS kind, slug, extract(epoch from created_at)*1000 AS c, extract(epoch from published_at)*1000 AS p, extract(epoch from completed_at)*1000 AS d, state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [id]);
    let prev = 0; for (const q of reqs) { console.log(`${q.kind} ${q.slug} admit_gap=${prev ? Math.round(q.c - prev) : 0} admit_to_done=${Math.round(q.d - q.c)} ${q.state}`); prev = q.d; }
    await disposePersistenceConsumer(engine); await engine.disconnect(); await pg.close();
    expect(r.drain?.outcome).toBe('synced');
  });
}, 1_800_000);
