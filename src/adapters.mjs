import { randomUUID } from 'crypto';

// 请求适配器：负责 OpenAI、Anthropic 与 Command Code 之间的纯数据转换。

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function getEnvironment() {
  // 最新 CLI 的 config.environment 只使用运行时平台名称。
  return process.platform;
}

function tryParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .filter(part => ['text', 'input_text', 'output_text'].includes(part?.type))
    .map(part => part.text || part.value || '')
    .join('');
}

function toolOutputFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  // 1.31.0 CLI 会保留工具结果中各文本块的边界，用换行拼接后再发送给上游。
  return content
    .filter(part => part?.type === 'text')
    .map(part => part.text || '')
    .join('\n');
}

function imagePartToWire(part) {
  const url = part.image_url?.url || part.image || '';
  if (!url) return null;

  // 最新 CLI 对 base64 图片同时发送完整 data URL 和 mimeType。
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(url);
  return dataUrl
    ? { type: 'image', image: url, mimeType: dataUrl[1] }
    : { type: 'image', image: url };
}

function contentPartToWire(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
    return { type: 'text', text: part.text || part.value || '' };
  }
  if (part.type === 'image_url' || part.type === 'image') return imagePartToWire(part);
  if (part.type === 'reasoning' || part.type === 'thinking') {
    return { type: 'reasoning', text: part.thinking || part.text || '' };
  }
  return null;
}

function buildWireMessages(messages) {
  const wireMessages = [];
  // 1.31.0 的 toWireMessages 会记录 toolCallId → toolName 映射，
  // 后续 tool-result 用该映射回填工具名，找不到时用 "unknown"。
  const toolNameById = new Map();

  for (const message of messages) {
    // system/developer 会被提升到 params.system，不能直接进入上游 messages。
    if (message.role === 'system' || message.role === 'developer') continue;

    if (message.role === 'assistant') {
      const content = [];
      if (typeof message.content === 'string' && message.content) {
        content.push({ type: 'text', text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          const wirePart = contentPartToWire(part);
          if (wirePart) content.push(wirePart);
        }
      }

      for (const toolCall of message.tool_calls || []) {
        const toolName = toolCall.function?.name || '';
        toolNameById.set(toolCall.id, toolName);
        content.push({
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName,
          input: typeof toolCall.function?.arguments === 'string'
            ? tryParseJSON(toolCall.function.arguments)
            : (toolCall.function?.arguments || {}),
        });
      }

      // 跳过 content 为空的 assistant 消息：CC 后端不接受空消息，
      // 会报 "messages[N].role is invalid"（角色与内容不匹配的笼统错误）。
      if (content.length === 0) continue;
      wireMessages.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'user') {
      const content = [];
      const toolResults = [];
      if (typeof message.content === 'string' && message.content) {
        content.push({ type: 'text', text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === 'tool_result' || part?.type === 'tool-result') {
            toolResults.push({
              type: 'tool-result',
              toolCallId: part.tool_use_id || part.toolCallId,
              // 1.31.0 的 toWireMessages 会回填工具名，找不到时用 "unknown"。
              toolName: toolNameById.get(part.tool_use_id || part.toolCallId) ?? 'unknown',
              output: {
                type: 'text',
                value: toolOutputFromContent(part.content ?? part.output),
              },
            });
          } else {
            const wirePart = contentPartToWire(part);
            if (wirePart) content.push(wirePart);
          }
        }
      }
      // 1.31.0 的 toWireMessages：tool 结果先 push，文本后 push。
      if (toolResults.length > 0) wireMessages.push({ role: 'tool', content: toolResults });
      // 跳过 content 为空的 user 消息，避免 CC 后端拒绝空消息。
      if (content.length > 0) wireMessages.push({ role: 'user', content });
      continue;
    }

    // 旧版 OpenAI 客户端可能使用 function 角色，统一转换为 1.31.0 的 tool。
    if (message.role === 'tool' || message.role === 'function') {
      wireMessages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.tool_call_id,
          // 1.31.0 的 toWireMessages 会回填工具名，找不到时用 "unknown"。
          toolName: toolNameById.get(message.tool_call_id) ?? 'unknown',
          output: {
            type: 'text',
            value: typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content),
          },
        }],
      });
    }
  }

  return wireMessages;
}

function buildServerConfig(serverConfig = {}) {
  return {
    workingDir: process.cwd(),
    date: getDateStr(),
    environment: getEnvironment(),
    // 代理无法看到调用方本地工作区，因此保留最新版 CLI 的完整字段形状。
    structure: [],
    isGitRepo: false,
    currentBranch: '',
    mainBranch: '',
    gitStatus: '',
    recentCommits: [],
    ...serverConfig,
  };
}

