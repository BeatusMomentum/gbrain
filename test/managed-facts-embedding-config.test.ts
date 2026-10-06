import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { toAgentError } from '../src/core/agent-output.ts';
import { resolveManagedFactsEmbedding } from '../src/core/persistence/facts-maintenance.ts';

// Protects: the facts-embedding refusal names which DB-plane key failed and
// the values it read, in `why`, while code, message, suggestion and fix stay
// stable. Fails when: the diagnostic is dropped, moved into `message`, or
// echoes an unbounded value. Existing managed-facts tests use valid DB config
// and never reach this refusal. No production seam: the resolver only reads
// rows through executeRaw.
const runtimeConfig: GBrainConfig = {
  engine: 'pglite', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
};
const MESSAGE = 'The selected brain has no verifiable facts embedding model and dimensions.';

function configEngine(values: Record<string, string>): BrainEngine {
  return { executeRaw: async () => Object.entries(values).map(([key, value]) => ({ key, value })) } as unknown as BrainEngine;
}

async function refusal(values: Record<string, string>): Promise<OperationError> {
  const error = await resolveManagedFactsEmbedding(configEngine(values), runtimeConfig).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
}

test.each([undefined, ''])('unset/empty DB model (%j) still disables facts embedding', async model => {
  const values: Record<string, string> = model === undefined ? {} : { embedding_model: model };
  expect(await resolveManagedFactsEmbedding(configEngine(values), runtimeConfig)).toBeNull();
});

const cases = [
  { label: 'unset dimensions', model: 'openai:text-embedding-3-small', dim: undefined, invalid: 'embedding_dimensions' },
  { label: 'malformed model', model: 'text-embedding-3-small', dim: '1536', invalid: 'embedding_model' },
  { label: 'both invalid', model: 'openai:', dim: undefined, invalid: 'embedding_model, embedding_dimensions' },
  ...['', '0', '-1', '1.5', '1536junk', '9007199254740992'].map(dim => ({
    label: `bad dimensions ${JSON.stringify(dim)}`, model: 'openai:text-embedding-3-small', dim, invalid: 'embedding_dimensions',
  })),
];

for (const { label, model, dim, invalid } of cases) {
  test(`facts embedding refusal explains the DB config in why: ${label}`, async () => {
    const values: Record<string, string> = { embedding_model: model };
    if (dim !== undefined) values.embedding_dimensions = dim;
    const error = await refusal(values);
    expect(error.code).toBe('embedding_configuration');
    expect(error.message).toBe(MESSAGE);
    expect(error.why).toBe(`Invalid DB-plane config key(s): ${invalid}. Read from the selected brain's config table: ` +
      `embedding_model=${JSON.stringify(model)}, embedding_dimensions=${dim === undefined ? 'unset' : JSON.stringify(dim)}.`);
    expect(error.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'embeddings', '--json']);
  });
}

test('a long stored model value is bounded in why', async () => {
  const error = await refusal({ embedding_model: 'x'.repeat(500), embedding_dimensions: '1536' });
  expect(error.why).toContain(`embedding_model=${JSON.stringify(`${'x'.repeat(100)}…`)}`);
  expect(error.why).not.toContain('x'.repeat(101));
});

test('the rendered agent contract keeps the message and carries the diagnostic in why', async () => {
  const error = await refusal({ embedding_model: 'text-embedding-3-small', embedding_dimensions: '1536' });
  const env = toAgentError(error, { transport: 'stdio', op: 'extract_facts', render: {
    transport: 'stdio', surface: 'full', isCallable: () => true, preapproved: () => false, routing: { brain: 'host', source: 'default' },
  } });
  expect(env).toMatchObject({ code: 'embedding_configuration', message: MESSAGE, contract_version: 1 });
  expect(env.why).toContain('Invalid DB-plane config key(s): embedding_model.');
  expect(env.suggestion).toContain('is not provider:model');
  expect(env.fix?.command).toContain('gbrain doctor --only embeddings --json');
});
