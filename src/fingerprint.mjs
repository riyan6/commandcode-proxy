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

export function generateFingerprint(apiKey = '', { salt = '' } = {}) {
  const seed = `${salt || 'commandcode-proxy-fingerprint-v1'}:${apiKey || 'anonymous'}`;
  const derive = label => sha256(`${seed}:${label}`);
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'unknown';
  const cpuCount = cpus.length || 1;
  const memGiB = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
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
    cpuModel,
    cpuCount,
    memGiB,
    isContainer: detectContainer(),
    timezone: getTimezone(),
    runtime: 'cli',
    collectorVersion: 1,
  };

  const thumbmark = sha256(JSON.stringify(components));
  return { thumbmark, components };
}