function normalizePermissionMode(permissionMode) {
  if (permissionMode === 'bypass') return 'auto-accept';
  if (permissionMode === 'auto-accept' || permissionMode === 'plan') return permissionMode;
  return 'standard';
}

function toWireTools(tools = []) {
  return tools.map(tool => ({
    name: tool.function?.name || tool.name || '',
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  }));
}

export function buildCcRequest(openaiReq, {
  threadId,
  mode = 'agent',
  permissionMode = 'standard',
  serverConfig,
} = {}) {
  const {
    model,
    messages,
    max_tokens,
    temperature,
    top_p,
    stop,
    user,
    presence_penalty,
    frequency_penalty,
    response_format,
    tools,
    reasoning_effort,
    tool_choice,
    parallel_tool_calls,
  } = openaiReq;

  // 提取 system prompt；最新版 CLI 将 system 独立放在 params.system。
  const systemMsgs = messages.filter(
    message => message.role === 'system' || message.role === 'developer',
  );
  const body = {
    config: buildServerConfig(serverConfig),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: normalizePermissionMode(permissionMode),
    ...(isUuid(threadId) ? { threadId } : {}),
    mode: mode || 'agent',
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: buildWireMessages(messages),
      tools: toWireTools(tools || []),
      max_tokens: max_tokens ?? 64000,
      stream: true,
    },
  };

  const systemPrompt = systemMsgs.map(message => textFromContent(message.content)).filter(Boolean).join('\n');

  // 只写入客户端明确提供的可选参数，避免覆盖上游默认值。
  if (systemPrompt) body.params.system = systemPrompt;
  if (temperature !== undefined) body.params.temperature = temperature;
  if (top_p !== undefined) body.params.top_p = top_p;
  if (stop !== undefined) body.params.stop = stop;
  if (user !== undefined) body.params.user = user;
  if (presence_penalty !== undefined) body.params.presence_penalty = presence_penalty;
  if (frequency_penalty !== undefined) body.params.frequency_penalty = frequency_penalty;
  if (response_format !== undefined) body.params.response_format = response_format;
  if (reasoning_effort !== undefined) body.params.reasoning_effort = reasoning_effort;

  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map = { auto: 'auto', none: 'none', required: 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) body.params.parallel_tool_calls = parallel_tool_calls;

  return body;
}

// 统一处理上游 usage，避免 outputTokens 为 0 时错误计费。
// 1.31.0 的 finish 事件把缓存字段放在 inputTokenDetails.cacheReadTokens / cacheWriteTokens，
// 这里统一归一化到 cachedInputTokens / inputTokenDetails 供下游使用。
export function normalizeUsage(usage) {
  if (!usage) return;
  if (!Number(usage.outputTokens)) {
    usage.inputTokens = 0;
    usage.cachedInputTokens = 0;
  }
  // 1.31.0 新字段：inputTokenDetails.cacheReadTokens / cacheWriteTokens
  const details = usage.inputTokenDetails;
  if (details && details.cacheReadTokens !== undefined) {
    usage.cachedInputTokens = details.cacheReadTokens;
  }
}

// 从 1.31.0 的 usage 对象读取缓存输入 token。
// finish 事件的 totalUsage.inputTokenDetails.cacheReadTokens 是权威字段，
// 老版本用顶层的 cachedInputTokens，这里都兼容。
export function getCacheReadTokens(usage) {
  if (!usage) return 0;
  const details = usage.inputTokenDetails;
  if (details && details.cacheReadTokens !== undefined) return details.cacheReadTokens;
  return usage.cachedInputTokens ?? 0;
}

export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length':
    case 'max_tokens': return 'length';
    case 'stop': return 'stop';
    case 'pause_turn': return 'stop';
    default: return reason || 'stop';
  }
}

export function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'tool-calls':
    case 'tool_use': return 'tool_use';
    case 'length':
    case 'max_tokens': return 'max_tokens';
    case 'stop':
    case 'end_turn': return 'end_turn';
    default: return 'end_turn';
  }
}

export function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage) {
  const content = [];
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const toolCall of toolCalls) {
      let input = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input });
    }
  }
  normalizeUsage(usage || {});
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
      cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
    },
  };
}

