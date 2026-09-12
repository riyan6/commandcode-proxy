/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import { randomUUID } from 'crypto';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname as pathDirname } from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { loadConfig } from './src/config.mjs';
import { createStateStore } from './src/state.mjs';
import { generateFingerprint } from './src/fingerprint.mjs';
import { validateAnthropicRequest, validateOpenAIRequest } from './src/validation.mjs';
import { readWithTimeout } from './src/stream.mjs';
import { beginRequest, createMetricsStore } from './src/metrics.mjs';
import {
  buildCommandCodeHeaders,
  filterProxyHeaders,
  forwardNativeToCC,
  forwardToCC,
  generateTraceId,
  generateTraceparent,
  isCommandCodeNativePath,
  tunnelNativeWebSocket,
} from './src/cc-client.mjs';
import {
  buildAnthropicResponse,
  buildCcRequest,
  buildFakeWorkspace,
  convertAnthropicToOpenAI,
  createAnthropicSseTranslator,
  mapFinishReason,
  normalizeUsage,
  projectSlugFromWorkspace,
} from './src/adapters.mjs';

const CFG = loadConfig();

// 请求体和字段转换固定按 command-code@1.53.1 实现，避免协议随上游版本漂移。
// 发送给上游的 x-command-code-version 头与实现基线保持一致（protocolVersion），
// 不再跟随 npm latest，避免“头版本新但特性旧”被后端识别出代理伪装。
const CC_VERSION = CFG.protocolVersion;

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — 请求体大小上限
const STREAM_IDLE_TIMEOUT_MS = 30000;   // 30s — 流式无新数据中断
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容
// 原生透传的空闲超时（可用 CC_NATIVE_IDLE_TIMEOUT_MS 覆盖，便于测试与运维调整）。
const NATIVE_IDLE_TIMEOUT_ENV = Number.parseInt(process.env.CC_NATIVE_IDLE_TIMEOUT_MS || '', 10);
const NATIVE_IDLE_TIMEOUT_MS = Number.isFinite(NATIVE_IDLE_TIMEOUT_ENV) && NATIVE_IDLE_TIMEOUT_ENV > 0
  ? NATIVE_IDLE_TIMEOUT_ENV
  : 120000; // 120s — 透传内容形态未知，比生成路径更宽容
const NATIVE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// 连续 3 次超时才提醒压缩上下文，计数按 API Key 隔离。
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
const LOG_LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

// 日志文件用异步追加流写入，避免每条日志的同步 IO 阻塞事件循环；打开失败时降级为仅控制台。
let logStream = null;
function appendLogFile(line) {
  if (!logStream) {
    logStream = createWriteStream(CFG.logFile, { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  }
  logStream.write(line + '\n');
}

function log(level, msg, data) {
  const configuredLevel = LOG_LEVEL_ORDER[CFG.logLevel] ?? LOG_LEVEL_ORDER.info;
  if ((LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info) < configuredLevel) return;
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  if (CFG.logFile) {
    try { appendLogFile(line); } catch {}
  }
}

// 运行时状态由独立模块集中管理，超时和模型缓存按 API Key 隔离。
const state = createStateStore({
  generateFingerprint: apiKey => generateFingerprint(apiKey, { salt: CFG.fingerprintSalt }),
  log,
});

// 代理自身的运行时指标（首 token 延迟、请求时长、上游 429/402），
// 仅内存保存、重启清零；用量统计由 commandcode 官方后台提供。
const metrics = createMetricsStore();

function getTimeoutMessage(apiKey) {
  const timeoutCount = state.recordTimeout(apiKey);
  return timeoutCount >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out';
}

// ── 初始化预请求（fingerprint，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动
// 上报失败后的短退避（可用 CC_INIT_RETRY_MS 覆盖，便于测试与运维调整），
// 不能沿用完整的 8h 周期，否则一次失败会让该 key 一整天不再上报指纹。
const INIT_RETRY_MS_ENV = Number.parseInt(process.env.CC_INIT_RETRY_MS || '', 10);
const INIT_RETRY_MS = Number.isFinite(INIT_RETRY_MS_ENV) && INIT_RETRY_MS_ENV > 0
  ? INIT_RETRY_MS_ENV
  : 5 * 60 * 1000;

async function ensureInitialized(apiKey, signal) {
  const keyState = state.getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < keyState.nextInitAt) return;

  // 并发首请求共用同一次上报，避免重复调用 fingerprint/record。
  if (keyState.initInFlight) return keyState.initInFlight;
  keyState.initInFlight = (async () => {
    try {
      // 指纹与 lifecycle 使用通用 API 请求头；真实 CLI 不会在这里发送
      // x-project-slug、x-session-id 或 x-taste-learning。
      const headers = buildCommandCodeHeaders({
        apiKey,
        commandCodeVersion: CC_VERSION,
        cliEnvironment: CFG.cliEnvironment,
        userAgent: CFG.userAgent,
        cmdZdr: CFG.cmdZdr,
      });
      const fingerprint = keyState.fingerprint || {};

      // 真实 CLI（1.32.1/1.47.0 抓包与 bundle 实测）会话建立时 POST /alpha/lifecycle-events：
      // {"eventType":"cli_session_exists","metadata":{"sessionId":"sess_…","cliVersion":"…","mode":"interactive","os":"win32-x64"}}
      // 之前的注释"1.31.0 已移除该端点"与实测不符；失败不阻塞主流程。
      try {
        const lifecycleResponse = await fetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
          method: 'POST',
          headers,
          signal,
          body: JSON.stringify({
            eventType: 'cli_session_exists',
            metadata: {
              sessionId: keyState.telemetrySessionId,
              cliVersion: CC_VERSION,
              mode: 'interactive',
              os: `${process.platform}-${process.arch}`,
            },
          }),
        });
        if (!lifecycleResponse.ok) {
          log('debug', 'Lifecycle event rejected', { status: lifecycleResponse.status });
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        log('debug', 'Lifecycle event failed', { error: error.message });
      }

      const response = await fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal,
        body: JSON.stringify(fingerprint),
      });
      if (!response.ok) {
        // 上报失败走 5 分钟短退避，下一个请求即重试，而不是静默等 8 小时。
        keyState.nextInitAt = Date.now() + INIT_RETRY_MS;
        log('warn', 'Fingerprint record failed, will retry soon', { status: response.status });
        return;
      }
      log('info', 'Fingerprint recorded');

      // 成功：8h + 2h 随机抖动
      const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
      keyState.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
      log('info', 'Fingerprint next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
    } catch (e) {
      if (e.name !== 'AbortError') log('warn', 'Fingerprint refresh error, will retry next request', { error: e.message });
    }
  })();
  keyState.initInFlight.finally(() => { keyState.initInFlight = null; }).catch(() => {});
  return keyState.initInFlight;
}

