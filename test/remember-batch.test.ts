import { describe, expect, test } from 'bun:test';
import { childRequestId, runRememberBatch, REMEMBER_BATCH_MAX } from '../src/core/remember-batch.ts';
import { OperationError, verbError } from '../src/core/ops/contract.ts';
import type { OperationContext } from '../src/core/operations.ts';

const ctx = { remote: false } as unknown as OperationContext;
const ve = (code: string, message: string, suggestion: string) => verbError(code as never, message, suggestion);

function fakeSingle(opts: { failWrite?: (p: Record<string, unknown>) => boolean } = {}) {
  const writes: Record<string, unknown>[] = [];
  const handler = async (c: OperationContext, p: Record<string, unknown>) => {
    if (typeof p.fact !== 'string' || !p.fact) throw ve('invalid_params', 'fact must be a non-empty string.', 'x');
    if (typeof p.provenance !== 'string' || !p.provenance) throw ve('provenance_required', 'provenance is required.', 'x');
    if (c.dryRun) return { dry_run: true };
    if (opts.failWrite?.(p)) throw ve('internal_error', 'boom', 'x');
    writes.push(p);
    return { status: 'saved', id: writes.length };
  };
  return { handler, writes };
}

describe('remember items[] batch', () => {
  test('child request ids are deterministic UUIDs, distinct per index', () => {
    const a = childRequestId('11111111-1111-4111-8111-111111111111', 0);
    expect(a).toBe(childRequestId('11111111-1111-4111-8111-111111111111', 0));
    expect(a).not.toBe(childRequestId('11111111-1111-4111-8111-111111111111', 1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('saves each item with shared provenance and child request ids', async () => {
    const { handler, writes } = fakeSingle();
    const out = await runRememberBatch(ctx, { request_id: 'r1', provenance: 'session', items: [{ fact: 'a' }, { fact: 'b', provenance: 'own' }] }, handler, ve);
    expect(out.saved).toBe(2);
    expect(out.partial).toBe(false);
    expect(writes.map(w => w.provenance)).toEqual(['session', 'own']);
    expect(writes[0].request_id).toBe(childRequestId('r1', 0));
    expect(writes[1].request_id).toBe(childRequestId('r1', 1));
  });

  test('one invalid item refuses the whole batch before any write', async () => {
    const { handler, writes } = fakeSingle();
    let err: unknown;
    try { await runRememberBatch(ctx, { provenance: 'p', items: [{ fact: 'ok' }, { fact: '' }] }, handler, ve); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OperationError);
    expect((err as Error).message).toContain('items[1]');
    expect(writes).toHaveLength(0);
  });

  test('per-item publication failure reports partial with the item error', async () => {
    const { handler, writes } = fakeSingle({ failWrite: p => p.fact === 'bad' });
    const out = await runRememberBatch(ctx, { provenance: 'p', items: [{ fact: 'ok' }, { fact: 'bad' }] }, handler, ve) as { items: { status: string }[]; partial: boolean; next?: string };
    expect(writes).toHaveLength(1);
    expect(out.partial).toBe(true);
    expect(out.items[1].status).toBe('failed');
    expect(out.next).toContain('new request_id');
  });

  test('rejects empty, oversized, unknown-field and fact+items calls', async () => {
    const { handler } = fakeSingle();
    const tooMany = Array.from({ length: REMEMBER_BATCH_MAX + 1 }, (_, i) => ({ fact: String(i) }));
    for (const p of [{ items: [] }, { items: tooMany }, { items: [{ fact: 'a', slug: 'x' }] }, { fact: 'x', items: [{ fact: 'a' }] }]) {
      await expect(runRememberBatch(ctx, { provenance: 'p', ...p }, handler, ve)).rejects.toBeInstanceOf(OperationError);
    }
  });
});
