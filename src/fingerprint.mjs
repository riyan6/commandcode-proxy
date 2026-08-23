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

// CPU、逻辑核心数和内存必须作为完整设备档案一起选择，不能分别抽签；
// 否则可能出现 Windows + Apple 芯片或 CPU 型号与核心数明显矛盾的组合。
const DEVICE_PROFILES = {
  'win32-x64': [
    { cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor', cpuCount: 32, memGiB: 64 },
    { cpuModel: 'AMD Ryzen 7 7800X3D 8-Core Processor', cpuCount: 16, memGiB: 32 },
    { cpuModel: 'Intel(R) Core(TM) i9-14900K CPU @ 3.20GHz', cpuCount: 32, memGiB: 64 },
    { cpuModel: 'Intel(R) Core(TM) i7-13700K CPU @ 3.40GHz', cpuCount: 24, memGiB: 32 },
    { cpuModel: 'Intel(R) Core(TM) i7-12700H CPU @ 2.30GHz', cpuCount: 20, memGiB: 16 },
  ],
  'win32-arm64': [
    { cpuModel: 'Snapdragon(R) X Elite - X1E80100', cpuCount: 12, memGiB: 32 },
    { cpuModel: 'Snapdragon(R) X Plus - X1P64100', cpuCount: 10, memGiB: 16 },
  ],
  'linux-x64': [
    { cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor', cpuCount: 32, memGiB: 64 },
    { cpuModel: 'AMD Ryzen 7 7800X3D 8-Core Processor', cpuCount: 16, memGiB: 32 },
    { cpuModel: 'Intel(R) Core(TM) i7-13700K CPU @ 3.40GHz', cpuCount: 24, memGiB: 32 },
    { cpuModel: 'Intel(R) Core(TM) i5-13600K CPU @ 3.50GHz', cpuCount: 20, memGiB: 32 },
  ],
  'linux-x64-container': [
    { cpuModel: 'AMD EPYC 7B13 64-Core Processor', cpuCount: 8, memGiB: 16 },
    { cpuModel: 'AMD EPYC 7B13 64-Core Processor', cpuCount: 16, memGiB: 32 },
    { cpuModel: 'Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', cpuCount: 8, memGiB: 16 },
    { cpuModel: 'Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', cpuCount: 16, memGiB: 32 },
  ],
  'linux-arm64': [
    { cpuModel: 'Neoverse-N1', cpuCount: 8, memGiB: 16 },
    { cpuModel: 'Neoverse-N1', cpuCount: 16, memGiB: 32 },
    { cpuModel: 'Ampere Altra', cpuCount: 16, memGiB: 32 },
  ],
  'darwin-arm64': [
    { cpuModel: 'Apple M2', cpuCount: 8, memGiB: 16 },
    { cpuModel: 'Apple M2 Pro', cpuCount: 12, memGiB: 32 },
    { cpuModel: 'Apple M3 Pro', cpuCount: 12, memGiB: 18 },
  ],
  'darwin-x64': [
    { cpuModel: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz', cpuCount: 12, memGiB: 16 },
    { cpuModel: 'Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz', cpuCount: 16, memGiB: 32 },
  ],
};

function pickFromPool(seed, label, pool) {
  // 取哈希前 4 字节做索引，同一 key 稳定、不同 key 尽量分散。
  const digest = crypto.createHash('sha256').update(`${seed}:${label}`).digest();
  return pool[digest.readUInt32BE(0) % pool.length];
}

function selectDeviceProfile(seed, platform, arch, isContainer) {
  const profileKey = isContainer && DEVICE_PROFILES[`${platform}-${arch}-container`]
    ? `${platform}-${arch}-container`
    : `${platform}-${arch}`;
  const profiles = DEVICE_PROFILES[profileKey];
  if (profiles?.length) return pickFromPool(seed, 'device-profile', profiles);

  // 未覆盖的平台直接使用宿主机的一整套实际值，避免拼出不可能的设备。
  return {
    cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
    cpuCount: Math.max(1, os.cpus().length),
    memGiB: Math.max(1, Math.round(os.totalmem() / (1024 ** 3))),
  };
}

export function generateFingerprint(apiKey = '', { salt = '' } = {}) {
  const seed = `${salt || 'commandcode-proxy-fingerprint-v1'}:${apiKey || 'anonymous'}`;
  const derive = label => sha256(`${seed}:${label}`);
  const platform = process.platform;
  const arch = process.arch;
  const isContainer = detectContainer();
  const device = selectDeviceProfile(seed, platform, arch, isContainer);

  const components = {
    machineIdHash: derive('machine-id'),
    // 不混入容器临时网卡或宿主机名，避免重启后只有部分设备字段变化。
    macHashes: [derive('mac-address')],
    osUserHash: derive('os-user'),
    hostnameHash: derive('hostname'),
    gitEmailHash: derive('git-email'),
    platform,
    arch,
    osRelease: os.release(),
    ...device,
    isContainer,
    timezone: getTimezone(),
    runtime: 'cli',
    collectorVersion: 1,
  };

  const thumbmark = sha256(JSON.stringify(components));
  return { thumbmark, components };
}
