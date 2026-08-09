# Command Code Proxy

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理。Node.js ESM 实现，零外部依赖。

基于本机 `command-code@1.15.1` CLI bundle 的分析，对齐 Command Code API 请求协议，并实现多层兼容适配。

**完整功能**：Command Code 原生 HTTP/WebSocket 透传 | OpenAI Chat Completions + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 动态模型列表 | 缓存命中指标 | 客户端断连检测（上游中止） | 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
npm start        # 启动（默认 http://0.0.0.0:3050）
npm run dev      # watch 模式（文件修改自动重启）
```

API Key 通过 `Authorization` 请求头传入，**无需配置到文件中**。Key 必须以 `user_` 开头（自动匹配任意前缀，如 `Bearer token_user_xxx`）：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 文件结构

```
commandcode/
├── config.json           # 端口 / 日志路径等
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # HTTP 入口与请求编排
├── src/                  # 配置、校验、状态和 CC 客户端模块
├── test/                 # Node.js 内置测试
├── Dockerfile            # 容器构建文件（node:22-alpine）
├── docker-compose.yml    # 容器编排
├── .dockerignore         # 构建上下文排除规则
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

## 配置

### config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3050` | 监听端口 |
| `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `protocolVersion` | `1.15.1` | 请求协议实现基线，不控制发送给上游的版本头 |
| `cliEnvironment` | `production` | `x-cli-environment` 请求头 |
| `userAgent` | `cli` | CLI 请求 User-Agent |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `mode` | `agent` | CC CLI 请求模式，可选 `agent`、`learning`、`custom-agent`、`custom-agent-create`、`title-gen`、`tool-desc`、`compact`、`vision` |
| `permissionMode` | `standard` | CC 权限模式 |
| `tasteLearningEnabled` | `false` | `x-taste-learning` 开关 |
| `oauthEnforced` | `false` | `x-co-flag` 开关 |
| `cmdZdr` | `false` | 是否发送 `x-cmd-zdr: 1` |
| `fingerprintSalt` | `""` | 指纹派生盐，生产环境建议通过环境变量设置 |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别 |
| `useProviderModels` | `true` | 返回官方 Provider API 模型列表，设为 `false` 时返回错误 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |

### 环境变量

| 变量 | 对应 config 字段 |
|------|-----------------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_API_BASE` | `apiBase` |
| `COMMAND_CODE_PROTOCOL_VERSION` | `protocolVersion` |
| `CC_CLI_ENVIRONMENT` | `cliEnvironment` |
| `CC_USER_AGENT` | `userAgent` |
| `PROJECT_SLUG` | `projectSlug` |
| `CC_MODE` | `mode` |
| `CC_PERMISSION_MODE` | `permissionMode` |
| `CC_TASTE_LEARNING` | `tasteLearningEnabled` |
| `CC_OAUTH_ENFORCED` | `oauthEnforced` |
| `CMD_ZDR` | `cmdZdr` |
| `OSS_PRIMARY_PROVIDER` | `ossPrimaryProvider` |
| `FINGERPRINT_SALT` | `fingerprintSalt` |
| `LOG_FILE` | `logFile` |
| `LOG_LEVEL` | `logLevel` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` |

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 模型 ID（见模型列表） |
| `messages` | 是 | 对话消息；`developer` 会映射为 `system`，旧式 `function` 会映射为 `tool` |
| `max_tokens` | 否 | 最大生成 token（默认 64000） |
| `stream` | 否 | 是否 SSE 流式（默认 false） |
| `temperature` | 否 | 采样温度（0-2）|
| `reasoning_effort` | 否 | 推理强度 `low`/`medium`/`high`/`max` |
| `tools` | 否 | 工具定义（OpenAI function calling 格式）|
| `tool_choice` | 否 | 工具选择策略 |
| `parallel_tool_calls` | 否 | 是否允许并行工具调用 |

**简单请求：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**流式响应（SSE）：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念 | Anthropic 原始格式 | 转换说明 |
|------|-------------------|----------|
| System prompt | 顶层 `system` 字段 | 自动转为 OpenAI `system` message |
| 消息内容 | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理强度 | `thinking.budget_tokens` | 自动映射为 `reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 自动映射为 `stop`/`length`/`tool_calls` |
| Token 用量 | `input_tokens`/`output_tokens` + 缓存 | 透传，缓存字段映射为 Anthropic 格式 |

**流式响应（SSE，Anthropic 格式）：**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**非流式响应：**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `GET /v1/models`

返回官方 Provider API 模型列表（5min 缓存）；官方接口支持匿名访问，上游失败时直接返回错误，不使用本地回退列表。

### `GET /health`

