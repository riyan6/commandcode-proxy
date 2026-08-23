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

test('硬件字段按 key 派生：同 key 稳定、取值来自常见硬件池', () => {
  const first = generateFingerprint('key-hw', { salt: 'test-salt' });
  const second = generateFingerprint('key-hw', { salt: 'test-salt' });

  // 同一 key 的硬件字段稳定，不同 key 的指纹整体不同。
  assert.equal(first.components.cpuModel, second.components.cpuModel);
  assert.equal(first.components.cpuCount, second.components.cpuCount);
  assert.equal(first.components.memGiB, second.components.memGiB);

  // 取值落在常见硬件池范围内，保持真实世界的合理形状。
  assert.ok(typeof first.components.cpuModel === 'string' && first.components.cpuModel.length > 0);
  assert.ok(Number.isInteger(first.components.cpuCount));
  assert.ok(first.components.cpuCount >= 4 && first.components.cpuCount <= 32);
  assert.ok(Number.isInteger(first.components.memGiB));
  assert.ok(first.components.memGiB >= 8 && first.components.memGiB <= 64);
});
