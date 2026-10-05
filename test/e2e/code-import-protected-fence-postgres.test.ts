import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../code-import-protected-fence.test.ts'));
