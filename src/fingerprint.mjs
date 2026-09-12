import crypto from 'crypto';
import os from 'os';
import { existsSync } from 'fs';

// command-code@1.53.1 的设备指纹算法（dist/cli.mjs 的 buildMachineFingerprint，
// 与 1.47.0 逐字段比对无变化）：
// 1. hashSignal(value) = sha256(盐 + "\0" + value.trim().toLowerCase())，空值返回 undefined；
// 2. thumbmark = sha256(盐 + "\0machine\0" + parts.join("|"))，
//    parts = [machineId, mac 列表逗号拼接, machineId 为空时的 hostname, machineId 为空时的 cpuModel]。
// 盐值是 CLI 内置常量，不能改动，否则上游无法按同一规则复算指纹。
const SIGNAL_SALT = 'command-code:device-fingerprint:v1';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 1.53.1 的 hashSignal（与 1.47.0 相同）：trim + lowercase 后加盐哈希；空信号返回 undefined，
// JSON 序列化时会省略该字段，与真实 CLI 空 machine-id 时的载荷形状一致。
function hashSignal(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  return sha256(`${SIGNAL_SALT}\0${trimmed.toLowerCase()}`);
}

function detectContainer() {
  return existsSync('/.dockerenv')
    || process.env.CONTAINER === 'true'
    || process.env.KUBERNETES_SERVICE_HOST !== undefined;
}

function getTimezone() {
  // 1.53.1 读不到时区时会省略字段，这里返回空串交给统一处理。
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
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

// ── 合成原始信号 ─────────────────────────────────────
// 代理读不到调用方本机的真实 machine-id / MAC / 用户名，这里按 API Key
// 派生一套稳定的合成原始信号，再套用 1.53.1 的真实指纹算法，
// 使 thumbmark 和 components 的生成路径与真实 CLI 完全一致。
const SYNTHETIC_OUIS = ['8c:16:45', 'a4:5e:60', 'f0:18:98', '3c:22:fb', 'd0:03:4b', '00:1a:2b'];
const SYNTHETIC_USERS = ['alex', 'chen', 'dev', 'jordan', 'lee', 'morgan', 'sam', 'taylor'];
const SYNTHETIC_MAIL_DOMAINS = ['gmail.com', 'outlook.com', 'qq.com', '163.com', 'proton.me'];
const SYNTHETIC_HOST_WORDS = ['dev', 'lab', 'node', 'station', 'studio', 'work'];

function seededHex(seed, label, length) {
  return crypto.createHash('sha256').update(`${seed}:${label}`).digest('hex').slice(0, length);
}

// machine-id 按平台使用真实 CLI 读取到的格式：
// win32 是注册表 MachineGuid（小写 UUID），darwin 是 IOPlatformUUID（大写 UUID），
// linux 是 /etc/machine-id（32 位无连字符十六进制）。
function syntheticMachineId(seed, platform) {
  if (platform === 'linux') return seededHex(seed, 'machine-id', 32);
  const uuid = [
    seededHex(seed, 'machine-id', 8),
    seededHex(seed, 'machine-id-b', 4),
    seededHex(seed, 'machine-id-c', 4),
    seededHex(seed, 'machine-id-d', 4),
    seededHex(seed, 'machine-id-e', 12),
  ].join('-');
  return platform === 'darwin' ? uuid.toUpperCase() : uuid;
}

// 真实机器通常有多块网卡（以太网 + Wi-Fi + 蓝牙），MAC 数量按 key 在 2-4 间取值；
// 前 3 字节来自常见厂商 OUI，保持与真实网卡相同的外观。
function syntheticMacAddresses(seed) {
  const count = 2 + (Number.parseInt(seededHex(seed, 'mac-count', 2), 16) % 3);
  const macs = [];
  for (let i = 0; i < count; i++) {
    const oui = SYNTHETIC_OUIS[Number.parseInt(seededHex(seed, `mac-oui-${i}`, 4), 16) % SYNTHETIC_OUIS.length];
    macs.push(`${oui}:${seededHex(seed, `mac-nic-${i}`, 3).match(/.{2}/g).join(':')}`);
  }
  return macs;
}

function syntheticSignals(seed, platform) {
  const user = SYNTHETIC_USERS[Number.parseInt(seededHex(seed, 'os-user', 4), 16) % SYNTHETIC_USERS.length];
  const hostWord = SYNTHETIC_HOST_WORDS[Number.parseInt(seededHex(seed, 'host-word', 4), 16) % SYNTHETIC_HOST_WORDS.length];
  const hostTag = seededHex(seed, 'host-tag', 4);
  // hostname 形状随平台变化：Windows 默认 DESKTOP- + 7 位大写（NetBIOS 15 字符上限），
  // macOS 带用户名与 .local 后缀，linux 全小写短横线拼接。
  const hostname = platform === 'win32'
    ? `DESKTOP-${seededHex(seed, 'hostname', 7).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(7, 'X')}`
    : platform === 'darwin'
      ? `${user}s-macbook-${hostWord}.local`
      : `${user}-${hostWord}-${hostTag.slice(0, 2)}`;
  const domain = SYNTHETIC_MAIL_DOMAINS[Number.parseInt(seededHex(seed, 'mail-domain', 4), 16) % SYNTHETIC_MAIL_DOMAINS.length];
  return {
    machineId: syntheticMachineId(seed, platform),
    macAddresses: syntheticMacAddresses(seed),
    osUser: user,
    hostname,
    gitEmail: `${user}.${hostTag.slice(0, 4)}@${domain}`,
  };
}

export function generateFingerprint(apiKey = '', { salt = '' } = {}) {
  const seed = `${salt || 'commandcode-proxy-fingerprint-v1'}:${apiKey || 'anonymous'}`;
  const platform = process.platform;
  const arch = process.arch;
  const isContainer = detectContainer();
  const device = selectDeviceProfile(seed, platform, arch, isContainer);
  const raw = syntheticSignals(seed, platform);

  // 1.53.1 的 machine thumbmark（与 1.47.0 相同）：MAC 去重小写排序后与 machineId 拼接参与哈希；
  // 只有 machineId 缺失时才回退用 hostname / cpuModel，避免设备字段互相稀释。
  const macs = [...new Set(raw.macAddresses.map(mac => mac.toLowerCase()))].filter(Boolean).sort();
  const machineIdTrimmed = raw.machineId.trim();
  const parts = [
    machineIdTrimmed,
    macs.join(','),
    machineIdTrimmed ? '' : raw.hostname.trim(),
    machineIdTrimmed ? '' : device.cpuModel.trim(),
  ].filter(Boolean);

  const thumbmark = sha256(`${SIGNAL_SALT}\0machine\0${parts.join('|') || 'unknown'}`);

  // components 的字段顺序与 1.53.1 的 buildMachineFingerprint 保持一致。
  const components = {
    machineIdHash: hashSignal(raw.machineId),
    macHashes: macs.map(mac => hashSignal(mac)).filter(Boolean),
    osUserHash: hashSignal(raw.osUser),
    hostnameHash: hashSignal(raw.hostname),
    gitEmailHash: hashSignal(raw.gitEmail),
    platform,
    arch,
    osRelease: os.release(),
    cpuModel: device.cpuModel,
    cpuCount: device.cpuCount,
    memGiB: device.memGiB,
    isContainer,
    timezone: getTimezone() || undefined,
    runtime: 'cli',
    collectorVersion: 1,
  };

  return { thumbmark, components };
}
