# Command Code Proxy

> [中文文档](README_zh.md)

A reverse proxy that converts Command Code API to OpenAI / Anthropic compatible endpoints. Single file, zero external dependencies.

Built by analyzing official CLI network traffic to accurately replicate the Command Code API request protocol, including device-fingerprint and lifecycle pre-requests.

**Features**: OpenAI Responses API (Codex CLI 0.153+) + Chat Completions + Anthropic Messages API | Streaming & non-streaming | Tool calling (including Responses namespaces/custom tools) | Multimodal image input | Reasoning effort | Dynamic model list | Cache hit metrics | Device fingerprint disguise (per-key, auto-refresh) | `x-api-key` auth (Anthropic SDK) | Client disconnect detection with upstream abort | Zero-output → 429 auto-retry | Consecutive timeout → 429 auto-retry | Privacy-aware logging

**Community**: [Linux.do](https://linux.do) — a friendly Chinese tech community.

## Quick Start

```bash
npm start        # Start (the repo ships with config.json listening on http://0.0.0.0:3050)
npm run dev      # Watch mode (auto-reload on file changes)
```

API Key is passed via the `Authorization` request header (or `x-api-key` for Anthropic SDKs) — no need to store it in config files. Key must start with `user_` (automatically matched with any prefix, e.g. `Bearer token_user_xxx`):

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## File Structure

```
commandcode/
├── config.json           # Port / log path etc.
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # Single-file proxy core (~1900 lines)
├── Dockerfile            # Container build (node:22-alpine)
├── docker-compose.yml    # Container orchestration
├── .dockerignore         # Build context exclusions
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # GHCR multi-arch publish on v* tags
├── captured-requests/    # Captured CLI traffic (protocol analysis reference)
├── README.md             # This document (English)
└── README_zh.md          # Chinese documentation
```

## Configuration

### config.json

| Field | Default | Description |
|------|--------|-------------|
| `port` | `3000` | Listen port (repo config.json ships with `3050`) |
| `host` | `0.0.0.0` | Listen address |
| `apiBase` | `https://api.commandcode.ai` | CC API base URL |
| `projectSlug` | `cc-proxy` | Legacy compatibility field; aligned requests derive `x-project-slug` from `deviceProjectDir` |
| `apiKey` | `""` | Optional fallback API key (requests can also send it via header) |
| `logFile` | `""` | Log file path (empty = console only) |
| `logLevel` | `info` | Log level |
| `useProviderModels` | `true` | Dynamically fetch model list from Provider API |
| `modelRefreshIntervalMs` | `86400000` | Background model catalog refresh interval (24 hours; also syncs once at startup when a server-side key is available) |
| `zdr` | `false` | Send `x-cmd-zdr: 1` on generation and initialization requests |
| `cliMode` | `agent` | CLI-aligned request-envelope mode |
| `cliSessionMode` | `interactive` | Lifecycle mode: `interactive` or `non-interactive` |
| `fingerprintSalt` | `""` | Optional device-identity derivation salt; changing it presents every account as a new device |
| `deviceProjectDir` | `""` | Shared device working directory/project slug source; empty uses the built-in Windows path |
| `emptySystemPlaceholder` | `true` | Send a space when system is absent to prevent upstream default-prompt injection |
| `upstreamProxy` | `""` | Optional HTTP CONNECT proxy shared by all CC calls; credentials are redacted from logs |

### Environment Variables

| Variable | Overrides |
|----------|-----------|
| `PORT` | `port` |
| `HOST` | `host` |
| `CC_API_BASE` | `apiBase` |
| `PROJECT_SLUG` | `projectSlug` |
| `LOG_FILE` | `logFile` |
| `CC_USE_PROVIDER_MODELS` | `useProviderModels` |
| `CC_MODEL_REFRESH_INTERVAL_MS` | `modelRefreshIntervalMs` |
| `CMD_ZDR` | `zdr` (`1` enables it) |
| `CC_CLI_MODE` | `cliMode` |
| `CC_CLI_SESSION_MODE` | `cliSessionMode` |
| `CC_FINGERPRINT_SALT` | `fingerprintSalt` |
| `CC_DEVICE_PROJECT_DIR` | `deviceProjectDir` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | `emptySystemPlaceholder` |
| `CC_UPSTREAM_PROXY` | `upstreamProxy` |

The compatibility layer declares the wire version it actually implements, `command-code@1.53.1`. A newer npm release produces a drift warning but never changes the advertised version before the request shape is aligned. Device fingerprints are derived deterministically per account, so restarts and multiple instances retain one identity without exposing the account key in the fingerprint, logs, or responses.

## API Endpoints

### `POST /v1/responses`

OpenAI Responses-compatible endpoint intended for Codex CLI 0.153 and newer. It accepts string or item-array `input`, developer/system/user/assistant messages, reasoning summaries, function calls, Codex `additional_tools` namespaces, custom grammar tools, tool outputs, images, and both SSE and buffered responses. The adapter is stateless: Codex's normal `store = false` full-input flow is supported; `store = true`, `previous_response_id`, `conversation`, background mode, item references, file inputs, and OpenAI-hosted tools are rejected with a clear `400` because Command Code has no equivalent server-side state or hosted-tool runtime.

Codex configuration (`~/.codex/config.toml`):

```toml
model = "gpt-5.6-luna"
model_provider = "commandcode_proxy"

[model_providers.commandcode_proxy]
name = "Command Code Proxy"
base_url = "http://YOUR_PROXY_IP:33000/v1"
env_key = "COMMANDCODE_PROXY_KEY"
wire_api = "responses"
```

Set `COMMANDCODE_PROXY_KEY` to the configured account-pool `proxyKey` (recommended) or to a Command Code `user_...` key before starting Codex. Do not put the secret directly in `config.toml`.

### `POST /v1/chat/completions`

OpenAI Chat Completions compatible. Supports streaming, non-streaming, tool calling, multimodal image input, and reasoning effort.

**Request parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `model` | Yes | Model ID (see model list) |
| `messages` | Yes | Conversation messages, supports `system/user/assistant/tool` roles |
| `max_tokens` | No | Max tokens to generate (default 64000) |
| `stream` | No | SSE streaming (default false) |
| `temperature` | No | Sampling temperature (0-2) |
| `reasoning_effort` | No | Reasoning intensity: `low`/`medium`/`high`/`max` |
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
| Reasoning | `thinking.budget_tokens` | Auto-mapped to `reasoning_effort` (≥10000→high, ≥5000→medium, ≥2000→low) |
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

Returns the cached live model catalog. The proxy synchronizes once at startup and then every 24 hours by default; a failed refresh keeps the last successful catalog instead of rolling back to the offline fallback.

### `GET /health`

Health check. Returns `OK`.

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 400 | Invalid request format |
| 401 | API Key missing / invalid format / rejected (Key must start with `user_`; sent via `Authorization: Bearer` or `x-api-key`) |
| 429 | Zero output tokens, or idle timeout (30s streaming / 90s non-streaming) — SDK auto-retry with `Retry-After`; after 3 consecutive timeouts a "reduce context" hint is returned |
| 502 | CC upstream error |

## Model List

The proxy synchronizes the live Provider catalog once at startup and then every 24 hours by default. If no server-side key has been configured yet, the first authenticated API request supplies one in memory for later background refreshes. Below are common offline fallback models; the actual list depends on the live API response — see [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits) for plan details.

Some harnesses append a context-window label to the model name, for example `deepseek/deepseek-v4-flash [1M]`. The proxy removes only an exact terminal `[1M]` marker when forwarding upstream, while preserving the original model label in downstream responses. Similar text embedded inside a model ID is never rewritten.

### Common Models

| Model ID | Provider |
|----------|----------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4.1-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `z-ai/glm-5.3-flash` / `z-ai/glm-5.3-flashx` / `zai-org/GLM-5.3` / `zai-org/GLM-5.2` / `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi (**image input supported**) |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

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

The Anthropic SDK authenticates via the `x-api-key` header — supported by the proxy natively (no `Authorization` header needed).

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## Anti-Detection

Based on analysis of official CLI traffic (version auto-fetched from npm registry):

| Mechanism | Implementation |
|-----------|---------------|
| **Device Fingerprint** | `POST /alpha/fingerprint/record` before first request per key; random fingerprint pool (15 CPUs, global timezones), SHA-256 hashed, per-key binding, refreshed every 8h + 2h jitter |
| **Lifecycle Events** | `POST /alpha/lifecycle-events` (`cli_session_exists`) sent in parallel with fingerprint on session init |
| **Per-Key Session** | One session per API key, 12h expiry + 1h random jitter |
| **Version** | `x-command-code-version` auto-fetched from npm registry (24h refresh) |
| **CLI Envelope** | config/memory/taste/skills/permissionMode/params |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **Environment** | `x-cli-environment: production`, `x-co-flag: "false"`, `x-taste-learning: "false"` |
| **Project Slug** | `x-project-slug` generated from session ID (CLI-compatible format) |
| **Reasoning Effort** | `reasoning_effort` pass-through (low/medium/high/max) |
| **Key Validation** | Regex `user_[a-zA-Z0-9_-]+` on `Authorization: Bearer` or `x-api-key`, auto-cleans extra paths/prefixes, rejects `sk-xxx` format |
| **Stream Timeout** | 30s streaming / 90s non-streaming → 429 with SDK auto-retry |
| **Consecutive Timeout** | 3 consecutive timeouts before "reduce context" hint |
| **Zero-Output Guard** | outputTokens=0 → 429 `rate_limit_error` (SDK auto-retry, anti false billing) |
| **Upstream Abort** | `AbortController` on client disconnect + all error paths |
| **Privacy Logging** | No API key fragments, no error bodies, no stack traces in logs |

## Protocol Details

### CC API Request Structure

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32-x64, Node.js v24.16.0",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

Conditional fields: `system` (extracted from `system` messages), `temperature`, `reasoning_effort`, `tools` (mapped to CC `input_schema` format).

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

### Pull from GHCR

Pre-built multi-arch images (`linux/amd64` + `linux/arm64`) are published to the GitHub Container Registry automatically on every `v*` tag via GitHub Actions:

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:latest
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:latest
```

The `latest` tag is updated on each release. The image is public — no login required to pull.

### Quick Start (docker compose)

```bash
docker compose up -d
```

Compose bind-mounts the current directory's `config.json` read-only at `/app/config.json`. The proxy resolves this path relative to `proxy.mjs`, not the container's current working directory. Change accounts, keys, or quota settings without rebuilding the image, then restart the service:

```bash
docker compose restart proxy
```

If the configuration file is missing, invalid JSON, `accountPool.enabled` is not a boolean, or an enabled pool has duplicate IDs/invalid keys, startup logs a clear `[config]` error and exits instead of silently disabling the pool. `usageAllowedIps` accepts `"*"` (allow all) or literal IP addresses such as `"172.17.0.1"`; do not write it as `"\*"`, and do not put Markdown links in `apiBase`.

For an enabled account pool, `selectionStrategy` defaults to `priority`: lower account priority numbers are used first and the proxy advances only when a higher-priority account is known to be exhausted or the upstream returns a quota error before output. `earliest_monthly_reset` and `round_robin` remain available. Accounts with an exhausted reported 5-hour or weekly window are skipped until their reset time.

Optional online account settings are protected by `adminAuth` in `config.json`. Enable it only with a `scrypt$16384$8$1$<salt-base64url>$<hash-base64url>` password hash and an explicit `allowedIps` list. The `/admin` page verifies that the new session cookie is usable before showing settings, uses an HttpOnly SameSite cookie, requires a CSRF token for changes, rate-limits login, and has no CORS. It writes only an account-pool override to the persistent `runtime-data` Docker volume; the read-only base config is never made writable and real keys are never returned by the page or API.

The checked-in configuration uses `"allowedIps": ["*"]`, so the admin login is reachable over plain HTTP from every public source IP once `adminAuth.enabled` is enabled with a valid password hash. This is an explicit compatibility mode for IP-only deployments: the password and session cookie are not protected against network interception. The legacy `secureCookie` value is ignored and cannot re-enable an HTTPS-only login gate.

If a reverse proxy is used, add only that proxy's direct backend-facing IP to `adminAuth.trustedProxyIps`, for example `"trustedProxyIps": ["172.17.0.1"]`, and make it overwrite `X-Forwarded-For` with the real client address (or append the real address as the final value). The application uses the final forwarded address only for per-client login throttling and only when the direct peer is trusted; `"*"` is deliberately invalid for proxy trust.

The browser `/usage` dashboard now returns its HTML immediately and refreshes accounts asynchronously. Accounts and faster monthly limits appear as soon as they arrive; 5-hour, weekly, and history data are filled in without blocking the first page render. Existing JSON clients retain the blocking current-value behavior. A UI or monitor that needs a non-blocking snapshot can call `/usage?format=json&async=1&refresh=1` once to start a refresh, then poll `/usage?format=json&async=1` until `refreshing` is `false`.

The proxy will listen on `http://0.0.0.0:3050`. Set `PROXY_PORT` to customize the host port:

```bash
PROXY_PORT=13050 docker compose up -d
```

### Build from Source

```bash
docker build -t commandcode-proxy:latest .
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 \
  --mount type=bind,src="$(pwd)/config.json",dst=/app/config.json,readonly \
  commandcode-proxy:latest
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

### Tests

The regression tests use only local mock upstreams and placeholder keys; they never call Command Code or print configured secrets:

```bash
npm test
```

## Disclaimer

This project is for **educational and research purposes** only.

- **Unofficial**: This project is not affiliated with Command Code in any way.
- **Personal Use**: Users assume all responsibility. Please comply with the [Command Code Terms of Service](https://commandcode.ai/tos).
- **API Key**: This project does not collect, upload, or leak your API Key. The key is sent per request via the `Authorization: Bearer <key>` or `x-api-key` header and is never logged; an optional `apiKey` field in `config.json` serves only as a local fallback and never leaves your machine.
- **Compliance**: The protocol is based on passive observation of local CLI network traffic. No unauthorized access, cracking, or tampering of the server has been performed.
- **Account Risk**: Keep usage frequency consistent with normal CLI usage. Extremely high concurrent calls may trigger risk controls.

---

## Development

```bash
# Start with watch mode (auto-reload on file changes)
npm run dev
```
