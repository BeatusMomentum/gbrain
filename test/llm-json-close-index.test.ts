/**
 * Contract of the shared balanced-close scanner used by the chronicle judge,
 * propose_takes and extract_atoms recovery paths. Caller regressions live in
 * their own suites; this pins the scanner's edge cases once.
 */
import { describe, expect, test } from 'bun:test';
import { findJsonCloseIndex } from '../src/core/llm-json.ts';

describe('findJsonCloseIndex', () => {
  test('returns the top-level closer, not a later citation bracket', () => {
    const s = '[{"a":1}]\nSee [Source: alice-example].';
    expect(findJsonCloseIndex(s)).toBe(8);
  });

  test('tracks nested containers of the same kind', () => {
    const s = '[[1,[2]],3] trailing ]';
    expect(findJsonCloseIndex(s)).toBe(10);
    expect(findJsonCloseIndex('{"a":{"b":{}}} }')).toBe(13);
  });

  test('ignores brackets inside strings, including escaped quotes and backslashes', () => {
    expect(findJsonCloseIndex('["]"]')).toBe(4);
    expect(findJsonCloseIndex('["a\\"]"] x]')).toBe(7);
    expect(findJsonCloseIndex('["a\\\\"] x]')).toBe(6);
  });

  test('returns -1 for unclosed input or a non-container start', () => {
    expect(findJsonCloseIndex('[{"a":1}')).toBe(-1);
    expect(findJsonCloseIndex('["unterminated]')).toBe(-1);
    expect(findJsonCloseIndex('see [x]')).toBe(-1);
    expect(findJsonCloseIndex('')).toBe(-1);
  });
});
