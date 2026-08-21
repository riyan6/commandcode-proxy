/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import { randomUUID } from 'crypto';
import { appendFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { loadConfig } from './src/config.mjs';
import { createStateStore } from './src/state.mjs';
import { generateFingerprint } from './src/fingerprint.mjs';
import { validateAnthropicRequest, validateOpenAIRequest } from './src/validation.mjs';
import {
  buildCommandCodeHeaders,
  filterProxyHeaders,
  forwardNativeToCC,
  forwardToCC,
  generateTraceparent,
  isCommandCodeNativePath,
  tunnelNativeWebSocket,
} from './src/cc-client.mjs';
import {
  buildAnthropicResponse,
  buildCcRequest,
  convertAnthropicToOpenAI,
  createAnthropicSseTranslator,
  mapFinishReason,
  normalizeUsage,
} from './src/adapters.mjs';

const CFG = loadConfig();

// 请求体和字段转换固定按 command-code@1.31.0 实现，避免协议随上游版本漂移。
// 发送给上游的 x-command-code-version 头与实现基线保持一致（protocolVersion），
// 不再跟随 npm latest，避免“头版本新但特性旧”被后端识别出代理伪装。
const CC_VERSION = CFG.protocolVersion;

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB — 请求体大小上限
const STREAM_IDLE_TIMEOUT_MS = 30000;   // 30s — 流式无新数据中断
const NONSTREAM_IDLE_TIMEOUT_MS = 90000; // 90s — 非流式超时更宽容
const NATIVE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// 连续 3 次超时才提醒压缩上下文，计数按 API Key 隔离。
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
const LOG_LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, msg, data) {
  const configuredLevel = LOG_LEVEL_ORDER[CFG.logLevel] ?? LOG_LEVEL_ORDER.info;
  if ((LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info) < configuredLevel) return;
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, line + '\n', 'utf-8'); } catch {}
  }
}

// 运行时状态由独立模块集中管理，超时和模型缓存按 API Key 隔离。
const state = createStateStore({
  generateFingerprint: apiKey => generateFingerprint(apiKey, { salt: CFG.fingerprintSalt }),
  log,
});

function getTimeoutMessage(apiKey) {
  const timeoutCount = state.recordTimeout(apiKey);
  return timeoutCount >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
    ? 'Response timeout - try reducing context length (summarize earlier messages)'
    : 'Response timeout - request timed out';
}

// ── 初始化预请求（fingerprint，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动

async function ensureInitialized(apiKey, signal, incomingHeaders = {}) {
  const keyState = state.getOrCreateKeyState(apiKey);
  const now = Date.now();
  if (now < keyState.nextInitAt) return;

  try {
    // 指纹和生成请求使用同一会话标识及公共 CLI 请求头。
    // 1.31.0 已移除 /alpha/lifecycle-events 端点（改为 telemetry 内部事件），
    // 这里只保留 fingerprint/record 初始化。
    const sessionId = state.getSessionId(incomingHeaders, apiKey);
    const headers = buildCommandCodeHeaders({
      apiKey,
      commandCodeVersion: CC_VERSION,
      cliEnvironment: CFG.cliEnvironment,
      userAgent: CFG.userAgent,
      projectSlug: CFG.projectSlug,
      sessionId,
      traceparent: generateTraceparent(),
      tasteLearningEnabled: CFG.tasteLearningEnabled,
      oauthEnforced: CFG.oauthEnforced,
      cmdZdr: CFG.cmdZdr,
      ossPrimaryProvider: CFG.ossPrimaryProvider,
    });
    const fingerprint = keyState.fingerprint || {};

    const response = await fetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
      method: 'POST', headers, signal,
      body: JSON.stringify(fingerprint),
    });
    if (!response.ok) log('warn', 'Fingerprint record failed', { status: response.status });
    else log('info', 'Fingerprint recorded');

    // 成功：8h + 2h 随机抖动
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    keyState.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    log('info', 'Fingerprint next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h` });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint refresh error, will retry next request', { error: e.message });
  }
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

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
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

