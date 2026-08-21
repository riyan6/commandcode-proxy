// 统一校验客户端请求，避免无效数据进入协议转换和上游请求流程。

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(message, field) {
  return { message, field };
}

function validateMessages(messages, allowedRoles) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return error('messages must be a non-empty array', 'messages');
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) return error(`messages[${index}] must be an object`, `messages.${index}`);
    if (!allowedRoles.includes(message.role)) {
      return error(`messages[${index}].role is invalid`, `messages.${index}.role`);
    }
    if (message.content !== undefined
      && message.content !== null
      && typeof message.content !== 'string'
      && !Array.isArray(message.content)) {
      return error(`messages[${index}].content must be a string or array`, `messages.${index}.content`);
    }
  }

  return null;
}

function validateRange(value, field, min, max) {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return error(`${field} must be a number between ${min} and ${max}`, field);
  }
  return null;
}

function validatePositiveInteger(value, field) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) return error(`${field} must be a positive integer`, field);
  return null;
}

function validateTools(tools, field = 'tools') {
  if (tools === undefined) return null;
  if (!Array.isArray(tools)) return error(`${field} must be an array`, field);
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    if (!isRecord(tool)) return error(`${field}[${index}] must be an object`, `${field}.${index}`);
    const definition = tool.function || tool;
    if (!isRecord(definition) || typeof definition.name !== 'string' || !definition.name.trim()) {
      return error(`${field}[${index}] must contain a function name`, `${field}.${index}`);
    }
  }
  return null;
}

function validateCommonRequest(request) {
  if (!isRecord(request)) return error('request body must be a JSON object', 'body');
  if (typeof request.model !== 'string' || !request.model.trim()) {
    return error('model must be a non-empty string', 'model');
  }
  return null;
}

export function validateOpenAIRequest(request) {
  let problem = validateCommonRequest(request);
  if (problem) return problem;

  // 兼容部分 Agent 使用的 developer 角色和旧版 function 工具消息。
  problem = validateMessages(request.messages, ['system', 'developer', 'user', 'assistant', 'tool', 'function']);
  if (problem) return problem;
  problem = validatePositiveInteger(request.max_tokens, 'max_tokens');
  if (problem) return problem;
  problem = validateRange(request.temperature, 'temperature', 0, 2);
  if (problem) return problem;
  problem = validateRange(request.top_p, 'top_p', 0, 1);
  if (problem) return problem;
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    return error('stream must be a boolean', 'stream');
  }
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') {
    return error('parallel_tool_calls must be a boolean', 'parallel_tool_calls');
  }
  if (request.stop !== undefined
    && typeof request.stop !== 'string'
    && !(Array.isArray(request.stop) && request.stop.every(item => typeof item === 'string'))) {
    return error('stop must be a string or an array of strings', 'stop');
  }
  problem = validateTools(request.tools);
  if (problem) return problem;

  return null;
}

export function validateAnthropicRequest(request) {
  let problem = validateCommonRequest(request);
  if (problem) return problem;
  problem = validateMessages(request.messages, ['user', 'assistant', 'tool', 'system']);
  if (problem) return problem;
  problem = validatePositiveInteger(request.max_tokens, 'max_tokens');
  if (problem) return problem;
  problem = validateRange(request.temperature, 'temperature', 0, 1);
  if (problem) return problem;
  problem = validateRange(request.top_p, 'top_p', 0, 1);
  if (problem) return problem;
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    return error('stream must be a boolean', 'stream');
  }
  if (request.system !== undefined
    && typeof request.system !== 'string'
    && !Array.isArray(request.system)) {
    return error('system must be a string or an array', 'system');
  }
  problem = validateTools(request.tools);
  if (problem) return problem;

  return null;
}
