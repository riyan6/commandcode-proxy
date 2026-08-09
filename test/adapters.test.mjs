import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCcRequest } from '../src/adapters.mjs';

test('请求体与 command-code 1.15.1 的 CLI 信封和工具格式一致', () => {
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
  assert.equal(body.params.messages[2].content[0].toolName, '');
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

test('工具结果的多个文本块按 command-code 1.15.1 格式用换行拼接', () => {
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
