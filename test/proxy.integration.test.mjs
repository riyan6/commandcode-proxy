import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 故意使用不存在的嵌套目录：验证代理会自动创建父目录再写抓包文件。
const wireRecordPath = resolve(projectRoot, 'test', '.wire-record-dir', 'inner', 'record.jsonl');
let upstream;
let proxyProcess;
let proxyUrl;
let lastGenerateBody = null;
let lastGenerateHeaders = null;
let lastFingerprintBody = null;
let lastModelsHeaders = null;
let lastNativeRequest = null;
let lastWebSocketRequest = null;
let lastWebSocketClosed = null;
const generateCallCounts = new Map();
const fingerprintCallCounts = new Map();
let proxyOutput = '';

function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen(server.address().port);
    });
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // 代理进程启动需要一点时间，继续轮询。
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('代理进程未能在测试超时时间内启动');
}

before(async () => {
  rmSync(wireRecordPath, { recursive: true, force: true });
  upstream = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/alpha/fingerprint/record') {
      lastFingerprintBody = JSON.parse(bodyText);
      const fingerprintAuthKey = req.headers.authorization || '';
      const fingerprintCount = (fingerprintCallCounts.get(fingerprintAuthKey) || 0) + 1;
      fingerprintCallCounts.set(fingerprintAuthKey, fingerprintCount);
      // 指定 key 模拟上报失败，验证代理的短退避重试逻辑。
      if (fingerprintAuthKey.includes('user_fingerprint_fail')) {
        res.writeHead(500);
        res.end('{}');
        return;
      }
      res.writeHead(200);
      res.end('{}');
      return;
    }

    if (req.url === '/alpha/lifecycle-events') {
      res.writeHead(200);
      res.end('{}');
      return;
    }

    if (req.url === '/provider/v1/models') {
      lastModelsHeaders = req.headers;
      res.writeHead(200);
      res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'official-demo-model',
          object: 'model',
          created: 1700000000,
          owned_by: 'official-provider',
          name: 'Official Demo Model',
          context_length: 128000,
        }],
      }));
      return;
    }

    if (req.url === '/alpha/generate') {
      lastGenerateBody = JSON.parse(bodyText);
      lastGenerateHeaders = req.headers;
      const authKey = req.headers.authorization || '';
      // 模拟上游限流：返回 429 + Retry-After 头，验证代理透传限流提示。
      // 必须在通用 writeHead(200) 之前处理，避免二次 writeHead 抛错。
      if (authKey.includes('user_rate_limited')) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '77' });
        res.end(JSON.stringify({ error: { message: 'rate limited by upstream' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const callCount = (generateCallCounts.get(authKey) || 0) + 1;
      generateCallCounts.set(authKey, callCount);
      // 模拟上游挂起：输出首个文本后不结束流，用于客户端断连回归测试。
      if (authKey.includes('user_hang')) {
        res.write('{"type":"start"}\n{"type":"text-delta","text":"部分输出"}\n');
        return;
      }
      // finish 不带 totalUsage、只有 step 级 usage：验证非流式零输出回退逻辑。
      if (authKey.includes('user_step_usage_only')) {
        res.end([
          { type: 'start' },
          { type: 'text-delta', text: 'step usage only' },
          { type: 'finish-step', usage: { inputTokens: 7, outputTokens: 3 } },
          { type: 'finish', finishReason: 'stop' },
        ].map(event => JSON.stringify(event)).join('\n') + '\n');
        return;
      }
      const events = authKey.includes('user_anthropic_thinking')
        ? [
          { type: 'start' },
          { type: 'reasoning-start' },
          { type: 'reasoning-delta', text: '让我想想' },
          { type: 'reasoning-delta', text: '再想想' },
          { type: 'reasoning-end' },
          { type: 'text-start' },
          { type: 'text-delta', text: 'Hello with thinking' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 1 } } },
        ]
        : authKey.includes('user_pause_continuation') && callCount === 1
        ? [
          { type: 'start' },
          { type: 'text-delta', text: '第一段' },
          { type: 'finish', finishReason: 'pause_turn', totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ]
        : authKey.includes('user_tool_result')
        ? [
          { type: 'start' },
          { type: 'tool-call', toolCallId: 'call_tool', toolName: 'lookup', input: { city: 'Shanghai' } },
          // 1.31.0 新增：服务端直接执行的工具结果，代理应静默跳过。
          { type: 'tool-result', toolCallId: 'call_tool', toolName: 'lookup', output: { type: 'text', value: 'server-done' }, providerExecuted: true },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 12, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 2 } } },
        ]
        : authKey.includes('user_abort_event')
        ? [
          { type: 'start' },
          { type: 'text-delta', text: 'partial output' },
          // 1.31.0：abort 事件表示上游主动终止，代理视为正常结束。
          { type: 'abort' },
        ]
        : lastGenerateBody.params.tools?.length > 0
        ? [
          { type: 'start' },
          { type: 'tool-call', toolCallId: 'call_tool', toolName: 'lookup', input: { city: 'Shanghai' } },
          // 1.31.0 的 usage：缓存字段在 inputTokenDetails.cacheReadTokens。
          { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 12, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 2 } } },
        ]
        : [
          { type: 'start' },
          { type: 'text-start' },
          { type: 'text-delta', text: 'Hello from upstream' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 1 } } },
        ];
      res.end(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
      return;
    }

    if (req.url === '/alpha/native-test?mode=raw') {
      lastNativeRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyText,
      };
      res.writeHead(207, {
        'Content-Type': 'application/x-ndjson',
        'X-Native-Response': 'preserved',
        'Retry-After': '17',
      });
      res.write('{"type":"first"}\n');
      res.end('{"type":"second"}\n');
      return;
    }

    if (req.url === '/alpha/native-hang') {
      // 模拟上游挂起：不返回任何响应，验证透传空闲超时。
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  upstream.on('upgrade', (req, socket, head) => {
    lastWebSocketRequest = { url: req.url, headers: req.headers };
    socket.on('error', () => {});
    lastWebSocketClosed = new Promise(resolveClose => socket.once('close', resolveClose));
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade, X-Private-Hop',
      'X-Private-Hop: remove-me',
      'Keep-Alive: timeout=5',
      '',
      '',
    ].join('\r\n'));
    if (head.length > 0) socket.write(head);
    if (req.url.includes('upstream-close')) {
      setImmediate(() => socket.end('final-frame'));
    } else {
      socket.on('data', chunk => socket.write(chunk));
      socket.once('end', () => socket.end());
    }
  });

  const upstreamPort = await listen(upstream);
  const proxyPort = await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });

  proxyUrl = `http://127.0.0.1:${proxyPort}`;
  proxyProcess = spawn(process.execPath, ['proxy.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(proxyPort),
      HOST: '127.0.0.1',
      CC_API_BASE: `http://127.0.0.1:${upstreamPort}`,
      CC_USE_PROVIDER_MODELS: 'true',
      LOG_LEVEL: 'error',
      // 指纹上报失败后的退避缩短到 1ms，便于测试短退避重试逻辑。
      CC_INIT_RETRY_MS: '1',
      // 原生透传空闲超时缩短到 50ms，便于测试上游挂起场景。
      CC_NATIVE_IDLE_TIMEOUT_MS: '50',
      // 开启抓包记录，验证 RECORD_WIRE 脱敏行为。
      RECORD_WIRE: wireRecordPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 收集代理进程输出，用于断言异常路径不会泄漏 ReferenceError。
  proxyProcess.stdout.on('data', chunk => { proxyOutput += chunk; });
  proxyProcess.stderr.on('data', chunk => { proxyOutput += chunk; });
  await waitForHealth(proxyUrl);
});

