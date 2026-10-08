import { describe, expect, test } from 'bun:test';
import { withColdStartRetry } from '../src/core/backup/private-path.ts';

// A PowerShell cold start can outrun the 15 s bound on a fresh Windows machine
// (protectNewBackupPath). These cases pin the retry policy on every platform;
// the Windows ACL path itself runs in backup-portability-native.serial.test.ts.
const timedOut = () => Object.assign(new Error('Command failed: powershell.exe'), { killed: true, signal: 'SIGTERM' });

describe('withColdStartRetry', () => {
  test('a run killed by the timeout is retried once and its second result returned', async () => {
    let calls = 0;
    const result = await withColdStartRetry(async () => { calls++; if (calls === 1) throw timedOut(); return 'private'; });
    expect(result).toBe('private');
    expect(calls).toBe(2);
  });

  test('a second timeout is final', async () => {
    let calls = 0;
    await expect(withColdStartRetry(async () => { calls++; throw timedOut(); })).rejects.toMatchObject({ killed: true });
    expect(calls).toBe(2);
  });

  test('any other failure is not retried', async () => {
    for (const failure of [new Error('Access rule mismatch'), new Error('Private path input failed'), Object.assign(new Error('exit 1'), { killed: false, code: 1 })]) {
      let calls = 0;
      await expect(withColdStartRetry(async () => { calls++; throw failure; })).rejects.toBe(failure);
      expect(calls).toBe(1);
    }
  });

  test('a first success runs once', async () => {
    let calls = 0;
    expect(await withColdStartRetry(async () => { calls++; return 'private'; })).toBe('private');
    expect(calls).toBe(1);
  });
});
