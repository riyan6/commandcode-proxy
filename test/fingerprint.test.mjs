import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFingerprint } from '../src/fingerprint.mjs';

test('指纹字段与最新版 CLI 对齐并按 API Key 稳定', () => {
  const first = generateFingerprint('key-a', { salt: 'test-salt' });
  const second = generateFingerprint('key-a', { salt: 'test-salt' });
  const other = generateFingerprint('key-b', { salt: 'test-salt' });

  assert.deepEqual(first, second);
  assert.notEqual(first.thumbmark, other.thumbmark);
  assert.equal(first.components.runtime, 'cli');
  assert.equal(first.components.collectorVersion, 1);
  assert.ok(Array.isArray(first.components.macHashes));
  assert.ok(first.components.macHashes.length > 0);
  assert.equal(typeof first.components.cpuCount, 'number');
  assert.equal(typeof first.components.isContainer, 'boolean');
});