// ── 工具函数 ───────────────────────────────────────

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// 从 1.31.0 的 usage 对象读取缓存输入 token。
// finish 事件的 totalUsage.inputTokenDetails.cacheReadTokens 是权威字段，
// 老版本用顶层的 cachedInputTokens，这里都兼容。
function getCachedInputTokens(usage) {
  if (!usage) return 0;
  const details = usage.inputTokenDetails;
  if (details && details.cacheReadTokens !== undefined) return details.cacheReadTokens;
  return usage.cachedInputTokens ?? 0;
}

function getThreadId(headers = {}, request = {}) {
  const candidates = [
    headers['x-command-code-thread-id'],
    headers['x-thread-id'],
    request.thread_id,
    request.threadId,
    request.metadata?.thread_id,
  ];
  return candidates.find(value => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;
  let segmentFinished = false;
  let pauseTurn = false;
  let streamError = false;
  let upstreamAborted = false;

  return {
    lastCcEvent: '',
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    get finished() {
      return segmentFinished;
    },
    get shouldContinue() {
      return pauseTurn;
    },
    get hasError() {
      return streamError;
    },
    // 最新 CLI 遇到 pause_turn 会复用线程发起下一段请求。
    beginContinuation() {
      segmentFinished = false;
      pauseTurn = false;
      finishReason = null;
      usage = null;
    },
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          if (event.providerExecuted) break;
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          // 1.31.0 的 tool-call 事件同时支持 input 或 args 字段。
          const rawInput = event.input ?? event.args;
          const args = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        // 1.31.0 新增：服务端直接执行的工具结果。OpenAI 协议没有对应概念，
        // 静默跳过，避免污染下游的 tool_calls 序列。
        case 'tool-result': {
          if (!event.providerExecuted) break;
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = getCachedInputTokens(event.usage);
          }
          break;
        }

        case 'finish': {
          const rawFinishReason = String(event.rawFinishReason || event.finishReason || 'stop').toLowerCase();
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = getCachedInputTokens(u);
          if (rawFinishReason === 'pause_turn') {
            // 不向下游暴露中间 pause_turn，外层会按最新版 CLI 继续请求。
            pauseTurn = true;
            segmentFinished = false;
            break;
          }
          const fr = finishReason || mapFinishReason(rawFinishReason);
          segmentFinished = true;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: getCachedInputTokens(u) },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          streamError = true;
          log('warn', 'CC stream error', { message: msg });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        // 1.31.0：abort 事件表示上游主动终止，视为正常结束。
        case 'abort': {
          segmentFinished = true;
          upstreamAborted = true;
          // abort 是合法终止，不算零输出；有文本输出时避免触发零输出防护。
          if (chunkIndex > 0 && !this.outputTokens) this.outputTokens = 1;
          break;
        }

        case 'reasoning-start': case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody, retryAfterHeader) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after：优先透传上游返回的值，无值时再回退默认 30s。
  if (ccStatus === 429) {
    const parsedRetryAfter = Number.parseInt(retryAfterHeader ?? '', 10);
    const retryAfter = Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0 ? parsedRetryAfter : 30;
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: retryAfter,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    // 优先按声明的 Content-Length 预检，超限直接拒绝，客户端不必继续发送。
    const declaredSize = Number.parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_SIZE) {
      const error = new Error('Request body exceeds 10MB limit');
      error.status = 413;
      req.resume();
      reject(error);
      return;
    }

    const chunks = [];
    let totalSize = 0;
    let rejected = false;
    req.on('data', c => {
      if (rejected) return;
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        // 不立即 destroy 连接：先让调用方回 413，连接由调用方按 Connection: close 处理。
        rejected = true;
        const error = new Error('Request body exceeds 10MB limit');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', error => { if (!rejected) reject(error); });
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const declaredSize = Number.parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_SIZE) {
      const error = new Error('Request body exceeds 10MB limit');
      error.status = 413;
      req.resume();
      reject(error);
      return;
    }

    const chunks = [];
    let totalSize = 0;
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        rejected = true;
        const error = new Error('Request body exceeds 10MB limit');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

// SSE 写入带背压：res.write 返回 false 说明内核写缓冲已满，
// 等待 drain（或连接关闭）再继续，防止慢客户端 + 长流把内存无限积压在写队列里。
async function writeSse(res, chunk) {
  if (res.writableEnded || res.destroyed) return;
  let writable;
  try { writable = res.write(chunk); } catch { return; }
  if (writable) return;
  await new Promise(resolve => {
    const onDrain = () => { res.removeListener('close', onClose); resolve(); };
    const onClose = () => { res.removeListener('drain', onDrain); resolve(); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

// ── 原生透传抓包记录（RECORD_WIRE）────────────────────
// 设为 JSONL 文件路径后，经过代理的 CLI 请求/响应会脱敏后逐行追加，
// 用于配合 COMMANDCODE_API_ENV=local 分析真实 CLI 的 wire 协议。
let recordStream = null;
const RECORD_BODY_LIMIT = 64 * 1024;
const WIRE_REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie']);

function redactWireHeaders(headers = {}) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = WIRE_REDACTED_HEADERS.has(name.toLowerCase()) ? '***' : value;
  }
  return redacted;
}

function recordNativeWire(event, req, url, body, upstream) {
  if (!CFG.recordWire) return;
  try {
    if (!recordStream) {
      // 父目录不存在时先创建：createWriteStream 遇到缺失目录会静默失败，导致漏记。
      const recordDir = pathDirname(CFG.recordWire);
      if (recordDir && recordDir !== '.') mkdirSync(recordDir, { recursive: true });
      recordStream = createWriteStream(CFG.recordWire, { flags: 'a' });
      recordStream.on('error', () => {
        log('warn', 'RECORD_WIRE 文件写入失败，抓包记录已停止', { file: CFG.recordWire });
        recordStream = null;
      });
    }
    if (event === 'request') {
      const bodyText = body ? body.toString('utf8') : '';
      recordStream.write(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: redactWireHeaders(req.headers),
        body: bodyText.length > RECORD_BODY_LIMIT
          ? bodyText.slice(0, RECORD_BODY_LIMIT) + '…(truncated)'
          : bodyText,
      }) + '\n');
    } else if (event === 'response' && upstream) {
      recordStream.write(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        status: upstream.statusCode,
        headers: redactWireHeaders(upstream.headers),
      }) + '\n');
    }
  } catch {}
}

