# Command Code Proxy

> [中文文档](README_zh.md)

A reverse proxy that converts Command Code API to OpenAI / Anthropic compatible endpoints. Node.js ESM with zero external dependencies.

Built by analyzing the local `command-code@1.31.0` CLI bundle and aligning the Command Code API request protocol.

**Features**: Native Command Code HTTP/WebSocket pass-through | OpenAI Chat Completions + Anthropic Messages API | Streaming & non-streaming | Tool calling (tool_use) | Multimodal image input | Reasoning effort | Dynamic model list | Cache hit metrics | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

**Community**: [Linux.do](https://linux.do) — a friendly Chinese tech community.

## Quick Start

```bash
npm start        # Start (default http://0.0.0.0:3050)
npm run dev      # Watch mode (auto-reload on file changes)
```

API Key is passed via the `Authorization` request header — **no need to store it in config files**. Key must start with `user_` (automatically matched with any prefix, e.g. `Bearer token_user_xxx`):

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

### Global auth header check

Every request except `OPTIONS` preflight, `GET /v1/models`, `GET /health` and `/` **must carry** a valid-format `Authorization: Bearer user_...` header (the proxy only checks that the header is present and well-formed — it does not validate the key against the backend). Requests without it return:

```json
{"success":false,"error":{"code":"UNAUTHORIZED","status":401,"message":"Invalid 'Authorization' header or token.","docs":"https://commandcode.ai/docs/reference/errors/unauthorized"}}
```

This applies to `/v1/chat/completions`, `/v1/messages`, native pass-through paths and WebSocket upgrades.

## File Structure

```
commandcode/
├── config.json         # Port / log path etc.
├── LICENSE             # MIT License
├── package.json        # npm start / npm run dev
├── proxy.mjs           # HTTP entrypoint and request orchestration
├── src/                # Configuration, validation, state and CC client modules
├── test/               # Built-in node:test integration tests
├── Dockerfile          # Container build (node:22-alpine)
├── docker-compose.yml  # Container orchestration
├── .dockerignore       # Build context exclusions
├── README.md           # This document (English)
└── README_zh.md        # Chinese documentation
```

## Configuration

### config.json

| Field | Default | Description |
|------|--------|-------------|
| `port` | `3050` | Listen port |
| `host` | `0.0.0.0` | Listen address |
| `apiBase` | `https://api.commandcode.ai` | CC API base URL |
| `protocolVersion` | `1.31.0` | Protocol implementation baseline; also sent as the `x-command-code-version` header |
| `cliEnvironment` | `production` | `x-cli-environment` header |
| `userAgent` | `cli` | CLI User-Agent |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `mode` | `agent` | CC CLI request mode (`agent`, `learning`, `custom-agent`, `custom-agent-create`, `title-gen`, `tool-desc`, `compact`, or `vision`) |
| `permissionMode` | `standard` | CC permission mode |
| `tasteLearningEnabled` | `false` | `x-taste-learning` switch |
| `oauthEnforced` | `false` | Legacy `x-co-flag` switch (removed in 1.31.0; kept for config compatibility) |
| `cmdZdr` | `false` | Send `x-cmd-zdr: 1` when enabled |
| `fingerprintSalt` | `""` | Salt for stable per-key fingerprint derivation |
| `logFile` | `""` | Log file path (empty = console only) |
| `logLevel` | `info` | Log level |
| `useProviderModels` | `true` | Return the official Provider API model list; `false` returns an error |
| `modelRefreshIntervalMs` | `300000` | Model list cache refresh interval (5 min) |

### Environment Variables

| Variable | Overrides |
|----------|-----------|
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

## API Endpoints

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

**Request parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `model` | Yes | Model ID (see model list) |
| `messages` | Yes | Conversation messages; `developer` maps to `system`, and legacy `function` maps to `tool` |
| `max_tokens` | No | Max tokens to generate (default 64000) |
| `stream` | No | SSE streaming (default false) |
| `temperature` | No | Sampling temperature (0-2) |
| `reasoning_effort` | No | Reasoning intensity: `low`/`medium`/`high`/`xhigh`/`max` (model-dependent) |
| `tools` | No | Tool definitions (OpenAI function calling format) |
| `tool_choice` | No | Tool selection strategy |
| `parallel_tool_calls` | No | Allow parallel tool calls |

**Simple request:**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**Multimodal image input (vision model required):**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe this image" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**Tool calling:**
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

**Streaming response (SSE):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**Non-streaming response (with cache hits):**
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

Anthropic Messages API compatible endpoint. Supports streaming, non-streaming, and tool calling.

**Request body:**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic protocol conversion (automatic):**

| Concept | Anthropic Format | Conversion |
|---------|-----------------|------------|
| System prompt | Top-level `system` field | Auto-converted to OpenAI `system` message |
| Message content | `content` array (text/tool_use/tool_result) | Auto-mapped to corresponding roles |
| Tool results | `tool_result` blocks in `user` messages | Auto-converted to `role: "tool"` |
| Tool definitions | `input_schema` | Auto-mapped to `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`, `tool`→function object |
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥100000→max, ≥30000→xhigh, ≥10000→high, ≥5000→medium, else low); `adaptive` mode passes `effort` through |
| Stop reason | `end_turn`/`max_tokens`/`tool_use` | Auto-mapped to `stop`/`length`/`tool_calls` |
| Token usage | `input_tokens`/`output_tokens` + cache | Passed through, cache fields mapped to Anthropic format |