after(async () => {
  if (proxyProcess && proxyProcess.exitCode === null) {
    proxyProcess.kill();
    await once(proxyProcess, 'exit');
  }
  if (upstream) await new Promise(resolveClose => upstream.close(resolveClose));
  rmSync(wireRecordPath, { recursive: true, force: true });
});

test('健康检查和认证错误返回正确状态', async () => {
  const health = await fetch(`${proxyUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');

  const unauthorized = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = await unauthorized.json();
  assert.equal(unauthorizedBody.success, false);
  assert.equal(unauthorizedBody.error.code, 'UNAUTHORIZED');
  assert.equal(unauthorizedBody.error.status, 401);
  assert.match(unauthorizedBody.error.message, /Invalid 'Authorization' header or token/);

  const invalid = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_integration_validation',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'demo-model' }),
  });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /messages/);
});

test('全局鉴权：除 models/health 外所有路径未携带 Authorization 头返回 UNAUTHORIZED', async () => {
  // /v1/messages 未带头 → 401 UNAUTHORIZED
  const messages = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(messages.status, 401);
  const messagesBody = await messages.json();
  assert.equal(messagesBody.error.code, 'UNAUTHORIZED');

  // 原生透传未带头 → 401 UNAUTHORIZED
  const native = await fetch(`${proxyUrl}/alpha/whoami`);
  assert.equal(native.status, 401);

  // 未知路径未带头 → 401 UNAUTHORIZED（先鉴权后路由）
  const unknown = await fetch(`${proxyUrl}/nope`);
  assert.equal(unknown.status, 401);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.code, 'UNAUTHORIZED');

  // 带头的未知路径 → 404
  const unknownAuthed = await fetch(`${proxyUrl}/nope`, {
    headers: { Authorization: 'Bearer user_integration_validation' },
  });
  assert.equal(unknownAuthed.status, 404);

  // OPTIONS 预检不鉴权
  const options = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);

  // WebSocket upgrade 未带头 → 401
  const target = new URL(proxyUrl);
  const socket = connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');
  let wsReceived = '';
  socket.on('data', chunk => { wsReceived += chunk.toString('utf8'); });
  socket.write([
    'GET /alpha/sandbox/stream/unauthorized HTTP/1.1',
    `Host: ${target.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGVzdC1ub25jZQ==',
    '',
    '',
  ].join('\r\n'));
  await once(socket, 'close');
  assert.match(wsReceived, /^HTTP\/1\.1 401 Unauthorized/);
});