async function handleNativeCommandCode(req, res, url) {
  if (!NATIVE_METHODS.has(req.method)) {
    res.setHeader('Allow', [...NATIVE_METHODS].join(', '));
    sendJSON(res, 405, { error: { message: 'Method not allowed', type: 'method_not_allowed' } });
    return;
  }

  let body;
  try {
    body = await readRawBody(req);
  } catch (error) {
    if (error.status === 413) {
      // 超限后不再允许客户端继续占用连接发送数据，响应写完就主动断开。
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    sendJSON(res, error.status || 400, {
      error: { message: error.message, type: 'invalid_request_error' },
    });
    return;
  }

  recordNativeWire('request', req, url, body);

  const abortController = new AbortController();
  req.once('aborted', () => abortController.abort());
  res.once('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const upstream = await forwardNativeToCC({
      apiBase: CFG.apiBase,
      method: req.method,
      requestUrl: `${url.pathname}${url.search}`,
      headers: req.headers,
      body,
      signal: abortController.signal,
      idleTimeoutMs: NATIVE_IDLE_TIMEOUT_MS,
    });
    recordNativeWire('response', req, url, body, upstream);
    const responseHeaders = filterProxyHeaders(upstream.headers);
    for (const [name, value] of Object.entries(responseHeaders)) {
      if (value !== undefined) res.setHeader(name, value);
    }
    res.writeHead(upstream.statusCode || 502, upstream.statusMessage);
    await pipeline(upstream, res);
  } catch (error) {
    if (error.name === 'AbortError') return;
    log('error', 'Native CC proxy error', {
      method: req.method,
      path: url.pathname,
      error: error.message,
    });
    if (!res.headersSent) {
      sendJSON(res, 502, { error: { message: 'Command Code upstream unavailable', type: 'proxy_error' } });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
}

function getApiKey(headers) {
  // 兼容两种认证方式：
  // 1. OpenAI 风格：Authorization: Bearer user_xxx
  // 2. Anthropic 风格（Claude Code / Anthropic SDK 标准）：x-api-key: user_xxx
  const auth = headers['authorization'] || headers['Authorization'] || headers['x-api-key'] || '';
  // 从字符串中提取第一个 user_ 开头的 Key，自动清理空格/引号/多余路径
  const match = auth.match(/user_[a-zA-Z0-9_-]+/);
  if (!match) return null;
  return match[0];
}

// ── 全局鉴权 ────────────────────────────────────────
// 除豁免路径外，所有请求都必须携带 Authorization: Bearer user_xxx 头。
// 只判断“是否携带正确格式的请求头”，不校验 Key 有效性（有效性与否由 CC 后端判断）。
const UNAUTHORIZED_BODY = {
  success: false,
  error: {
    code: 'UNAUTHORIZED',
    status: 401,
    message: "Invalid 'Authorization' header or token.",
    docs: 'https://commandcode.ai/docs/reference/errors/unauthorized',
  },
};

// 豁免路径：模型列表（匿名可访问）、健康检查、根路径。
function isAuthExemptPath(pathname) {
  return pathname === '/v1/models' || pathname === '/health' || pathname === '/';
}

function sendUnauthorized(res) {
  sendJSON(res, 401, UNAUTHORIZED_BODY);
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (error) {
    if (error.status === 413) {
      // 超限后不再允许客户端继续占用连接发送数据，响应写完就主动断开。
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    sendJSON(res, error.status === 413 ? 413 : 400, {
      error: { message: error.status === 413 ? error.message : 'Invalid JSON body', type: 'invalid_request_error' },
    });
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> header', type: 'auth_error' } });
    return;
  }

  const validationError = validateOpenAIRequest(openaiReq);
  if (validationError) {
    sendJSON(res, 400, {
      error: {
        message: validationError.message,
        type: 'invalid_request_error',
        param: validationError.field,
      },
    });
    return;
  }

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();
  const requestMetrics = beginRequest(metrics, { path: '/v1/chat/completions', model, stream });

  // 构建 CC 请求体：threadId 优先取客户端传入，未传时用会话 ID
  // （真实 CLI 的 threadId 与 x-session-id 相同，均为 UUID，整个会话不变）。
  const sessionId = state.getSessionId(req.headers, apiKey);
  const threadId = getThreadId(req.headers, openaiReq) || sessionId;
  const serverConfig = buildFakeWorkspace(`${CFG.fingerprintSalt}:${apiKey}`);
  const projectSlug = CFG.projectSlug || projectSlugFromWorkspace(serverConfig);
  const traceId = generateTraceId();
  const ccBody = buildCcRequest(openaiReq, {
    threadId,
    mode: CFG.mode,
    permissionMode: CFG.permissionMode,
    // 按 key 派生稳定伪工作区，项目路径与请求头中的 slug 保持一致。
    serverConfig,
  });

  // debug 级别打印发送给 CC 的 messages 结构（只含 role 与 content 类型，不含文本内容）。
  log('debug', 'CC messages structure (OpenAI)', {
    roles: ccBody.params.messages.map(message => message.role),
    contentTypes: ccBody.params.messages.map(message =>
      (message.content || []).map(part => part.type)),
    paramsKeys: Object.keys(ccBody.params),
  });

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  const abortController = new AbortController();
  let aborted = false;
  let partialOutputLength = 0;
  // 以下统计变量提升到 try 外声明：外层 catch 的日志分支会引用它们，
  // 若声明在 try 块内，catch 中访问会抛 ReferenceError 并破坏错误响应。
  let reader = null;
  let translator = null;
  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let keepaliveCount = 0;

  try {
    // 首次初始化（fingerprint）
    await ensureInitialized(apiKey, abortController.signal);
    // 转发到 CC API（传入客户端 headers，用于提取 session ID）
    const forwardRequest = () => forwardToCC({
      apiBase: CFG.apiBase,
      projectSlug,
      commandCodeVersion: CC_VERSION,
      cliEnvironment: CFG.cliEnvironment,
      userAgent: CFG.userAgent,
      tasteLearningEnabled: CFG.tasteLearningEnabled,
      oauthEnforced: CFG.oauthEnforced,
      cmdZdr: CFG.cmdZdr,
      ossPrimaryProvider: CFG.ossPrimaryProvider,
      body: ccBody,
      apiKey,
      incomingHeaders: req.headers,
      sessionId: threadId,
      traceId,
      signal: abortController.signal,
      getSessionId: state.getSessionId,
    });
    let ccResponse = await forwardRequest();

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status });
      requestMetrics.finish(
        ccResponse.status === 429 ? 'upstream_429'
          : ccResponse.status === 402 ? 'upstream_402'
            : 'upstream_error',
      );
      const mapped = mapCcError(ccResponse.status, errorText, ccResponse.headers.get('retry-after'));
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      requestMetrics.finish('client_disconnect');
      const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
        : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
        : 'client-hangup';
      abortController.signal.aborted || log('warn', 'Client disconnected', {
        path: '/v1/chat/completions',
        model, completionId, reason,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
        bytesSent: bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        keepaliveCount,
        inputTokens: translator?.inputTokens ?? 0,
        outputTokens: translator?.outputTokens ?? 0,
        cachedInputTokens: translator?.cachedInputTokens ?? 0,
      });
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
        try {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {}
        try { abortController.abort(); } catch {}
      }
    });

    if (stream) {
      // ── 流式响应 ──
      translator = createSseTranslator(model, completionId, created);
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      let continuationCount = 0;
      // 统一的 SSE 响应头写入点：主循环、尾行解析、结尾 flush 共用，
      // 避免某条路径只置标志不写头，导致客户端收到无 Content-Type 的 chunked 响应。
      const ensureStarted = () => {
        if (started) return;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        started = true;
        // 首个流式内容事件到达客户端的时刻，即首 token 延迟。
        requestMetrics.markFirstToken();
      };

      try {
        while (!aborted) {
          let buffer = '';
          const decoder = new TextDecoder();
          reader = ccResponse.body.getReader();

          while (true) {
            const result = await readWithTimeout(reader, STREAM_IDLE_TIMEOUT_MS);
            const { done, value } = result;
            if (done) {
              buffer += decoder.decode();
              break;
            }
            if (aborted) break;
            bytesReceived += value.length;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            let hadOutput = false;
            for (const line of lines) {
              const events = translator.parseLine(line);
              if (events) {
                ensureStarted();
                for (const evt of events) await writeSse(res, evt);
                hadOutput = true;
              }
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
            // 静默事件期间发 keepalive，防止客户端超时断开。
            if (started && !hadOutput) { await writeSse(res, ': keepalive\n\n'); keepaliveCount++; }
          }

          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              ensureStarted();
              for (const evt of events) await writeSse(res, evt);
            }
          }

          // 1.53.1 遇到 pause_turn 时最多继续请求 5 次（bundle 常量 Ph=5），并复用同一线程。
          if (translator.shouldContinue && continuationCount < 5 && !aborted) {
            continuationCount += 1;
            translator.beginContinuation();
            ccResponse = await forwardRequest();
            if (!ccResponse.ok) {
              throw new Error(`CC continuation failed with status ${ccResponse.status}`);
            }
            continue;
          }
          break;
        }

        if (!aborted) {
          if (translator.hasError) throw new Error('Upstream stream reported an error');
          if (!translator.finished) throw new Error('Upstream stream ended without finish event');

          // 成功完成请求，重置连续超时计数。
          state.resetTimeout(apiKey);
          // 输出 token 为 0 时记为错误，避免下游异常计费。
          if (translator.outputTokens === 0) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            requestMetrics.finish('empty_output');
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            await writeSse(res, `data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`);
          } else {
            ensureStarted();
            await writeSse(res, translator.getDoneEvent());
            requestMetrics.finish('ok');
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          requestMetrics.finish('client_disconnect');
          try { reader.cancel(); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          requestMetrics.finish('timeout');
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel(); } catch {}
          try { abortController.abort(); } catch {} // 打断 CC 上游，避免浪费 token
          const timeoutMsg = getTimeoutMessage(apiKey);
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
            try { res.destroy(); } catch {}
          }
        } else {
          requestMetrics.finish('proxy_error');
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let fullText = '';
      let reasoningContent = '';
      let finishReason = 'stop';
      let usage = null;
      let stepUsage = null;
      let toolCalls = null;
      let sawFinish = false;
      let shouldContinue = false;
      let streamError = false;
      let continuationCount = 0;

      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                if (event.providerExecuted) break;
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    // 1.31.0 的 tool-call 事件同时支持 input 或 args 字段。
                    arguments: typeof (event.input ?? event.args) === 'string'
                      ? (event.input ?? event.args)
                      : JSON.stringify(event.input ?? event.args ?? {}),
                  },
                });
                break;
              case 'finish-step':
                lastCcEvent = event.type;
                // finish 事件缺 totalUsage 时回退使用 step 级 usage，避免有正文却误判零输出。
                if (event.usage && !stepUsage) stepUsage = event.usage;
                break;
              case 'finish':
                lastCcEvent = event.type;
                if (String(event.rawFinishReason || event.finishReason || '').toLowerCase() === 'pause_turn') {
                  shouldContinue = true;
                  break;
                }
                shouldContinue = false;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || event.rawFinishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                streamError = true;
                log('warn', 'CC stream error (non-stream)', { message: event.error?.message || event.message });
                break;
              // 1.31.0 新增：服务端直接执行的工具结果。OpenAI 协议没有对应概念，静默跳过。
              case 'tool-result':
                lastCcEvent = event.type;
                break;
              // 1.31.0：abort 事件表示上游主动终止，视为正常结束。
              case 'abort':
                lastCcEvent = event.type;
                sawFinish = true;
                // abort 是合法终止，不算零输出；有文本时避免触发零输出防护。
                if (fullText && !usage) usage = { inputTokens: 0, outputTokens: 1 };
                break;
              case 'reasoning-start': case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      while (true) {
        buf = '';
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();
        while (true) {
          const result = await readWithTimeout(reader, NONSTREAM_IDLE_TIMEOUT_MS);
          const { done, value } = result;
          if (done) {
            buf += decoder.decode();
            break;
          }
          bytesReceived += value.length;
          buf += decoder.decode(value, { stream: true });
          processLines();
        }
        processLines();
        if (buf.trim()) {
          const tail = buf;
          buf = `${tail}\n`;
          processLines();
        }

        if (shouldContinue && continuationCount < 5) {
          continuationCount += 1;
          shouldContinue = false;
          ccResponse = await forwardRequest();
          if (!ccResponse.ok) {
            throw new Error(`CC continuation failed with status ${ccResponse.status}`);
          }
          continue;
        }
        break;
      }

      if (streamError) throw new Error('Upstream stream reported an error');
      if (!sawFinish) throw new Error('Upstream stream ended without finish event');
      // finish 事件未带 totalUsage 时回退到 step 级 usage，避免有正文却按零输出处理。
      if (!usage && stepUsage) usage = stepUsage;
      partialOutputLength = fullText.length;

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        requestMetrics.finish('empty_output');
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      requestMetrics.finish('ok');
      state.resetTimeout(apiKey);
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: finishReason,
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: getCachedInputTokens(usage) },
      };
    })(),
      });
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      requestMetrics.finish('client_disconnect');
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      requestMetrics.finish('timeout');
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: partialOutputLength,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      const timeoutMsg = getTimeoutMessage(apiKey);
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
    } else {
      requestMetrics.finish('proxy_error');
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
    }
  }
}

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch (error) {
    if (error.status === 413) {
      res.setHeader('Connection', 'close');
      res.once('finish', () => req.destroy());
    }
    sendAnthropicError(res, error.status === 413 ? 413 : 400, 'invalid_request_error',
      error.status === 413 ? error.message : 'Invalid JSON body');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> header' } });
    return;
  }

  const validationError = validateAnthropicRequest(anthropicReq);
  if (validationError) {
    // 打印原始请求的消息结构（只含 role 与 content 类型，不含文本/Key），
    // 用于排查 Claude Code 发送了合法白名单之外的 role。
    log('warn', 'Anthropic validation failed', {
      field: validationError.field,
      roles: (anthropicReq.messages || []).map(message => message.role),
      contentTypes: (anthropicReq.messages || []).map(message =>
        Array.isArray(message.content)
          ? message.content.map(part => part?.type)
          : typeof message.content),
      model: anthropicReq.model,
      hasThinking: Boolean(anthropicReq.thinking),
      systemType: Array.isArray(anthropicReq.system) ? 'array' : typeof anthropicReq.system,
    });
    sendAnthropicError(res, 400, 'invalid_request_error', validationError.message);
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';
  const requestMetrics = beginRequest(metrics, { path: '/v1/messages', model, stream });

  // Convert Anthropic → OpenAI → CC：threadId 规则与 OpenAI 端点一致。
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const sessionId = state.getSessionId(req.headers, apiKey);
  const threadId = getThreadId(req.headers, anthropicReq) || sessionId;
  const serverConfig = buildFakeWorkspace(`${CFG.fingerprintSalt}:${apiKey}`);
  const projectSlug = CFG.projectSlug || projectSlugFromWorkspace(serverConfig);
  const traceId = generateTraceId();
  const ccBody = buildCcRequest(openaiReq, {
    threadId,
    mode: CFG.mode,
    permissionMode: CFG.permissionMode,
    serverConfig,
  });

  // debug 级别打印发送给 CC 的 messages 结构（只含 role 与 content 类型，不含文本内容），
  // 用于排查 CC 后端校验错误（如 "messages[1].role is invalid"）。
  log('debug', 'CC messages structure (Anthropic)', {
    roles: ccBody.params.messages.map(message => message.role),
    contentTypes: ccBody.params.messages.map(message =>
      (message.content || []).map(part => part.type)),
    paramsKeys: Object.keys(ccBody.params),
  });

  const abortController = new AbortController();
  let aborted = false;
  let partialOutputLength = 0;
  // 同 handleChatCompletions：统计变量提升到 try 外声明，供外层 catch 分支引用。
  let reader = null;
  const startTime = Date.now();
  let messageId = '';
  let bytesReceived = 0;
  let lastCcEvent = '';

  try {
    // 首次初始化（fingerprint）
    await ensureInitialized(apiKey, abortController.signal);
    const forwardRequest = () => forwardToCC({
      apiBase: CFG.apiBase,
      projectSlug,
      commandCodeVersion: CC_VERSION,
      cliEnvironment: CFG.cliEnvironment,
      userAgent: CFG.userAgent,
      tasteLearningEnabled: CFG.tasteLearningEnabled,
      oauthEnforced: CFG.oauthEnforced,
      cmdZdr: CFG.cmdZdr,
      ossPrimaryProvider: CFG.ossPrimaryProvider,
      body: ccBody,
      apiKey,
      incomingHeaders: req.headers,
      sessionId: threadId,
      traceId,
      signal: abortController.signal,
      getSessionId: state.getSessionId,
    });
    let ccResponse = await forwardRequest();

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status });
      requestMetrics.finish(
        ccResponse.status === 429 ? 'upstream_429'
          : ccResponse.status === 402 ? 'upstream_402'
            : 'upstream_error',
      );
      const mapped = mapCcError(ccResponse.status, errorText, ccResponse.headers.get('retry-after'));
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      requestMetrics.finish('client_disconnect');
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止事件，避免下游自行估算 token
        try {
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        } catch {}
        try { abortController.abort(); } catch {}
      }
      log('warn', 'Client disconnected', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
      });
    });

    if (stream) {
      // ── 流式 Anthropic SSE ──
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      const buf = [];

      let ctx;
      let continuationCount = 0;
      let pingTimer = null;
      // Anthropic 协议标准的 ping 事件作为 keepalive，
      // 避免工具输入等长静默期没有任何字节导致客户端超时断开。
      const startPing = () => {
        if (pingTimer) return;
        pingTimer = setInterval(() => {
          if (!res.writableEnded) {
            try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch {}
          }
        }, 15000);
        pingTimer.unref?.();
      };
      try {
        messageId = 'msg_' + randomUUID().slice(0, 12);
        ctx = {
          bytesReceived: 0,
          lastCcEvent: '',
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          finished: false,
          shouldContinue: false,
          continuation: false,
        };

        while (!aborted) {
          ctx.continuation = continuationCount > 0;
          const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx, log);
          for await (const event of generator) {
            if (aborted) break;
            if (!started) {
              buf.push(event);
              // 确认有真实内容后才发 200 header。thinking 也是真实内容：
              // 思考优先的响应不必等到首个文本/工具事件才响应客户端。
              if (event.includes('"text_delta"') || event.includes('"tool_use"') || event.includes('"thinking_delta"')) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
                for (const ev of buf) await writeSse(res, ev);
                buf.length = 0;
                startPing();
                // 首个流式内容事件到达客户端的时刻，即首 token 延迟。
                requestMetrics.markFirstToken();
              }
            } else {
              await writeSse(res, event);
            }
          }

          if (ctx.shouldContinue && continuationCount < 5 && !aborted) {
            continuationCount += 1;
            ctx.shouldContinue = false;
            ctx.finished = false;
            ccResponse = await forwardRequest();
            if (!ccResponse.ok) {
              throw new Error(`CC continuation failed with status ${ccResponse.status}`);
            }
            continue;
          }
          break;
        }

        if (!aborted) {
          if (!ctx.finished) throw new Error('Upstream stream ended without finish event');
          state.resetTimeout(apiKey);
          if (ctx.outputTokens === 0) {
            try { abortController.abort(); } catch {}
            requestMetrics.finish('empty_output');
            if (!started) {
              sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            for (const ev of buf) { await writeSse(res, ev); }
            buf.length = 0;
          } else {
            if (!started) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              started = true;
            }
            for (const ev of buf) await writeSse(res, ev);
            buf.length = 0;
            requestMetrics.finish('ok');
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          requestMetrics.finish('client_disconnect');
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          requestMetrics.finish('timeout');
          log('warn', 'Stream idle timeout', {
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            const timeoutMsg = getTimeoutMessage(apiKey);
            sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
            return;
          }
          if (!res.writableEnded) {
            const timeoutMsg = getTimeoutMessage(apiKey);
            try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
            try { res.destroy(); } catch {}
          }
        } else {
          requestMetrics.finish('proxy_error');
          log('error', 'Anthropic stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
            return;
          }
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
          }
        }
      }

      if (pingTimer) clearInterval(pingTimer);
      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      messageId = 'msg_' + randomUUID().slice(0, 12);
      let fullText = '';
      let reasoningContent = '';
      let toolCalls = null;
      let finishReason = 'stop';
      let usage = null;
      let stepUsage = null;
      let sawFinish = false;
      let shouldContinue = false;
      let streamError = false;
      let continuationCount = 0;

      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              // 推理内容累积后写入响应的 thinking block，与流式路径行为一致。
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'tool-call':
                if (event.providerExecuted) break;
                lastCcEvent = event.type;
                (toolCalls = toolCalls || []).push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    // 1.31.0 的 tool-call 事件同时支持 input 或 args 字段。
                    arguments: typeof (event.input ?? event.args) === 'string'
                      ? (event.input ?? event.args)
                      : JSON.stringify(event.input ?? event.args ?? {}),
                  },
                });
                break;
              case 'finish-step':
                lastCcEvent = event.type;
                // finish 事件缺 totalUsage 时回退使用 step 级 usage，避免有正文却误判零输出。
                if (event.usage && !stepUsage) stepUsage = event.usage;
                break;
              case 'finish':
                lastCcEvent = event.type;
                if (String(event.rawFinishReason || event.finishReason || '').toLowerCase() === 'pause_turn') {
                  shouldContinue = true;
                  break;
                }
                shouldContinue = false;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || event.rawFinishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                streamError = true;
                log('warn', 'CC error (Anthropic non-stream)', { message: event.error?.message || event.message });
                break;
              // 1.31.0 新增：服务端直接执行的工具结果。Anthropic 协议没有对应概念，静默跳过。
              case 'tool-result':
                lastCcEvent = event.type;
                break;
              // 1.31.0：abort 事件表示上游主动终止，视为正常结束。
              case 'abort':
                lastCcEvent = event.type;
                sawFinish = true;
                // abort 是合法终止，不算零输出；有文本时避免触发零输出防护。
                if (fullText && !usage) usage = { inputTokens: 0, outputTokens: 1 };
                break;
              case 'reasoning-start': case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      while (true) {
        buf = '';
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();
        while (true) {
          const result = await readWithTimeout(reader, NONSTREAM_IDLE_TIMEOUT_MS);
          const { done, value } = result;
          if (done) {
            buf += decoder.decode();
            break;
          }
          bytesReceived += value.length;
          buf += decoder.decode(value, { stream: true });
          processLines();
        }
        processLines();
        if (buf.trim()) {
          const tail = buf;
          buf = `${tail}\n`;
          processLines();
        }

        if (shouldContinue && continuationCount < 5) {
          continuationCount += 1;
          shouldContinue = false;
          ccResponse = await forwardRequest();
          if (!ccResponse.ok) {
            throw new Error(`CC continuation failed with status ${ccResponse.status}`);
          }
          continue;
        }
        break;
      }

      if (streamError) throw new Error('Upstream stream reported an error');
      if (!sawFinish) throw new Error('Upstream stream ended without finish event');
      // finish 事件未带 totalUsage 时回退到 step 级 usage，避免有正文却按零输出处理。
      if (!usage && stepUsage) usage = stepUsage;
      partialOutputLength = fullText.length;

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        requestMetrics.finish('empty_output');
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      requestMetrics.finish('ok');
      state.resetTimeout(apiKey);
      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, reasoningContent));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      requestMetrics.finish('client_disconnect');
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      requestMetrics.finish('timeout');
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: partialOutputLength,
      });
      try { reader?.cancel(); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      const timeoutMsg = getTimeoutMessage(apiKey);
      res.setHeader('Retry-After', '5');
      sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
    } else {
      requestMetrics.finish('proxy_error');
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
    }
  }
}