**Streaming response (SSE, Anthropic format):**
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

**Non-streaming response:**
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

Returns the official Provider API model list (5 min cache); the upstream endpoint supports anonymous access, and upstream failures return an error instead of a local fallback list.

### `GET /health`

Health check. Returns `OK`.

### Native Command Code Pass-Through

The proxy forwards native Command Code API requests on the same path. `/alpha/*`, `/provider/*`, and the `/beta/*` and `/internal/*` namespaces declared by the 1.31.0 bundle are sent only to the configured `apiBase`. Other paths are not forwarded, so this is not an arbitrary URL proxy.

Native requests preserve the HTTP method, query, raw body bytes, authentication/OAuth/cookie headers, upstream status, response headers, and response stream. Only hop-by-hop headers such as `Host`, `Connection`, and `Transfer-Encoding` are removed; 3xx responses are not followed automatically. The 10MB request limit still applies. Use a dedicated hostname for the native endpoint in production so it does not share cookies with unrelated web applications.

```bash
curl http://127.0.0.1:3050/alpha/whoami \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "x-command-code-version: 1.31.0"
```

`POST /alpha/generate` returns the native newline-delimited JSON stream without converting it to OpenAI SSE. Sandbox real-time connections use a WebSocket tunnel on the same path, such as `ws://127.0.0.1:3050/alpha/sandbox/stream/...`. External OAuth, npm updates, telemetry, and user-configured MCP origins are outside the Command API origin and are not proxied by this endpoint.

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 400 | Invalid request format |
| 401 | Missing `Authorization: Bearer user_...` header (returns the standard UNAUTHORIZED JSON, see above) |
| 429 | Stream idle timeout (30s streaming / 90s non-streaming, SDK auto-retry, consecutive 3: reduce context hint) |
| 502 | Zero output tokens or CC upstream error |
| 503 | Service temporarily unavailable |

## Model List

The proxy returns a live model list via `GET /v1/models`. Below are common models for reference; the actual list depends on the live API response — see [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits) for plan details.

The proxy returns the official Provider API JSON without constructing a local model list. The upstream endpoint supports anonymous access; upstream failures or disabled Provider API return an error instead of fabricated model data. The response is cached per API key or publicly for 5 minutes.

### Common Models

| Model ID | Description | Features |
|----------|-------------|----------|
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | Fast, general-purpose |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | High-precision reasoning |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Long context |
| `claude-opus-4-8` | Claude Opus 4.8 | Best reasoning |
| `moonshotai/Kimi-K2.5` | Kimi K2.5 | Multimodal / frontend |
| `xiaomi/mimo-v2.5` | MiMo V2.5 | **Image input supported** |
| `Qwen/Qwen3.7-Max` | Qwen 3.7 Max | Large parameters |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash | Reasoning model |

