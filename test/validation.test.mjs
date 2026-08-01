import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnthropicRequest, validateOpenAIRequest } from '../src/validation.mjs';

test('OpenAI 请求缺少 messages 时返回明确错误', () => {
  const result = validateOpenAIRequest({ model: 'demo-model' });
  assert.equal(result.field, 'messages');
});

test('Anthropic 请求接受基础消息和工具定义', () => {
  const result = validateAnthropicRequest({
    model: 'demo-model',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  });
  assert.equal(result, null);
});