// ── 官方模型列表 ────────────────────────────────────

function createModelsError(status, message, body) {
  const error = new Error(message);
  error.status = status;
  error.body = body || {
    error: { message, type: status === 401 ? 'authentication_error' : 'upstream_error' },
  };
  return error;
}

async function fetchModels(apiKey) {
  const cachedModels = state.getCachedModels(apiKey, CFG.modelRefreshIntervalMs);
  if (cachedModels) return cachedModels;

  if (!CFG.useProviderModels) {
    throw createModelsError(503, 'Provider models are disabled by configuration');
  }

  try {
    const response = await fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: buildCommandCodeHeaders({
        apiKey,
        commandCodeVersion: CC_VERSION,
        cliEnvironment: CFG.cliEnvironment,
        userAgent: CFG.userAgent,
        tasteLearningEnabled: CFG.tasteLearningEnabled,
        oauthEnforced: CFG.oauthEnforced,
        cmdZdr: CFG.cmdZdr,
        ossPrimaryProvider: CFG.ossPrimaryProvider,
        traceparent: generateTraceparent(),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw createModelsError(
        response.status,
        `Provider models request failed with status ${response.status}`,
        data,
      );
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.data)) {
      throw createModelsError(502, 'Provider models response has an invalid format');
    }

    // 保留官方完整 JSON，只校验 data 为模型数组，不再构造本地回退列表。
    state.setCachedModels(apiKey, data);
    log('info', 'Fetched official models from Provider API', { count: data.data.length });
    return data;
  } catch (e) {
    if (e.status) throw e;
    log('warn', 'Provider models fetch failed', { error: e.message });
    throw createModelsError(502, `Provider models request failed: ${e.message}`);
  }
}