function mapCcError(ccStatus, ccBody) {
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

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      body: {
        error: { message, type: 'rate_limit_error' },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, body: { error: { message, type: mapped.type } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', c => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy(new Error('Request body too large'));
        reject(new Error('Request body exceeds 10MB limit'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
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
    });
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
  } catch {
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
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

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq, {
    threadId: getThreadId(req.headers, openaiReq),
    mode: CFG.mode,
    permissionMode: CFG.permissionMode,
  });

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  const abortController = new AbortController();
  let aborted = false;
  let partialOutputLength = 0;

  try {
    // 首次初始化（fingerprint）
    await ensureInitialized(apiKey, abortController.signal, req.headers);
    // 转发到 CC API（传入客户端 headers，用于提取 session ID）
    const forwardRequest = () => forwardToCC({
      apiBase: CFG.apiBase,
      projectSlug: CFG.projectSlug,
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
      signal: abortController.signal,
      getSessionId: state.getSessionId,
    });
    let ccResponse = await forwardRequest();

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    let reader = null;
    let translator = null;
    const startTime = Date.now(); let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0;

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
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

      try {
        while (!aborted) {
          let buffer = '';
          const decoder = new TextDecoder();
          reader = ccResponse.body.getReader();

          while (true) {
            const result = await Promise.race([
              reader.read(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), STREAM_IDLE_TIMEOUT_MS)
              ),
            ]);
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
                if (!started) {
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                  });
                  started = true;
                }
                for (const evt of events) res.write(evt);
                hadOutput = true;
              }
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
            // 静默事件期间发 keepalive，防止客户端超时断开。
            if (started && !hadOutput) { try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {} }
          }

          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              if (!started) started = true;
              for (const evt of events) res.write(evt);
            }
          }

          // 最新 CLI 遇到 pause_turn 时最多继续请求两次，并复用同一线程。
          if (translator.shouldContinue && continuationCount < 2 && !aborted) {
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
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
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
            res.write(translator.getDoneEvent());
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          try { reader.cancel(); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
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
              case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
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
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
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

        if (shouldContinue && continuationCount < 2) {
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
      partialOutputLength = fullText.length;

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

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
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
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
  } catch {
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> header' } });
    return;
  }

  const validationError = validateAnthropicRequest(anthropicReq);
  if (validationError) {
    sendAnthropicError(res, 400, 'invalid_request_error', validationError.message);
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';

  // Convert Anthropic → OpenAI → CC
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq, {
    threadId: getThreadId(req.headers, anthropicReq),
    mode: CFG.mode,
    permissionMode: CFG.permissionMode,
  });

  const abortController = new AbortController();
  let aborted = false;
  let partialOutputLength = 0;

  try {
    let reader = null;
    // 首次初始化（fingerprint）
    await ensureInitialized(apiKey, abortController.signal, req.headers);
    const forwardRequest = () => forwardToCC({
      apiBase: CFG.apiBase,
      projectSlug: CFG.projectSlug,
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
      signal: abortController.signal,
      getSessionId: state.getSessionId,
    });
    let ccResponse = await forwardRequest();

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status });
      const mapped = mapCcError(ccResponse.status, errorText);
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }
    const startTime = Date.now();
    let messageId = '';

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
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
              // 确认有真实内容后才发 200 header。
              if (event.includes('"text_delta"') || event.includes('"tool_use"')) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
                for (const ev of buf) res.write(ev);
                buf.length = 0;
              }
            } else {
              res.write(event);
            }
          }

          if (ctx.shouldContinue && continuationCount < 2 && !aborted) {
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
            if (!started) {
              sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            for (const ev of buf) { try { res.write(ev); } catch {} }
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
            for (const ev of buf) res.write(ev);
            buf.length = 0;
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
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

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      const messageId = 'msg_' + randomUUID().slice(0, 12);
      let fullText = '';
      let toolCalls = null;
      let finishReason = 'stop';
      let usage = null;
      let sawFinish = false;
      let shouldContinue = false;
      let streamError = false;
      let continuationCount = 0;
      let bytesReceived = 0; let lastCcEvent = '';

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
              case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
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
          const result = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), NONSTREAM_IDLE_TIMEOUT_MS)
            ),
          ]);
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

        if (shouldContinue && continuationCount < 2) {
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
      partialOutputLength = fullText.length;

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      state.resetTimeout(apiKey);
      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
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

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

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
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else if (isCommandCodeNativePath(url.pathname)) {
      await handleNativeCommandCode(req, res, url);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
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
