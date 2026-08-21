import crypto from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionHeaderNames(headers = {}) {
  const value = headers.connection;
  if (typeof value !== 'string') return [];
  return value.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
}

export function filterProxyHeaders(headers = {}, { websocket = false } = {}) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaderNames(headers), 'host']);

  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) filtered[name] = value;
  }
  if (websocket && headers.upgrade) {
    // 只重建标准升级头，不能把 Connection 点名的其他逐跳字段带过代理边界。
    filtered.Connection = 'Upgrade';
    filtered.Upgrade = headers.upgrade;
  }
  return filtered;
}

export function isCommandCodeNativePath(pathname) {
  return ['/alpha', '/beta', '/internal', '/provider']
    .some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function buildNativeTarget(apiBase, requestUrl) {
  const target = new URL(apiBase);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported CC API protocol: ${target.protocol}`);
  }

  // requestUrl 只贡献 path/query，目标协议和主机始终锁定到可信的 apiBase。
  const incoming = new URL(requestUrl, 'http://proxy.invalid');
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}${incoming.pathname}` || '/';
  target.search = incoming.search;
  target.hash = '';
  return target;
}

function requestForTarget(target) {
  return target.protocol === 'https:' ? httpsRequest : httpRequest;
}

function terminateSocket(socket) {
  if (socket.destroyed) return;
  if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
  else socket.destroy();
}

export function forwardNativeToCC({ apiBase, method, requestUrl, headers, body, signal }) {
  const target = buildNativeTarget(apiBase, requestUrl);
  const requestImpl = requestForTarget(target);

  return new Promise((resolve, reject) => {
    let upstreamResponse;
    let settled = false;
    const upstreamRequest = requestImpl(target, {
      method,
      headers: filterProxyHeaders(headers),
    }, response => {
      upstreamResponse = response;
      response.once('close', () => signal?.removeEventListener('abort', abort));
      settled = true;
      resolve(response);
    });

    const abort = () => {
      const error = new Error('Native proxy request aborted');
      error.name = 'AbortError';
      upstreamResponse?.destroy(error);
      upstreamRequest.destroy(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    upstreamRequest.once('error', error => {
      if (!settled) reject(error);
    });
    upstreamRequest.once('close', () => {
      if (!upstreamResponse) signal?.removeEventListener('abort', abort);
    });
    upstreamRequest.end(body);
  });
}

export function tunnelNativeWebSocket({ apiBase, requestUrl, headers, clientSocket, clientHead }) {
  const target = buildNativeTarget(apiBase, requestUrl);
  const requestImpl = requestForTarget(target);
  const upstreamRequest = requestImpl(target, {
    method: 'GET',
    headers: filterProxyHeaders(headers, { websocket: true }),
  });

  upstreamRequest.once('upgrade', (response, upstreamSocket, upstreamHead) => {
    let upstreamEnded = false;
    let clientEnded = false;
    const statusLine = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`;
    clientSocket.write(statusLine);
    const responseHeaders = filterProxyHeaders(response.headers, { websocket: true });
    for (const [name, value] of Object.entries(responseHeaders)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) clientSocket.write(`${name}: ${item}\r\n`);
    }
    clientSocket.write('\r\n');
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (clientHead.length > 0) upstreamSocket.write(clientHead);
    upstreamSocket.once('error', () => terminateSocket(clientSocket));
    clientSocket.once('error', () => terminateSocket(upstreamSocket));
    upstreamSocket.once('end', () => {
      upstreamEnded = true;
      clientSocket.end();
    });
    clientSocket.once('end', () => {
      clientEnded = true;
      upstreamSocket.end();
    });
    upstreamSocket.once('close', () => {
      if (!upstreamEnded) terminateSocket(clientSocket);
    });
    clientSocket.once('close', () => {
      if (!clientEnded) terminateSocket(upstreamSocket);
    });
    // 禁止 pipe 自动 half-close；先由上面的监听器同时终止两端，避免残留半开连接。
    upstreamSocket.pipe(clientSocket, { end: false });
    clientSocket.pipe(upstreamSocket, { end: false });
  });

  upstreamRequest.once('response', response => {
    clientSocket.write(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
    const responseHeaders = filterProxyHeaders(response.headers);
    for (const [name, value] of Object.entries(responseHeaders)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) clientSocket.write(`${name}: ${item}\r\n`);
    }
    clientSocket.write('\r\n');
    response.pipe(clientSocket);
  });
  upstreamRequest.once('error', () => clientSocket.destroy());
  clientSocket.once('error', () => upstreamRequest.destroy());
  clientSocket.once('close', () => upstreamRequest.destroy());
  upstreamRequest.end();
}

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
// 请求头字段对齐 command-code@1.31.0 的 buildCommandAuthHeaders。
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
  deepseekInternal = false,
} = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent || 'cli',
    'x-cli-environment': cliEnvironment || 'production',
    'x-command-code-version': commandCodeVersion,
    'x-taste-learning': String(Boolean(tasteLearningEnabled)),
    'x-project-slug': projectSlug,
    'x-session-id': sessionId,
  };

  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (traceparent) headers.traceparent = traceparent;
  if (ossPrimaryProvider) headers['x-oss-primary-provider'] = ossPrimaryProvider;
  if (cmdZdr) headers['x-cmd-zdr'] = '1';
  // 1.31.0 新增：DeepSeek 内部 provider 标识，仅内部渠道使用。
  if (deepseekInternal) headers['x-cmd-provider-deepseek-internal'] = '1';
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
  deepseekInternal,
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
      deepseekInternal,
    }),
    body: JSON.stringify(body),
    signal,
  });
}
