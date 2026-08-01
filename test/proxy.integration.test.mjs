import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let upstream;
let proxyProcess;
let proxyUrl;
let lastGenerateBody = null;
let lastGenerateHeaders = null;
let lastFingerprintBody = null;
const generateCallCounts = new Map();

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
  upstream = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/alpha/fingerprint/record') {
      lastFingerprintBody = JSON.parse(bodyText);
      res.writeHead(200);
      res.end('{}');
      return;
    }

    if (req.url === '/alpha/lifecycle-events') {
      res.writeHead(200);
      res.end('{}');
      return;
    }

    if (req.url === '/alpha/generate') {
      lastGenerateBody = JSON.parse(bodyText);
      lastGenerateHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const authKey = req.headers.authorization || '';
      const callCount = (generateCallCounts.get(authKey) || 0) + 1;
      generateCallCounts.set(authKey, callCount);
      const events = authKey.includes('user_pause_continuation') && callCount === 1
        ? [
          { type: 'start' },
          { type: 'text-delta', text: '第一段' },
          { type: 'finish', finishReason: 'pause_turn', totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ]
        : lastGenerateBody.params.tools?.length > 0
        ? [
          { type: 'start' },
          { type: 'tool-call', toolCallId: 'call_tool', toolName: 'lookup', input: { city: 'Shanghai' } },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 } },
        ]
        : [
          { type: 'start' },
          { type: 'text-start' },
          { type: 'text-delta', text: 'Hello from upstream' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 1 } },
        ];
      res.end(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
      return;
    }

    res.writeHead(404);
    res.end('{}');
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
      CC_USE_PROVIDER_MODELS: 'false',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(proxyUrl);
});

after(async () => {
  if (proxyProcess && proxyProcess.exitCode === null) {
    proxyProcess.kill();
    await once(proxyProcess, 'exit');
  }
  if (upstream) await new Promise(resolveClose => upstream.close(resolveClose));
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
  assert.equal(lastGenerateBody.mode, 'interactive');
  assert.equal(lastGenerateBody.permissionMode, 'standard');
  assert.equal(lastGenerateBody.threadId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(lastGenerateBody.params.tools[0].type, undefined);
  assert.equal(lastGenerateHeaders['user-agent'], 'cli');
  assert.match(lastGenerateHeaders['x-command-code-version'], /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.match(lastGenerateHeaders['x-session-id'], /^sess_[0-9a-f]{16}$/);
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