test('Command Code 原生 HTTP 路径按原始 method、query、body、status 和流透传', async () => {
  const rawBody = '{\n  "message": "保持原始字节"\n}\n';
  const response = await fetch(`${proxyUrl}/alpha/native-test?mode=raw`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_native_passthrough',
      'Content-Type': 'application/json',
      'x-command-code-version': '1.31.0',
      'x-native-request': 'preserved',
    },
    body: rawBody,
  });

  assert.equal(response.status, 207);
  assert.equal(response.headers.get('x-native-response'), 'preserved');
  assert.equal(response.headers.get('retry-after'), '17');
  assert.equal(await response.text(), '{"type":"first"}\n{"type":"second"}\n');
  assert.equal(lastNativeRequest.method, 'POST');
  assert.equal(lastNativeRequest.url, '/alpha/native-test?mode=raw');
  assert.equal(lastNativeRequest.body, rawBody);
  assert.equal(lastNativeRequest.headers.authorization, 'Bearer user_native_passthrough');
  assert.equal(lastNativeRequest.headers['x-command-code-version'], '1.31.0');
  assert.equal(lastNativeRequest.headers['x-native-request'], 'preserved');
});

test('Command Code 原生代理拒绝非官方 API namespace', async () => {
  const response = await fetch(`${proxyUrl}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_native_validation' },
    body: '{}',
  });
  assert.equal(response.status, 404);
});

test('Command Code 原生代理在请求体超限后返回 413 并关闭连接', async () => {
  const target = new URL(proxyUrl);
  const socket = connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');

  let received = '';
  socket.on('data', chunk => { received += chunk.toString('utf8'); });
  const closed = once(socket, 'close');
  socket.write([
    'POST /alpha/native-test HTTP/1.1',
    `Host: ${target.host}`,
    'Authorization: Bearer user_native_validation',
    `Content-Length: ${10 * 1024 * 1024 + 1}`,
    'Content-Type: application/json',
    '',
    '',
  ].join('\r\n'));
  await closed;

  assert.match(received, /^HTTP\/1\.1 413 Payload Too Large/);
  assert.match(received, /Connection: close/i);
});

test('Command Code 原生 WebSocket upgrade 建立双向隧道', async () => {
  const target = new URL(proxyUrl);
  const socket = connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write([
    'GET /alpha/sandbox/stream/demo-id?token=masked HTTP/1.1',
    `Host: ${target.host}`,
    'Authorization: Bearer user_ws_tunnel',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGVzdC1ub25jZQ==',
    '',
    '',
  ].join('\r\n'));

  let received = '';
  while (!received.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    received += chunk.toString('utf8');
  }
  assert.match(received, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.doesNotMatch(received, /x-private-hop|keep-alive/i);
  assert.equal(lastWebSocketRequest.url, '/alpha/sandbox/stream/demo-id?token=masked');

  socket.write('tunnel-ping');
  const [echo] = await once(socket, 'data');
  assert.equal(echo.toString('utf8'), 'tunnel-ping');
  const closed = new Promise(resolveClose => socket.once('close', resolveClose));
  socket.end();
  await closed;
  await Promise.race([
    lastWebSocketClosed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('上游 WebSocket 未随客户端关闭')), 1000);
      timer.unref?.();
    }),
  ]);
});

test('Command Code 原生 WebSocket 保留上游正常 EOF', async () => {
  const target = new URL(proxyUrl);
  const socket = connect(Number(target.port), target.hostname);
  let socketError = null;
  let received = '';
  socket.on('error', error => { socketError = error; });
  socket.on('data', chunk => { received += chunk.toString('utf8'); });
  await once(socket, 'connect');
  const ended = new Promise(resolveEnd => socket.once('end', resolveEnd));
  socket.write([
    'GET /alpha/sandbox/stream/upstream-close HTTP/1.1',
    `Host: ${target.host}`,
    'Authorization: Bearer user_ws_tunnel',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGVzdC1ub25jZQ==',
    '',
    '',
  ].join('\r\n'));

  await ended;
  assert.equal(socketError, null);
  assert.match(received, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(received, /final-frame$/);
  socket.destroy();
});

test('模型列表保留官方 name 和 context_length 字段', async () => {
  const response = await fetch(`${proxyUrl}/v1/models`, {
    headers: { Authorization: 'Bearer user_integration_models' },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [{
    id: 'official-demo-model',
    object: 'model',
    created: 1700000000,
    owned_by: 'official-provider',
    name: 'Official Demo Model',
    context_length: 128000,
  }]);
});

test('模型列表没有 API Key 时仍直接返回官方数据', async () => {
  const response = await fetch(`${proxyUrl}/v1/models`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [{
    id: 'official-demo-model',
    object: 'model',
    created: 1700000000,
    owned_by: 'official-provider',
    name: 'Official Demo Model',
    context_length: 128000,
  }]);
});

test('OpenAI 流式工具调用和参数透传正常', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_integration_openai',
      'Content-Type': 'application/json',
      'x-thread-id': '123e4567-e89b-12d3-a456-426614174000',
    },
    body: JSON.stringify({
      model: 'demo-model',
      messages: [
        { role: 'developer', content: '你是一个可靠的工具助手' },
        { role: 'user', content: '查询上海天气' },
      ],
      stream: true,
      top_p: 0.25,
      stop: ['END'],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: '查询信息',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /tool_calls/);
  assert.match(body, /call_tool/);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(lastGenerateBody.params.top_p, 0.25);
  assert.deepEqual(lastGenerateBody.params.stop, ['END']);
  assert.equal(lastGenerateBody.params.tools[0].name, 'lookup');
  assert.equal(lastGenerateBody.skills, null);
  assert.equal(lastGenerateBody.memory, null);
  assert.equal(lastGenerateBody.taste, null);
  assert.equal(lastGenerateBody.params.system, '你是一个可靠的工具助手');
  assert.deepEqual(lastGenerateBody.params.messages.map(message => message.role), ['user']);
  assert.ok(lastGenerateBody.params.messages.every(message => Array.isArray(message.content)));
  assert.equal(lastGenerateBody.config.environment, process.platform);
  assert.ok(Array.isArray(lastGenerateBody.config.structure));
  assert.equal(lastGenerateBody.mode, 'agent');
  assert.equal(lastGenerateBody.permissionMode, 'standard');
  assert.equal(lastGenerateBody.threadId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(lastGenerateBody.params.tools[0].type, undefined);
  assert.equal(lastGenerateHeaders['user-agent'], 'cli');
  assert.match(lastGenerateHeaders['x-command-code-version'], /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.match(lastGenerateHeaders['x-session-id'], /^sess_[0-9a-f]{16}$/);
  // projectSlug 默认为空时按会话伪造 slug，而不是向上游暴露固定值 "cc-proxy"。
  assert.match(lastGenerateHeaders['x-project-slug'], /^users-dev-projects-[a-z]+-[0-9a-f]{4}$/);
  assert.equal(lastFingerprintBody.components.runtime, 'cli');
  assert.equal(lastFingerprintBody.components.collectorVersion, 1);
  assert.equal(lastFingerprintBody.components.platform, process.platform);
});

test('Anthropic 流式文本转换正常', async () => {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_integration_anthropic',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'demo-model',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /event: message_start/);
  assert.match(body, /text_delta/);
  assert.match(body, /Hello from upstream/);
  assert.match(body, /event: message_stop/);
});

test('OpenAI 流式 pause_turn 会按同一会话继续请求', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_pause_continuation',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'demo-model',
      messages: [{ role: 'user', content: '继续回答' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /第一段/);
  assert.match(body, /Hello from upstream/);
  assert.match(body, /data: \[DONE\]/);
});

test('Anthropic 非流式响应正确收集文本和 usage', async () => {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_anthropic_nonstream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'demo-model',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].text, 'Hello from upstream');
  assert.equal(body.usage.output_tokens, 4);
});

test('1.31.0 tool-result 事件被静默跳过，不污染下游 tool_calls', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_tool_result',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'demo-model',
      messages: [{ role: 'user', content: '调用工具' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /tool_calls/);
  assert.match(body, /call_tool/);
  // tool-result 事件不应产生额外的 content 或 server 结果文本。
  assert.doesNotMatch(body, /server-done/);
  assert.match(body, /data: \[DONE\]/);
});

test('1.31.0 abort 事件被视为正常结束并返回流', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_abort_event',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'demo-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /partial output/);
  assert.match(body, /data: \[DONE\]/);
});

test('Claude Code 用 x-api-key 认证可访问 /v1/messages', async () => {
  // Claude Code 官方 SDK 使用 x-api-key 头而不是 Authorization。
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'user_claude_code_key',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /event: message_start/);
  assert.match(body, /text_delta/);
  assert.match(body, /Hello from upstream/);
  assert.match(body, /event: message_delta/);
  assert.match(body, /event: message_stop/);
  // 转发到上游的请求应该带上 API Key（Authorization 头）。
  assert.equal(lastGenerateHeaders.authorization, 'Bearer user_claude_code_key');
});

test('Claude Code 未带头访问 /v1/messages 返回 UNAUTHORIZED', async () => {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('Anthropic 流式把 CC reasoning 映射为 thinking_delta 事件', async () => {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'user_anthropic_thinking',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      thinking: { type: 'enabled', budget_tokens: 5000 },
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  // CC 的 reasoning-delta 应映射为 Anthropic 的 thinking block 事件。
  assert.match(body, /content_block_start/);
  assert.match(body, /"type":"thinking"/);
  assert.match(body, /thinking_delta/);
  assert.match(body, /让我想想/);
  assert.match(body, /再想想/);
  assert.match(body, /Hello with thinking/);
  assert.match(body, /event: message_stop/);
});

test('Claude Code 流式工具调用输出 tool_use 事件序列', async () => {
  // 复用 user_tool_result mock 分支：返回 tool-call + tool-result + finish(tool-calls)。
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'user_tool_result',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      tools: [{
        name: 'lookup',
        description: '查询天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
      messages: [{ role: 'user', content: '上海天气？' }],
      stream: true,
    }),
  });

  const body = await response.text();
  assert.equal(response.status, 200);
  // Anthropic 工具调用事件序列：content_block_start(tool_use) → input_json_delta → content_block_stop。
  assert.match(body, /"type":"tool_use"/);
  assert.match(body, /input_json_delta/);
  assert.match(body, /"name":"lookup"/);
  assert.match(body, /"id":"call_tool"/);
  assert.match(body, /event: message_delta/);
  assert.match(body, /"stop_reason":"tool_use"/);
  assert.match(body, /event: message_stop/);
  // tool-result 事件不应泄露给客户端。
  assert.doesNotMatch(body, /server-done/);
});

test('Anthropic 非流式响应包含 thinking 块', async () => {
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'user_anthropic_thinking_nonstream',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 128,
      thinking: { type: 'enabled', budget_tokens: 5000 },
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  // 推理内容应进入 thinking 块，而不是被丢弃并刷 Unknown 警告。
  assert.equal(body.content[0].type, 'thinking');
  assert.equal(body.content[0].thinking, '让我想想再想想');
  assert.equal(body.content[1].type, 'text');
  assert.equal(body.content[1].text, 'Hello with thinking');
  assert.equal(body.usage.output_tokens, 4);
});

test('指纹上报失败后走短退避，下一个请求会重试', async () => {
  const requestBody = JSON.stringify({
    model: 'demo-model',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const headers = { Authorization: 'Bearer user_fingerprint_fail', 'Content-Type': 'application/json' };

  const first = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers, body: requestBody });
  assert.equal(first.status, 200);
  const second = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers, body: requestBody });
  assert.equal(second.status, 200);

  // 上报 500 时代理应安排短退避重试，而不是静默等待完整的 8h 周期。
  assert.equal(fingerprintCallCounts.get('Bearer user_fingerprint_fail'), 2);
});

test('指纹上报成功后 8h 内不重复上报', async () => {
  const requestBody = JSON.stringify({
    model: 'demo-model',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const headers = { Authorization: 'Bearer user_fingerprint_ok', 'Content-Type': 'application/json' };

  const first = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers, body: requestBody });
  assert.equal(first.status, 200);
  const second = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers, body: requestBody });
  assert.equal(second.status, 200);

  assert.equal(fingerprintCallCounts.get('Bearer user_fingerprint_ok'), 1);
});

test('模型列表请求头省略缺失的可选字段，不发送字面量 undefined', async () => {
  await fetch(`${proxyUrl}/v1/models`);
  assert.ok(lastModelsHeaders, '应已捕获模型列表请求头');
  // 真实 CLI 不会发送值为 "undefined" 的头；缺失的可选头应整体省略。
  assert.equal(lastModelsHeaders['x-project-slug'], undefined);
  assert.equal(lastModelsHeaders['x-session-id'], undefined);
  for (const [name, value] of Object.entries(lastModelsHeaders)) {
    if (typeof value === 'string') assert.notEqual(value, 'undefined', `头 ${name} 不应为字面量 undefined`);
  }
});

test('上游 429 的 Retry-After 头透传给客户端', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_rate_limited', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(response.status, 429);
  // 上游返回的 Retry-After 应原样透传，而不是固定回退值 30。
  assert.equal(response.headers.get('retry-after'), '77');
  const body = await response.json();
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.retry_after, 77);
});

test('finish 缺 totalUsage 时非流式回退 step 级 usage，不再误判零输出', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_step_usage_only', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'demo-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  });

  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, 'step usage only');
  assert.equal(body.usage.prompt_tokens, 7);
  assert.equal(body.usage.completion_tokens, 3);
});

test('原生透传上游挂起时按空闲超时返回 502', async () => {
  const response = await fetch(`${proxyUrl}/alpha/native-hang`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_native_hang', 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });

  assert.equal(response.status, 502);
});

test('OpenAI 端点请求体超限返回 413 并关闭连接', async () => {
  const target = new URL(proxyUrl);
  const socket = connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');

  let received = '';
  socket.on('data', chunk => { received += chunk.toString('utf8'); });
  const closed = once(socket, 'close');
  socket.write([
    'POST /v1/chat/completions HTTP/1.1',
    `Host: ${target.host}`,
    'Authorization: Bearer user_oversize_json',
    `Content-Length: ${10 * 1024 * 1024 + 1}`,
    'Content-Type: application/json',
    '',
    '',
  ].join('\r\n'));
  await closed;

  assert.match(received, /^HTTP\/1\.1 413 Payload Too Large/);
  assert.match(received, /Connection: close/i);
});

test('客户端中途断连不会触发 ReferenceError（回归）', async () => {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const requestHeaders = {
    'x-api-key': 'user_hang_disconnect',
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };

  // 场景 1：流式响应中断开（走流式分支的 aborted 清理路径）。
  {
    const controller = new AbortController();
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ ...JSON.parse(requestBody), stream: true }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.ok(value.length > 0);
    controller.abort();
    try { await reader.cancel(); } catch {}
  }

  // 场景 2：非流式响应读取中断开——旧代码在这里引用 try 内声明的 messageId，
  // 会抛 "messageId is not defined" 并被兜底 catch 记为内部错误。
  {
    const controller = new AbortController();
    const pending = fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    });
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
    controller.abort();
    await pending.catch(() => {});
  }

  // 等待代理处理完断连后，进程应保持健康且不抛 ReferenceError。
  await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
  const health = await fetch(`${proxyUrl}/health`);
  assert.equal(health.status, 200);
  assert.doesNotMatch(proxyOutput, /ReferenceError|is not defined/);
});

test('指标端点 /stats 需要认证并返回延迟与限流统计', async () => {
  // 未认证 → 401（/stats 不在豁免名单内，复用全局 user_ Key 校验）。
  const unauth = await fetch(`${proxyUrl}/stats`);
  assert.equal(unauth.status, 401);

  // 产生一个成功的流式请求和一个上游 429 请求。
  await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_metrics_ok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_rate_limited', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', messages: [{ role: 'user', content: 'hi' }] }),
  });

  const response = await fetch(`${proxyUrl}/stats`, {
    headers: { Authorization: 'Bearer user_metrics_viewer' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.ok(body.totals.requests >= 2);
  assert.ok(body.totals.ok >= 1);
  assert.ok(body.totals.upstream_429 >= 1);
  assert.ok(Array.isArray(body.recent) && body.recent.length >= 1);
  assert.ok(body.recentRateLimits.length >= 1);
  assert.equal(body.recentRateLimits[0].outcome, 'upstream_429');
  // 成功的流式请求应记录首 token 延迟与总时长。
  const okStream = body.recent.find(entry => entry.outcome === 'ok' && entry.stream === true);
  assert.ok(okStream, '应至少有一条成功的流式请求记录');
  assert.ok(typeof okStream.ttftMs === 'number');
  assert.ok(typeof okStream.durationMs === 'number');
});

test('仪表盘页面可直接访问且不包含数据', async () => {
  const response = await fetch(`${proxyUrl}/dashboard`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /\/stats/);
});

test('RECORD_WIRE 将原生透传请求脱敏后逐行记录到文件', async () => {
  await fetch(`${proxyUrl}/alpha/native-test?mode=record`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_wire_record', 'Content-Type': 'application/json' },
    body: '{"probe":"wire-record"}',
  });
  // 异步写入流需要短暂时间落盘。
  await new Promise(resolveDelay => setTimeout(resolveDelay, 300));

  const lines = readFileSync(wireRecordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const requestEntry = lines.find(entry => entry.event === 'request' && entry.path === '/alpha/native-test?mode=record');
  assert.ok(requestEntry, '应记录 native 请求');
  assert.equal(requestEntry.method, 'POST');
  // 认证头必须脱敏，不得把完整 Key 写入文件。
  assert.equal(requestEntry.headers.authorization, '***');
  assert.equal(requestEntry.body, '{"probe":"wire-record"}');
  const responseEntry = lines.find(entry => entry.event === 'response' && entry.status === 207);
  assert.ok(responseEntry, '应记录上游响应状态');
});
