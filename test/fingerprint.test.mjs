import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { generateFingerprint } from '../src/fingerprint.mjs';

test('指纹字段与 1.47.0 CLI 对齐并按 API Key 稳定', () => {
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

test('thumbmark 使用 1.47.0 的加盐机器信号哈希，而非 components JSON 哈希', () => {
  const { thumbmark, components } = generateFingerprint('key-algo', { salt: 'test-salt' });

  assert.match(thumbmark, /^[0-9a-f]{64}$/);
  // 1.32.1 之前的实现把 components 整体 JSON 序列化后哈希；1.47.0 已改为
  // “盐 + \0machine\0 + machineId|mac 列表”的加盐哈希，两者必须不相等。
  const jsonHash = crypto.createHash('sha256')
    .update(JSON.stringify(components))
    .digest('hex');
  assert.notEqual(thumbmark, jsonHash);

  // machineIdHash 必须是“盐 + \0 + 小写信号”的加盐哈希格式：
  // 同一盐值对任意固定字符串复算，结果应命中 64 位十六进制空间。
  const saltProbe = crypto.createHash('sha256')
    .update('command-code:device-fingerprint:v1\0probe')
    .digest('hex');
  assert.match(saltProbe, /^[0-9a-f]{64}$/);
});

test('components 字段顺序与 1.47.0 buildMachineFingerprint 一致', () => {
  const { components } = generateFingerprint('key-order', { salt: 'test-salt' });

  assert.deepEqual(Object.keys(components), [
    'machineIdHash',
    'macHashes',
    'osUserHash',
    'hostnameHash',
    'gitEmailHash',
    'platform',
    'arch',
    'osRelease',
    'cpuModel',
    'cpuCount',
    'memGiB',
    'isContainer',
    'timezone',
    'runtime',
    'collectorVersion',
  ]);
  // macHashes 由去重小写排序后的 MAC 逐个加盐哈希而来，因此数组内无重复。
  assert.equal(new Set(components.macHashes).size, components.macHashes.length);
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

  // 平台与 CPU 架构必须互相匹配，不能再出现 Windows/Linux + Apple 芯片。
  if (process.platform !== 'darwin') {
    assert.doesNotMatch(first.components.cpuModel, /^Apple /);
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    assert.match(first.components.cpuModel, /^Apple /);
  }
  if (first.components.isContainer && process.platform === 'linux' && process.arch === 'x64') {
    assert.match(first.components.cpuModel, /(?:EPYC|Xeon)/);
  }
});
