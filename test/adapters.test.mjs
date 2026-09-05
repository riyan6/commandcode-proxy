import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicResponse,
  buildCcRequest,
  buildFakeWorkspace,
  convertAnthropicToOpenAI,
  getCacheReadTokens,
  normalizeUsage,
  projectSlugFromWorkspace,
} from '../src/adapters.mjs';

test('请求体与 command-code 1.47.0 的 CLI 信封和工具格式一致', () => {
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

test('伪工作区按 Key 稳定并符合 CLI 的 Git 字段形状', () => {
  const first = buildFakeWorkspace('salt:user_a');
  const again = buildFakeWorkspace('salt:user_a');
  const other = buildFakeWorkspace('salt:user_b');

  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.equal(first.isGitRepo, true);
  assert.match(first.currentBranch, /^(?:main|master|feat\/[a-z-]+|fix\/[a-z-]+)$/);
  assert.match(first.mainBranch, /^(?:main|master)$/);
  assert.match(first.gitStatus, /^(?:Working tree clean| M .+)$/);
  assert.equal(first.recentCommits.length, 3);
  assert.ok(first.recentCommits.every(commit => /^[0-9a-f]{7} .+/.test(commit)));
  assert.ok(first.structure.length > 0);
  assert.ok(first.structure.every(entry => !entry.startsWith('.')));
  assert.equal(
    projectSlugFromWorkspace(first),
    first.workingDir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  );
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

test('params 键序对齐 1.47.0：system 位于 tools 与 max_tokens 之间', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: 'hi' },
    ],
    max_tokens: 128,
  });

  // JSON 键序是请求关联特征，必须与 1.47.0 的 buildGenerateBody 一致。
  assert.deepEqual(Object.keys(body.params), [
    'model',
    'messages',
    'tools',
    'system',
    'max_tokens',
    'stream',
  ]);

  // 无系统提示时整体省略 system 键，与 CLI 中 system 为 undefined 被 JSON 丢弃一致。
  const noSystem = buildCcRequest({
    model: 'demo-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(Object.keys(noSystem.params), [
    'model',
    'messages',
    'tools',
    'max_tokens',
    'stream',
  ]);

  // temperature / reasoning_effort 附加在末尾。
  const withTemp = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: 'hi' },
    ],
    temperature: 0.4,
    reasoning_effort: 'high',
  });
  assert.deepEqual(Object.keys(withTemp.params), [
    'model',
    'messages',
    'tools',
    'system',
    'max_tokens',
    'stream',
    'temperature',
    'reasoning_effort',
  ]);
});

test('历史消息中的 tool_search 按 1.47.0 规则重命名为 search_tools', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [
      { role: 'user', content: '搜索工具' },
      { role: 'assistant', content: '调用搜索', tool_calls: [{
        id: 'call_search',
        function: { name: 'tool_search', arguments: '{"query":"fp"}' },
      }] },
      { role: 'tool', tool_call_id: 'call_search', content: '命中' },
    ],
  });

  const assistantMessage = body.params.messages.find(message => message.role === 'assistant');
  // toWireToolName：assistant 历史里的 tool_search 统一以 search_tools 上送。
  // 文本块在前，tool-call 块在后。
  const toolCallPart = assistantMessage.content.find(part => part.type === 'tool-call');
  assert.equal(toolCallPart.toolName, 'search_tools');

  // tool-result 依据映射回填重命名后的工具名。
  const toolMessage = body.params.messages.find(message => message.role === 'tool');
  assert.equal(toolMessage.content[0].toolName, 'search_tools');

  // 工具定义不做重命名（toWireTools 原样透传）。
  const defined = buildCcRequest({
    model: 'demo-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: { name: 'tool_search', description: '搜索', parameters: { type: 'object', properties: {} } },
    }],
  });
  assert.equal(defined.params.tools[0].name, 'tool_search');
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

test('1.47.0 请求信封过滤 OpenAI 专属可选参数', () => {
  const body = buildCcRequest({
    model: 'demo-model',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.4,
    top_p: 0.8,
    stop: ['END'],
    user: 'client-user',
    presence_penalty: 0.2,
    frequency_penalty: 0.3,
    response_format: { type: 'json_object' },
    tool_choice: 'required',
    parallel_tool_calls: false,
  });

  assert.equal(body.params.temperature, 0.4);
  for (const key of [
    'top_p',
    'stop',
    'user',
    'presence_penalty',
    'frequency_penalty',
    'response_format',
    'tool_choice',
    'parallel_tool_calls',
  ]) {
    assert.equal(body.params[key], undefined, key);
  }
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

test('Anthropic base64 图片块转换为 CC wire image，不再被丢弃', () => {
  const openai = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里有什么' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      ],
    }],
  });

  // user 消息保留为 text + image_url 数组内容。
  const userMessage = openai.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMessage.content));
  assert.equal(userMessage.content[0].type, 'text');
  assert.equal(userMessage.content[0].text, '这张图里有什么');
  assert.equal(userMessage.content[1].type, 'image_url');
  assert.equal(userMessage.content[1].image_url.url, 'data:image/jpeg;base64,QUJD');

  // 再经 buildCcRequest 转成 wire image 部分（带 mimeType）。
  const cc = buildCcRequest(openai, { mode: 'agent', permissionMode: 'standard' });
  const wire = cc.params.messages[0].content;
  assert.equal(wire[0].type, 'text');
  assert.equal(wire[1].type, 'image');
  assert.equal(wire[1].image, 'data:image/jpeg;base64,QUJD');
  assert.equal(wire[1].mimeType, 'image/jpeg');
});

test('Anthropic URL 图片块转换为 image_url 格式', () => {
  const openai = convertAnthropicToOpenAI({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
    }],
  });

  const userMessage = openai.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(userMessage.content));
  assert.equal(userMessage.content[0].type, 'image_url');
  assert.equal(userMessage.content[0].image_url.url, 'https://example.com/a.png');
});

test('非流式 Anthropic 响应包含 thinking block', () => {
  const body = buildAnthropicResponse(
    'claude-sonnet-4-6',
    '最终回答',
    null,
    'stop',
    { inputTokens: 1, outputTokens: 2 },
    '思考过程',
  );

  // thinking 块在最前，与流式路径的块顺序一致。
  assert.equal(body.content[0].type, 'thinking');
  assert.equal(body.content[0].thinking, '思考过程');
  assert.equal(body.content[1].type, 'text');
  assert.equal(body.content[1].text, '最终回答');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.usage.output_tokens, 2);

  // 无 thinking 时不输出 thinking 块。
  const noThinking = buildAnthropicResponse('claude-sonnet-4-6', '回答', null, 'stop', { inputTokens: 1, outputTokens: 1 });
  assert.equal(noThinking.content[0].type, 'text');
});
