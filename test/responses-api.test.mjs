import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})\n${output()}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`proxy did not become healthy\n${output()}`);
}

async function startProxy(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'commandcode-responses-test-'));
  copyFileSync(path.join(projectRoot, 'proxy.mjs'), path.join(directory, 'proxy.mjs'));
  writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let output = '';
  const child = spawn(process.execPath, ['proxy.mjs'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${config.port}`;
  await waitForHealth(baseUrl, child, () => output);
  return {
    baseUrl,
    output: () => output,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function sendNdjson(res, events) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  res.end(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

function parseSse(raw) {
  return raw.split(/\n\n+/).map(block => {
    const line = block.split('\n').find(value => value.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

test('Responses API translates Codex 0.153 tools, input, output, and SSE lifecycle', async t => {
  const generatedBodies = [];
  const generatedHeaders = [];
  const initializationRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      initializationRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/generate') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      generatedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      generatedHeaders.push(req.headers);
      sendNdjson(res, [
        { type: 'reasoning-start' },
        { type: 'reasoning-delta', text: 'Checking' },
        { type: 'reasoning-end' },
        { type: 'text-start' },
        { type: 'text-delta', text: 'Calling tool' },
        { type: 'text-end' },
        { type: 'tool-call', toolCallId: 'call_probe', toolName: 'functions__exec', input: { input: 'text("SAFE")' } },
        { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 3 } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 3 } },
      ]);
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  const requestBody = {
    model: 'gpt-5.6-luna',
    input: [
      {
        type: 'additional_tools',
        id: 'at_probe',
        role: 'developer',
        tools: [{
          type: 'namespace',
          name: 'functions',
          tools: [
            { type: 'custom', name: 'exec', description: 'Execute JavaScript', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
            { type: 'function', name: 'wait', description: 'Wait', strict: false, parameters: { type: 'object', properties: { cell_id: { type: 'string' } }, required: ['cell_id'] } },
          ],
        }],
      },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the project.' }] },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', context: 'all_turns' },
    prompt_cache_key: 'd8d0ec66-62c7-4a9f-8106-cbb78bd9b5e4',
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  };
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_responses_test_key', 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${raw}\n${proxy.output()}`);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const events = parseSse(raw);
  assert.equal(events[0].type, 'response.created');
  assert.ok(events.some(event => event.type === 'response.reasoning_summary_text.delta' && event.delta === 'Checking'));
  assert.ok(events.some(event => event.type === 'response.output_text.delta' && event.delta === 'Calling tool'));
  const toolDone = events.find(event => event.type === 'response.output_item.done' && event.item?.type === 'custom_tool_call');
  assert.deepEqual(toolDone.item, {
    id: toolDone.item.id,
    call_id: 'call_probe',
    name: 'exec',
    namespace: 'functions',
    type: 'custom_tool_call',
    status: 'completed',
    input: 'text("SAFE")',
  });
  const completed = events.at(-1);
  assert.equal(completed.type, 'response.completed');
  assert.equal(completed.response.usage.input_tokens, 20);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(completed.response.usage.output_tokens, 8);

  assert.equal(generatedBodies.length, 1);
  const ccBody = generatedBodies[0];
  assert.equal(ccBody.params.model, 'gpt-5.6-luna');
  assert.deepEqual(ccBody.params.system, [{ type: 'text', text: 'You are Codex.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(ccBody.params.messages[0].content[0].text, 'Inspect the project.');
  assert.equal(ccBody.params.reasoning_effort, 'medium');
  assert.equal(ccBody.params.parallel_tool_calls, false);
  assert.deepEqual(ccBody.params.tools.map(tool => [tool.type, tool.name]), [[undefined, 'functions__exec'], [undefined, 'functions__wait']]);
  assert.equal(ccBody.params.tools[0].input_schema.properties.input.type, 'string');
  assert.equal(ccBody.skills, null);
  assert.equal(ccBody.mode, 'agent');
  assert.equal(ccBody.threadId, requestBody.prompt_cache_key);
  assert.deepEqual(Object.keys(ccBody).slice(0, 8), ['config', 'memory', 'taste', 'skills', 'permissionMode', 'threadId', 'mode', 'params']);

  const secondResponse = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: 'Bearer user_responses_test_key', 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  assert.equal(secondResponse.status, 200);
  await secondResponse.text();
  assert.equal(generatedBodies.length, 2);
  assert.equal(initializationRequests.length, 2, 'fingerprint and lifecycle preflight must be throttled per key');

  const firstGenerateHeaders = generatedHeaders[0];
  assert.equal(firstGenerateHeaders.authorization, 'Bearer user_responses_test_key');
  assert.equal(firstGenerateHeaders['x-cli-environment'], 'production');
  assert.equal(firstGenerateHeaders['x-command-code-version'], '1.53.1');
  assert.equal(firstGenerateHeaders['user-agent'], 'cli');
  assert.equal(firstGenerateHeaders['x-co-flag'], undefined);
  assert.equal(firstGenerateHeaders['x-taste-learning'], 'false');
  assert.equal(firstGenerateHeaders['x-session-id'], requestBody.prompt_cache_key);
  assert.equal(firstGenerateHeaders['x-project-slug'], 'c-users-dev-projects-app');
  assert.match(firstGenerateHeaders.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(generatedHeaders[1]['x-session-id'], firstGenerateHeaders['x-session-id'], 'same key must reuse its CLI session');
  assert.equal(generatedHeaders[1]['x-project-slug'], firstGenerateHeaders['x-project-slug']);
  assert.notEqual(generatedHeaders[1].traceparent, firstGenerateHeaders.traceparent, 'each request must use a fresh trace');

  const fingerprint = initializationRequests.find(entry => entry.url === '/alpha/fingerprint/record');
  const lifecycle = initializationRequests.find(entry => entry.url === '/alpha/lifecycle-events');
  assert.equal(fingerprint.headers.authorization, 'Bearer user_responses_test_key');
  assert.equal(fingerprint.headers['x-cli-environment'], 'production');
  assert.equal(fingerprint.headers['x-command-code-version'], firstGenerateHeaders['x-command-code-version']);
  assert.match(fingerprint.body.thumbmark, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint.body.components.platform, 'win32');
  assert.equal(fingerprint.body.components.arch, 'x64');
  assert.equal(fingerprint.body.components.isContainer, false);
  assert.equal(fingerprint.body.components.runtime, 'cli');
  assert.ok(fingerprint.body.components.macHashes.length >= 2 && fingerprint.body.components.macHashes.length <= 5);
  assert.equal(lifecycle.headers.authorization, 'Bearer user_responses_test_key');
  assert.equal(lifecycle.body.eventType, 'cli_session_exists');
  assert.equal(lifecycle.body.metadata.cliVersion, firstGenerateHeaders['x-command-code-version']);
  assert.equal(lifecycle.body.metadata.mode, 'interactive');
  assert.equal(lifecycle.body.metadata.os, 'win32-x64');
});

test('Responses API supports non-stream continuation tool output and rejects stateful requests', async t => {
  const generatedBodies = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/generate') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      generatedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      sendNdjson(res, [
        { type: 'text-delta', text: 'Done' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 12, outputTokens: 2, cachedInputTokens: 0 } },
      ]);
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  const authHeaders = { Authorization: 'Bearer user_responses_test_key', 'Content-Type': 'application/json' };
  const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      input: [
        { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] },
        { type: 'custom_tool_call', call_id: 'call_previous', namespace: 'functions', name: 'exec', input: 'text("SAFE")' },
        { type: 'custom_tool_call_output', call_id: 'call_previous', output: 'SAFE' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
      ],
      store: false,
      stream: false,
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, 'response');
  assert.equal(body.output[0].content[0].text, 'Done');
  assert.equal(body.usage.total_tokens, 14);
  const messages = generatedBodies[0].params.messages;
  assert.equal(messages[0].content[0].type, 'tool-call');
  assert.deepEqual(messages[0].content[0].input, { input: 'text("SAFE")' });
  assert.equal(messages[1].content[0].type, 'tool-result');
  assert.equal(messages[1].content[0].output.value, 'SAFE');
  assert.equal(messages[2].content[0].text, 'Continue.');

  const stateful = await fetch(`${proxy.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ model: 'gpt-5.6-luna', previous_response_id: 'resp_server_state', input: 'Continue' }),
  });
  const statefulBody = await stateful.json();
  assert.equal(stateful.status, 400);
  assert.equal(statefulBody.error.type, 'invalid_request_error');
  assert.equal(generatedBodies.length, 1, 'invalid request must not reach the upstream');
});

test('installed Codex CLI completes a custom-tool round trip through /v1/responses', {
  skip: !process.env.CODEX_PROBE_EXE,
  timeout: 60000,
}, async t => {
  const generatedBodies = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== '/alpha/generate') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    generatedBodies.push(body);
    if (generatedBodies.length === 1) {
      const execTool = body.params.tools?.find(tool => /exec$/i.test(tool.name));
      assert.equal(execTool?.type, undefined);
      sendNdjson(res, [
        { type: 'tool-call', toolCallId: 'call_e2e_probe', toolName: execTool.name, input: { input: 'text("PROBE_TOOL_OK")' } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } },
      ]);
      return;
    }
    sendNdjson(res, [
      { type: 'text-delta', text: 'CODEX_PROXY_OK' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 } },
    ]);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  const config = [
    'model_provider="ccproxy"',
    'model_providers.ccproxy.name="Command Code Proxy"',
    `model_providers.ccproxy.base_url="${proxy.baseUrl}/v1"`,
    'model_providers.ccproxy.env_key="CC_PROXY_E2E_KEY"',
    'model_providers.ccproxy.wire_api="responses"',
  ];
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '-s', 'read-only'];
  for (const entry of config) args.push('-c', entry);
  args.push('-m', 'gpt-5.6-luna', 'Run the requested probe and finish.');
  const child = spawn(process.env.CODEX_PROBE_EXE, args, {
    env: { ...process.env, CC_PROXY_E2E_KEY: 'user_codex_e2e_test_key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(exitCode, 0, stderr);
  assert.equal(generatedBodies.length, 2, `${stdout}\n${stderr}\n${proxy.output()}`);
  const toolResult = generatedBodies[1].params.messages.find(message => message.role === 'tool');
  assert.match(toolResult.content[0].output.value, /PROBE_TOOL_OK/);
  assert.match(stdout, /CODEX_PROXY_OK/);
  assert.doesNotMatch(proxy.output(), /Internal server error|Unhandled rejection/i);
});