async function handleModels(req, res) {
  const apiKey = getApiKey(req.headers);
  try {
    const models = await fetchModels(apiKey);
    // 官方接口支持匿名访问，响应原样返回，避免代理层修改模型字段或遗漏新字段。
    sendJSON(res, 200, models);
  } catch (error) {
    log('warn', 'Models endpoint failed', {
      status: error.status || 502,
      message: error.message,
    });
    sendJSON(res, error.status || 502, error.body || {
      error: { message: error.message, type: 'upstream_error' },
    });
  }
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 用固定 base 解析 URL：客户端发来的 Host 头不参与解析，
  // 畸形 Host 不会让这里抛异常导致请求无响应挂死。
  const url = new URL(req.url, 'http://proxy.invalid');

  // 全局请求头校验：除豁免路径外都必须携带 Authorization 头，否则返回 UNAUTHORIZED。
  if (!isAuthExemptPath(url.pathname) && !getApiKey(req.headers)) {
    sendUnauthorized(res);
    return;
  }

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (url.pathname === '/stats' && req.method === 'GET') {
      // 指标数据接口：需要认证（复用全局 user_ Key 校验），快照仅存内存。
      sendJSON(res, 200, metrics.snapshot());
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else if (isCommandCodeNativePath(url.pathname)) {
      await handleNativeCommandCode(req, res, url);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    // 兜底 catch 必须落日志：这里曾因 catch 分支引用 try 内变量抛 ReferenceError，
    // 却因无日志而长期不可见。
    log('error', 'Request handler error', { path: url.pathname, message: e.message });
    if (!res.headersSent) sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
    else if (!res.destroyed) res.destroy(e);
  }
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://proxy.invalid');
  } catch {
    socket.destroy();
    return;
  }

  if (!isCommandCodeNativePath(url.pathname)) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }

  // WebSocket 隧道同样要求携带 Authorization 头。
  if (!getApiKey(req.headers)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }

  // WebSocket 只建立到固定的 Command Code API origin，path/query 原样转交。
  tunnelNativeWebSocket({
    apiBase: CFG.apiBase,
    requestUrl: `${url.pathname}${url.search}`,
    headers: req.headers,
    clientSocket: socket,
    clientHead: head,
  });
});

// 全局兜底：abort 触发的异步 rejection 不会让进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // 客户端断连触发的 abort — 预期行为，静默处理
    log('info', 'Aborted request cleaned up');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

// 优雅停机：停止接收新连接并等待在途请求完成；流式响应可能长时间占用连接，10s 后强制退出。
function shutdown(signal) {
  log('info', 'Shutting down', { signal });
  state.stop?.();
  server.closeIdleConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(CFG.port, CFG.host, () => {
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: 'provider-api-only',
    session: '12h + 1h jitter, per API key',
    logFile: CFG.logFile || '(console only)',
  });
  if (!CFG.apiKey) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }
});