export function convertAnthropicToOpenAI(anthropicReq) {
  let systemPrompt = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    }
  }

  const toolNameFromId = {};
  const openaiMessages = [];
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt });

  const messages = anthropicReq.messages || [];
  for (const message of messages) {
    // Claude Code 会把系统提示词作为 role:'system' 消息发送。
    // 保持为 system 角色，buildCcRequest 会自动提升到 params.system。
    if (message.role === 'system') {
      const systemText = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n')
          : String(message.content || '');
      if (systemText) openaiMessages.push({ role: 'system', content: systemText });
      continue;
    }
    if (message.role === 'assistant') {
      let textContent = '';
      const thinkingContent = [];
      const toolCalls = [];
      const blocks = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: message.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
        } else if (block.type === 'thinking') {
          thinkingContent.push({
            type: 'reasoning',
            thinking: block.thinking || block.text || '',
          });
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const assistantMessage = {
        role: 'assistant',
        content: thinkingContent.length > 0
          ? [...(textContent ? [{ type: 'text', text: textContent }] : []), ...thinkingContent]
          : (textContent || null),
      };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      openaiMessages.push(assistantMessage);
    } else if (message.role === 'user') {
      let textContent = '';
      const toolResults = [];
      if (typeof message.content === 'string') {
        textContent = message.content;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text') textContent += block.text || '';
          else if (block.type === 'tool_result') toolResults.push(block);
        }
      }
      // 1.31.0 的 toWireMessages：同一 user 消息内的 tool_result 转成 tool 消息放在文本前面。
      for (const result of toolResults) {
        const toolContent = typeof result.content === 'string'
          ? result.content
          : Array.isArray(result.content)
            ? result.content.map(item => item.text || '').join('')
            : String(result.content || '');
        openaiMessages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          name: toolNameFromId[result.tool_use_id] || '',
          content: toolContent,
        });
      }
      if (textContent) openaiMessages.push({ role: 'user', content: textContent });
    } else if (message.role === 'tool') {
      // 兼容部分客户端直接发送独立 tool 消息（非标准 Anthropic 但存在）。
      const toolContent = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('')
          : String(message.content || '');
      openaiMessages.push({
        role: 'tool',
        tool_call_id: message.tool_use_id || message.tool_call_id,
        name: message.name || toolNameFromId[message.tool_use_id || message.tool_call_id] || '',
        content: toolContent,
      });
    }
  }

  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  if (anthropicReq.tool_choice) {
    const choice = anthropicReq.tool_choice;
    if (choice.type === 'auto' || choice.type === undefined) openaiReq.tool_choice = 'auto';
    else if (choice.type === 'any') openaiReq.tool_choice = 'required';
    else if (choice.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: choice.name } };
    } else if (choice.type === 'none') openaiReq.tool_choice = 'none';
  }

  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  if (anthropicReq.thinking) {
    const thinking = anthropicReq.thinking;
    if (thinking.type === 'adaptive') {
      openaiReq.reasoning_effort = thinking.effort ?? 'medium';
    } else if (thinking.type !== 'disabled' && thinking.type !== 'none'
      && thinking.budget_tokens !== undefined) {
      // 按 CC 1.31.0 白名单（low/medium/high/xhigh/max）分 5 档映射，
      // 让 Claude Code 的大 thinking 预算能真正传到 max，而不是封顶在 high。
      if (thinking.budget_tokens >= 100000) openaiReq.reasoning_effort = 'max';
      else if (thinking.budget_tokens >= 30000) openaiReq.reasoning_effort = 'xhigh';
      else if (thinking.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (thinking.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else openaiReq.reasoning_effort = 'low';
    }
  }

  return openaiReq;
}

// 将上游 NDJSON 流转换为 Anthropic SSE 事件。
export async function* createAnthropicSseTranslator(response, model, messageId, ctx, logger = () => {}) {
  const streamIdleTimeoutMs = 30_000;
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason = null;
  let hasError = false;

  function closeTextBlock() {
    if (blockStarted && currentBlockType === 'text') {
      blockStarted = false;
      currentBlockType = null;
      return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`;
    }
    return '';
  }

  function startTextBlock() {
    if (!blockStarted || currentBlockType !== 'text') {
      const close = closeTextBlock() + closeThinkingBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = 'text';
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`;
    }
    return '';
  }

  // thinking block 管理：Claude Code 期望 thinking 是独立的 content block（signature 可选）。
  function closeThinkingBlock() {
    if (blockStarted && currentBlockType === 'thinking') {
      blockStarted = false;
      currentBlockType = null;
      return `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`;
    }
    return '';
  }

  function startThinkingBlock() {
    if (!blockStarted || currentBlockType !== 'thinking') {
      const close = closeTextBlock() + closeThinkingBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = 'thinking';
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'thinking', thinking: '' } })}\n\n`;
    }
    return '';
  }

  if (!ctx.continuation) {
    yield `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })}\n\n`;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('STREAM_IDLE_TIMEOUT')), streamIdleTimeoutMs)
        ),
      ]);
      const { done, value } = result;
      if (done) {
        buffer += decoder.decode();
      } else {
        ctx.bytesReceived += value.length;
        buffer += decoder.decode(value, { stream: true });
      }
      if (done && !buffer.trim()) break;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (done && buffer.trim()) {
        lines.push(buffer);
        buffer = '';
      }

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start':
          case 'start-step':
          case 'text-start':
          case 'provider-metadata':
          case 'tool-input-start':
          case 'tool-input-delta':
          case 'tool-input-end':
          case 'tool-error':
          case 'text-end':
            // 这些是内部信号，不直接暴露给 Anthropic 客户端。
            break;

          // CC 的推理事件映射为 Anthropic 的 thinking block，
          // 兼容 Claude Code 使用 thinking 参数时对 thinking_delta 事件的期待。
          case 'reasoning-start': {
            const closeBlock = closeTextBlock();
            const startBlock = startThinkingBlock();
            yield closeBlock + startBlock;
            break;
          }

          case 'reasoning-delta': {
            const text = event.text || '';
            if (!text) break;
            const startBlock = startThinkingBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
            break;
          }

          case 'reasoning-end': {
            const closeThinking = closeThinkingBlock();
            if (closeThinking) yield closeThinking;
            break;
          }

          case 'text-delta': {
            const text = event.text || '';
            const startBlock = startTextBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += 1;
            break;
          }

          case 'tool-call': {
            if (event.providerExecuted) break;
            // 关闭当前文本或 thinking block，再开始工具 block。
            const closeBlock = closeTextBlock() + closeThinkingBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            // 1.31.0 的 tool-call 事件同时支持 input 或 args 字段。
            const rawInput = event.input ?? event.args;
            const input = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput || {});
            const toolIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: toolIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          // 1.31.0 新增：服务端直接执行的工具结果。Anthropic 协议没有对应概念，静默跳过。
          case 'tool-result':
            break;

          // 1.31.0：abort 事件表示上游主动终止，视为正常结束。
          case 'abort': {
            ctx.finished = true;
            // abort 是合法终止，不算零输出；有文本时避免触发零输出防护。
            if (outputTokens === 0 && nextBlockIndex > 0) outputTokens = 1;
            break;
          }
          case 'finish-step':
            // step 结束不代表整条响应结束，最终状态以 finish 为准。
            break;

          case 'finish': {
            const rawFinishReason = String(event.rawFinishReason || event.finishReason || 'stop').toLowerCase();
            if (rawFinishReason === 'pause_turn') {
              ctx.shouldContinue = true;
              ctx.finished = false;
              break;
            }
            ctx.shouldContinue = false;
            ctx.finished = true;
            if (event.finishReason || event.rawFinishReason) {
              stopReason = mapAnthropicStopReason(event.finishReason || event.rawFinishReason);
            }
            const usage = event.totalUsage || event.usage;
            if (usage) {
              normalizeUsage(usage);
              inputTokens = usage.inputTokens ?? inputTokens;
              outputTokens = usage.outputTokens ?? outputTokens;
              // 1.31.0 的缓存字段在 inputTokenDetails.cacheReadTokens / cacheWriteTokens。
              cachedInputTokens = getCacheReadTokens(usage) ?? cachedInputTokens;
              cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
            } else {
              inputTokens = 0;
              outputTokens = 0;
              cachedInputTokens = 0;
              cacheWriteTokens = 0;
            }
            ctx.inputTokens = inputTokens;
            ctx.outputTokens = outputTokens;
            ctx.cachedInputTokens = cachedInputTokens;
            break;
          }

          case 'error': {
            hasError = true;
            const message = event.error?.message || event.message || 'Unknown CC error';
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message } })}\n\n`;
            break;
          }

          default:
            logger('warn', 'Unknown CC event type', { type: event.type });
            break;
        }
      }
      if (done) break;
    }

    if (!hasError && !ctx.shouldContinue) {
      if (!ctx.finished) throw new Error('UPSTREAM_STREAM_INCOMPLETE');
      const closeBlock = closeTextBlock() + closeThinkingBlock();
      if (closeBlock) yield closeBlock;

      if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: { output_tokens: outputTokens, cache_read_input_tokens: cachedInputTokens, cache_creation_input_tokens: cacheWriteTokens || null, input_tokens: inputTokens },
        })}\n\n`;
        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    }
  } finally {
    // 流中断时及时释放上游读取器。
    try { await reader.cancel(); } catch {}
  }
}
