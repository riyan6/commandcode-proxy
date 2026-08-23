import crypto from 'crypto';
import os from 'os';
import { existsSync } from 'fs';

// 生成与最新版 CLI 字段结构一致的指纹，同时避免把原始 API Key 或网卡地址发给上游。
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function detectContainer() {
  return existsSync('/.dockerenv')
    || process.env.CONTAINER === 'true'
    || process.env.KUBERNETES_SERVICE_HOST !== undefined;
}

function getTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function getMacAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.mac && entry.mac !== '00:00:00:00:00:00' && !entry.internal) {
        addresses.push(entry.mac.toLowerCase());
      }
    }
  }
  return [...new Set(addresses)].sort();
}

// 常见硬件参数池：按 key 种子派生硬件字段，避免同一代理宿主机上
// 多个 key 的指纹在 cpuModel/cpuCount/memGiB 上完全一致而被上游聚类识别。
const CPU_MODELS = [
  'AMD Ryzen 9 7950X 16-Core Processor',
  'AMD Ryzen 7 7800X3D 8-Core Processor',
  'AMD Ryzen 5 7600X 6-Core Processor',
  'Intel(R) Core(TM) i9-14900K CPU @ 3.20GHz',
  'Intel(R) Core(TM) i7-13700K CPU @ 3.40GHz',
  'Intel(R) Core(TM) i7-12700H CPU @ 2.30GHz',
  'Intel(R) Core(TM) i5-13600K CPU @ 3.50GHz',
  'Intel(R) Core(TM) Ultra 7 155H',
  'Apple M3 Pro',
  'Apple M2',
];
const CPU_COUNTS = [6, 8, 10, 12, 14, 16, 20, 24];
const MEM_GIBS = [8, 16, 24, 32, 48, 64];

function pickFromPool(seed, label, pool) {
  // 取哈希前 4 字节做索引，同一 key 稳定、不同 key 尽量分散。
  const digest = crypto.createHash('sha256').update(`${seed}:${label}`).digest();
  return pool[digest.readUInt32BE(0) % pool.length];
}

export function generateFingerprint(apiKey = '', { salt = '' } = {}) {
  const seed = `${salt || 'commandcode-proxy-fingerprint-v1'}:${apiKey || 'anonymous'}`;
  const derive = label => sha256(`${seed}:${label}`);
  const macHashes = getMacAddresses().map(mac => sha256(`${seed}:mac:${mac}`));

  // 某些容器没有可用网卡地址，仍然保持最新版 CLI 的 macHashes 数组形状。
  if (macHashes.length === 0) macHashes.push(derive('mac:fallback'));

  const components = {
    machineIdHash: derive('machine-id'),
    macHashes,
    osUserHash: derive('os-user'),
    hostnameHash: sha256(`${seed}:hostname:${os.hostname()}`),
    gitEmailHash: derive('git-email'),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: pickFromPool(seed, 'cpu-model', CPU_MODELS),
    cpuCount: pickFromPool(seed, 'cpu-count', CPU_COUNTS),
    memGiB: pickFromPool(seed, 'mem-gib', MEM_GIBS),
    isContainer: detectContainer(),
    timezone: getTimezone(),
    runtime: 'cli',
    collectorVersion: 1,
  };

  const thumbmark = sha256(JSON.stringify(components));
  return { thumbmark, components };
}