健康检查。返回 `OK`。

### Command Code 原生透传

代理会在相同路径透传 Command Code 原生 API。`/alpha/*`、`/provider/*` 以及 1.15.1 bundle 声明的 `/beta/*`、`/internal/*` 会被发送到固定的 `apiBase`；其他路径不会转发，因此它不是任意 URL 代理。

原生接口保留 HTTP method、query、请求体原始字节、认证/OAuth/Cookie 请求头、上游状态码、响应头和响应流。只移除 `Host`、`Connection`、`Transfer-Encoding` 等逐跳头；3xx 响应不会自动跟随。请求体上限仍为 10MB。生产部署建议为原生入口使用专用域名，避免与其他 Web 应用共享 Cookie。

```bash
curl http://127.0.0.1:3050/alpha/whoami \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "x-command-code-version: 1.15.1"
```

`POST /alpha/generate` 会返回原生逐行 JSON（NDJSON），不会转换为 OpenAI SSE。沙箱实时通道使用相同路径的 WebSocket 隧道，例如 `ws://127.0.0.1:3050/alpha/sandbox/stream/...`。外部 OAuth、npm 更新、遥测和用户自定义 MCP 地址不属于 Command API origin，不会被这个入口代理。

## 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| 400 | 请求格式错误 |
| 401 | API Key 缺失/格式不对/无效（Key 必须以 `user_` 开头） |
| 429 | 流空闲超时（30s 流式 / 90s 非流式，SDK 自动重试，连续 3 次：提示压缩上下文） |
| 502 | 零输出 token 或 CC 上游错误 |
| 503 | 服务暂时不可用 |

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

代理会原样返回官方 Provider API 的 JSON，不再自行构造本地模型列表。官方接口支持匿名访问，请求可选择携带 `Authorization: Bearer user_...`。上游失败或 Provider API 被关闭时直接返回错误，不返回伪造模型数据；响应按 API Key 或公共请求缓存 5 分钟。

### 常用模型

| 模型 ID | 说明 | 特性 |
|---------|------|------|
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 快速通用 |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 高精度推理 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 长文本 |
| `claude-opus-4-8` | Claude Opus 4.8 | 最强推理 |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | 多模态/前端 |
| `xiaomi/mimo-v2.5` | MiMo V2.5 | **支持图片输入** |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max | 大参数量 |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash | 推理模型 |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对本机 `command-code@1.15.1` bundle 的分析，实现了以下兼容适配：

| 机制 | 实现 |
|------|------|
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动 |
| **协议基线 / 动态版本头** | 请求协议按 `1.15.1` 实现；`x-command-code-version` 每 24 小时从 npm latest 刷新，失败时回退到 `1.15.1` |
| **CLI 信封格式** | config/memory/taste/skills/permissionMode/mode/params/threadId |
| **工具与图片格式** | 工具字段、base64 图片和 mimeType 对齐最新版 wire format |
| **流式续接** | `pause_turn` 最多按同一请求线程继续两次 |
| **稳定指纹** | 按 API Key 派生最新版 CLI 所需的指纹字段，重启后保持稳定 |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **环境标识** | `x-cli-environment: production` |
| **Project Slug** | 自定义 `x-project-slug` |
| **思考强度** | `reasoning_effort` 透传 (low/medium/high/max) |
| **API Key 格式验证** | 正则 `user_[a-zA-Z0-9_-]+`，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒 |
| **流式超时保护** | 流式 30s、非流式 90s → 429 + SDK 自动重试 |
| **连续超时阈值** | 连续 3 次超时后才提示压缩上下文 |
| **零输出防护** | outputTokens=0 → 429 错误（SDK 自动重试，反异常计费） |
| **上游中止** | 客户端断连 + 全部错误路径 `AbortController` 打断 CC |
| **隐私保护日志** | 日志不含 API Key 片段、错误 body、stack trace |

## 协议细节

### CC API 请求体结构

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "linux",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "mode": "agent",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "tools": [],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  },
  "threadId": "<uuid>"
}
```

`threadId` 仅在客户端通过 `x-thread-id` 或 `x-command-code-thread-id` 传入有效 UUID 时发送；否则代理会按最新版 CLI 的可选字段规则省略它。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

### 快速启动 (docker compose)

```bash
docker compose up -d
```

代理将在 `http://0.0.0.0:3050` 监听。通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 从源码构建

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3050` | 容器内监听端口 |
| `PROXY_PORT` | `3050` | 主机映射端口（仅 compose） |

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 必须在每次请求的 `Authorization: Bearer <key>` 头中传入，不存储在配置中。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev

# 运行语法检查和内置集成测试
npm run check
npm test
```
