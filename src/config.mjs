import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// 统一加载配置：文件配置作为基础，环境变量拥有更高优先级。
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const VALID_CC_MODES = new Set([
  'agent',
  'learning',
  'custom-agent',
  'custom-agent-create',
  'title-gen',
  'tool-desc',
  'compact',
  'vision',
]);

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig() {
  const defaults = {
    port: 3050,
    host: '0.0.0.0',
    apiKey: '',
    apiBase: 'https://api.commandcode.ai',
    // 协议实现基线与发送给上游的 CLI 版本头分开管理。
    protocolVersion: '1.7.0',
    cliEnvironment: 'production',
    userAgent: 'cli',
    projectSlug: 'cc-proxy',
    mode: 'agent',
    permissionMode: 'standard',
    tasteLearningEnabled: false,
    oauthEnforced: false,
    cmdZdr: false,
    ossPrimaryProvider: '',
    fingerprintSalt: '',
    logFile: '',
    logLevel: 'info',
    useProviderModels: true,
    modelRefreshIntervalMs: 5 * 60 * 1000,
  };

  const configPath = resolve(projectRoot, 'config.json');
  if (existsSync(configPath)) {
    try {
      const user = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (user && typeof user === 'object' && !Array.isArray(user)) {
        Object.assign(defaults, user);
      }
    } catch (error) {
      console.error('[config] Failed to parse config.json:', error.message);
    }
  }

  // 环境变量覆盖文件配置，便于 Docker 和生产环境部署。
  if (process.env.PORT) defaults.port = readPositiveInteger(process.env.PORT, defaults.port);
  if (process.env.HOST) defaults.host = process.env.HOST;
  if (process.env.CC_API_BASE) defaults.apiBase = process.env.CC_API_BASE;
  if (process.env.COMMAND_CODE_PROTOCOL_VERSION) {
    defaults.protocolVersion = process.env.COMMAND_CODE_PROTOCOL_VERSION;
  }
  if (process.env.CC_CLI_ENVIRONMENT) defaults.cliEnvironment = process.env.CC_CLI_ENVIRONMENT;
  if (process.env.CC_USER_AGENT) defaults.userAgent = process.env.CC_USER_AGENT;
  if (process.env.PROJECT_SLUG) defaults.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.CC_MODE) defaults.mode = process.env.CC_MODE;
  if (process.env.CC_PERMISSION_MODE) defaults.permissionMode = process.env.CC_PERMISSION_MODE;
  if (process.env.CC_TASTE_LEARNING) {
    defaults.tasteLearningEnabled = process.env.CC_TASTE_LEARNING === 'true';
  }
  if (process.env.CC_OAUTH_ENFORCED) {
    defaults.oauthEnforced = process.env.CC_OAUTH_ENFORCED === 'true';
  }
  if (process.env.CMD_ZDR) defaults.cmdZdr = process.env.CMD_ZDR === 'true';
  if (process.env.OSS_PRIMARY_PROVIDER) defaults.ossPrimaryProvider = process.env.OSS_PRIMARY_PROVIDER;
  if (process.env.FINGERPRINT_SALT) defaults.fingerprintSalt = process.env.FINGERPRINT_SALT;
  if (process.env.LOG_FILE) defaults.logFile = process.env.LOG_FILE;
  if (process.env.LOG_LEVEL) defaults.logLevel = process.env.LOG_LEVEL;
  if (process.env.CC_USE_PROVIDER_MODELS) {
    defaults.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';
  }
  if (process.env.MODEL_REFRESH_INTERVAL_MS) {
    defaults.modelRefreshIntervalMs = readPositiveInteger(
      process.env.MODEL_REFRESH_INTERVAL_MS,
      defaults.modelRefreshIntervalMs,
    );
  }

  defaults.port = readPositiveInteger(defaults.port, 3050);
  // 只允许 Command Code 1.7.0 已知的请求模式，普通对话默认使用 agent。
  if (!VALID_CC_MODES.has(defaults.mode)) defaults.mode = 'agent';
  if (typeof defaults.protocolVersion !== 'string' || !defaults.protocolVersion.trim()) {
    defaults.protocolVersion = '1.7.0';
  }
  defaults.modelRefreshIntervalMs = readPositiveInteger(
    defaults.modelRefreshIntervalMs,
    5 * 60 * 1000,
  );

  return defaults;
}
