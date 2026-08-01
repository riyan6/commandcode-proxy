import crypto from 'crypto';

// 生成与上游协议兼容的项目标识和 Trace Context。
export function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker'];
  const digest = crypto.createHash('sha256').update(String(sessionId)).digest('hex');
  const name = names[Number.parseInt(digest.slice(0, 4), 16) % names.length];
  const suffix = digest.slice(0, 4);
  const path = `C:\\Users\\dev\\projects\\${name}-${suffix}`;
  return path
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

// 统一构造最新版 CLI 使用的公共请求头，初始化、生成和模型请求共用同一套规则。
export function buildCommandCodeHeaders({
  apiKey,
  commandCodeVersion,
  cliEnvironment = 'production',
  userAgent = 'cli',
  projectSlug,
  sessionId,
  traceparent,
  tasteLearningEnabled = false,
  oauthEnforced = false,
  cmdZdr = false,
  ossPrimaryProvider = '',
} = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent || 'cli',
    'x-cli-environment': cliEnvironment || 'production',
    'x-command-code-version': commandCodeVersion,
    'x-co-flag': String(Boolean(oauthEnforced)),
    'x-taste-learning': String(Boolean(tasteLearningEnabled)),
  };

  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (projectSlug) headers['x-project-slug'] = projectSlug;
  if (sessionId) headers['x-session-id'] = sessionId;
  if (traceparent) headers.traceparent = traceparent;
  if (ossPrimaryProvider) headers['x-oss-primary-provider'] = ossPrimaryProvider;
  if (cmdZdr) headers['x-cmd-zdr'] = '1';
  return headers;
}

export async function forwardToCC({
  apiBase,
  projectSlug,
  commandCodeVersion,
  cliEnvironment,
  userAgent,
  tasteLearningEnabled,
  oauthEnforced,
  cmdZdr,
  ossPrimaryProvider,
  body,
  apiKey,
  incomingHeaders = {},
  signal,
  getSessionId,
}) {
  const sessionId = getSessionId(incomingHeaders, apiKey);
  return fetch(`${apiBase}/alpha/generate`, {
    method: 'POST',
    headers: buildCommandCodeHeaders({
      apiKey,
      commandCodeVersion,
      cliEnvironment,
      userAgent,
      projectSlug: projectSlug || fakeProjectSlug(sessionId),
      sessionId,
      traceparent: generateTraceparent(),
      tasteLearningEnabled,
      oauthEnforced,
      cmdZdr,
      ossPrimaryProvider,
    }),
    body: JSON.stringify(body),
    signal,
  });
}
