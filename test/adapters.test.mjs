import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCcRequest, normalizeUsage, getCacheReadTokens, convertAnthropicToOpenAI } from '../src/adapters.mjs';

test('请求体与 command-code 1.31.0 的 CLI 信封和工具格式一致', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: [
        { type: 'text', text: '读取图片' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
      {
        role: 'assistant',
        content: '我来查询',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'lookup', arguments: '{"city":"Shanghai"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴天' },
    ],
    max_tokens: 128,
    tools: [{
      type: 'function',
      function: {
        name: 'lookup',
        description: '查询天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  }, {
    threadId: '123e4567-e89b-12d3-a456-426614174000',
    mode: 'agent',
    permissionMode: 'standard',
  });

  assert.equal(body.skills, null);
  assert.equal(body.mode, 'agent');
  assert.equal(body.threadId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(body.params.system, '你是助手');
  assert.equal(body.params.tools[0].name, 'lookup');
  assert.equal(body.params.tools[0].type, undefined);
  assert.equal(body.params.messages[0].content[1].mimeType, 'image/png');
  assert.equal(body.params.messages[1].content[1].type, 'tool-call');
  // 1.31.0 的 toWireMessages 会回填 toolName。
  assert.equal(body.params.messages[2].content[0].toolName, 'lookup');
  assert.deepEqual(body.params.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.ok(body.params.messages.every(message => Array.isArray(message.content)));
});

test('兼容 Agent 的 developer 和旧式 function 消息格式', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'developer', content: '你是一个代码助手' },
      { role: 'user', content: '请检查项目' },
      { role: 'assistant', content: '我需要调用工具', tool_calls: [{
        id: 'call_legacy',
        function: { name: 'inspect', arguments: '{}' },
      }] },
      { role: 'function', name: 'inspect', content: '{"ok":true}' },
    ],
  });

  assert.equal(body.params.system, '你是一个代码助手');
  assert.equal(body.mode, 'agent');
  assert.deepEqual(body.params.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.ok(body.params.messages.every(message => Array.isArray(message.content)));
  assert.equal(body.params.messages[2].content[0].type, 'tool-result');
});

test('工具结果的多个文本块按 command-code 1.31.0 格式用换行拼接', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_multiline',
        content: [
          { type: 'text', text: '第一行' },
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          { type: 'text', text: '第二行' },
        ],
      }],
    }],
  });

  assert.equal(body.params.messages[0].content[0].output.value, '第一行\n第二行');
});

test('1.31.0 tool-result 找不到对应工具名时回填 unknown', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'assistant', content: '调用工具', tool_calls: [{
        id: 'call_a',
        function: { name: 'known_tool', arguments: '{}' },
      }] },
      { role: 'tool', tool_call_id: 'call_unknown', content: '结果' },
    ],
  });

  const toolResults = body.params.messages.filter(message => message.role === 'tool');
  assert.equal(toolResults[0].content[0].toolCallId, 'call_unknown');
  // 1.31.0 的 toWireMessages：未匹配到工具名时用 "unknown"。
  assert.equal(toolResults[0].content[0].toolName, 'unknown');
});

test('1.31.0 usage 的缓存字段在 inputTokenDetails.cacheReadTokens', () => {
  const usage = { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 8 } };
  assert.equal(getCacheReadTokens(usage), 8);
  normalizeUsage(usage);
  assert.equal(usage.cachedInputTokens, 8);

  // 兼容老版本顶层 cachedInputTokens。
  assert.equal(getCacheReadTokens({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 3 }), 3);
});

test('Claude Code thinking.budget_tokens 按 5 档映射到 reasoning_effort', () => {
  const cases = [
    [150000, 'max'],
    [100000, 'max'],
    [50000, 'xhigh'],
    [30000, 'xhigh'],
    [20000, 'high'],
    [10000, 'high'],
    [8000, 'medium'],
    [5000, 'medium'],
    [3000, 'low'],
  ];
  for (const [budget, expected] of cases) {
    const openai = convertAnthropicToOpenAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: budget },
    });
    assert.equal(openai.reasoning_effort, expected, `budget=${budget}`);
  }
});

test('Claude Code adaptive thinking 直接透传 effort', () => {
  const openai = convertAnthropicToOpenAI({
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive', effort: 'max' },
  });
  assert.equal(openai.reasoning_effort, 'max');
});

test('OpenAI 路径的 reasoning_effort 原样透传到 CC 请求体', () => {
  const body = buildCcRequest({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  });
  assert.equal(body.params.reasoning_effort, 'high');

  const maxBody = buildCcRequest({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'max',
  });
  assert.equal(maxBody.params.reasoning_effort, 'max');
});

test('空的 assistant/user 消息被跳过，避免 CC 后端拒绝', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },          // 空 assistant
      { role: 'user', content: '' },                  // 空 user
      { role: 'assistant', content: [] },             // 空 assistant 数组
      { role: 'user', content: '继续' },
    ],
  });

  const roles = body.params.messages.map(message => message.role);
  assert.deepEqual(roles, ['user', 'user']);
  assert.ok(body.params.messages.every(message => message.content.length > 0));
});

test('Claude Code 发送 role:system 消息时合并到 params.system', () => {
  const openai = convertAnthropicToOpenAI({
    model: 'deepseek/deepseek-v4-flash',
    max_tokens: 1000,
    system: [{ type: 'text', text: '顶层系统提示' }],
    messages: [
      { role: 'user', content: '你好' },
      { role: 'system', content: '消息里的系统提示' },
    ],
  });

  // system 消息被保留，buildCcRequest 会合并到 params.system。
  assert.deepEqual(openai.messages.map(m => m.role), ['system', 'user', 'system']);

  const cc = buildCcRequest(openai, { mode: 'agent', permissionMode: 'standard' });
  assert.equal(cc.params.system, '顶层系统提示\n消息里的系统提示');
  // 系统提示不进 wire messages。
  assert.deepEqual(cc.params.messages.map(m => m.role), ['user']);
});