> ⚠️ Some models (e.g. `deepseek-v4-flash`, `claude-sonnet-4-6`) do not support image input. Use `xiaomi/mimo-v2.5`, `Kimi-K2.5`, or other vision models for multimodal.

## Integration Examples

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
Add a Custom Provider in Cursor settings:
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: Choose from the model list

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

### Claude Code

Point Claude Code at this proxy via environment variables. Auth uses the `x-api-key` header (Anthropic SDK standard — supported by the proxy):

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3050"
export ANTHROPIC_API_KEY="user_xxxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-6"   # optional model override
claude
```

> Note: Claude Code's official SDK sends the API key in the `x-api-key` header (not `Authorization`); the proxy's global auth accepts both. The `anthropic-version` header is ignored. CC reasoning output is mapped to Anthropic `thinking_delta` SSE events for compatibility with Claude Code's thinking parameter.

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## Anti-Detection

Based on analysis of the local `command-code@1.31.0` bundle:

| Mechanism | Implementation |
|-----------|---------------|
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Protocol Baseline / Version Header** | Request envelope and `x-command-code-version` are both pinned to `1.31.0` (`protocolVersion`); no longer follows npm latest, so the advertised version always matches the implemented protocol |
| **CLI Envelope** | config/memory/taste/skills/permissionMode/mode/params/threadId |
| **Tools & Images** | Latest wire format for tools, base64 images and mimeType; tool-result now backfills `toolName` |
| **Stream Continuation** | Repeats `pause_turn` requests up to two times on the same thread |
| **Server Tool Results** | 1.31.0 `tool-result` events (provider-executed) are silently skipped for OpenAI/Anthropic clients |
| **Upstream Abort** | 1.31.0 `abort` event treated as a normal completion |
| **Stable Fingerprint** | Latest CLI field shape, derived per API key and stable across restarts |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Environment** | `x-cli-environment: production` |
| **Project Slug** | Custom `x-project-slug` |
| **Reasoning Effort** | `reasoning_effort` pass-through (low/medium/high/xhigh/max, model-dependent) |
| **Key Validation** | Regex `user_[a-zA-Z0-9_-]+`, auto-cleans extra paths/prefixes, rejects `sk-xxx` format |
| **Stream Timeout** | 30s streaming / 90s non-streaming → 429 with SDK auto-retry |
| **Consecutive Timeout** | 3 consecutive timeouts before "reduce context" hint |
| **Zero-Output Guard** | outputTokens=0 → 429 error (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` on client disconnect + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Protocol Details

### CC API Request Structure

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

`threadId` is sent only when the client provides a valid UUID through `x-thread-id` or `x-command-code-thread-id`; otherwise it is omitted as in the latest CLI.

### CC API Image Message Format

The CLI sends images in this format:

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "What does this image say?" }
  ]
}
```

The proxy receives OpenAI `image_url` format and converts it to the above CC format transparently.

## Docker Deployment

### Quick Start (docker compose)

```bash
docker compose up -d
```

The proxy will listen on `http://0.0.0.0:3050`. Set `PROXY_PORT` to customize the host port:

```bash
PROXY_PORT=13050 docker compose up -d
```

### Build from Source

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### Multi-Architecture Build

```bash
npm run docker:build:multi
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3050` | Container listen port |
| `PROXY_PORT` | `3050` | Host port (compose only) |

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your API Key. The key must be sent in every request via the `Authorization: Bearer <key>` header and is never stored in configuration.
- **Compliance**: The protocol is based on passive observation of local CLI network traffic. No unauthorized access, cracking, or tampering of the server has been performed.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.

---

## Development

```bash
# Start with watch mode (auto-reload on file changes)
npm run dev

# Run syntax checks and built-in integration tests
npm run check
npm test
```
