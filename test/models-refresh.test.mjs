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

async function startProxy(config) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'commandcode-models-test-'));
  copyFileSync(path.join(projectRoot, 'proxy.mjs'), path.join(directory, 'proxy.mjs'));
  writeFileSync(path.join(directory, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let output = '';
  const child = spawn(process.execPath, ['proxy.mjs'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})\n${output}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
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

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

test('model catalog synchronizes at startup and remains cached for /v1/models', async t => {
  const providerRequests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/provider/v1/models') {
      providerRequests.push(req.headers);
      json(res, { data: [
        { id: 'deepseek/deepseek-v4.1-flash' },
        { id: 'z-ai/glm-5.3-flash' },
        { id: 'z-ai/glm-5.3-flash' },
        { id: '../invalid model id' },
      ] });
      return;
    }
    if (req.url.startsWith('/alpha/whoami')) return json(res, { org: { id: 'org_test' } });
    if (req.url.startsWith('/alpha/billing/credits')) return json(res, { credits: {} });
    if (req.url.startsWith('/alpha/billing/subscriptions')) return json(res, { data: {} });
    if (req.url.startsWith('/alpha/usage/summary')) return json(res, {});
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const port = await freePort();
  const accountKey = 'user_models_refresh_test_key';
  const proxyKey = 'models-refresh-proxy-key-at-least-24-characters';
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    useProviderModels: true,
    modelRefreshIntervalMs: 86400000,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: {
      enabled: true,
      proxyKey,
      usageRefreshIntervalMs: 60000,
      selectionStrategy: 'priority',
      accounts: [{ id: 'account-1', priority: 1, apiKey: accountKey, enabled: true }],
    },
  });
  t.after(() => proxy.close());

  const deadline = Date.now() + 5000;
  while (providerRequests.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(providerRequests.length, 1, proxy.output());
  assert.equal(providerRequests[0].authorization, `Bearer ${accountKey}`);
  assert.equal(providerRequests[0]['x-cli-environment'], 'production');
  assert.ok(providerRequests[0]['x-command-code-version']);

  const response = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${proxyKey}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.map(model => model.id), ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
  assert.equal(providerRequests.length, 1, 'fresh startup catalog must be reused rather than fetched again');
  assert.doesNotMatch(proxy.output(), /user_models_refresh_test_key|models-refresh-proxy-key/);
});

test('offline fallback contains the current DeepSeek and GLM Flash IDs', async t => {
  const port = await freePort();
  const proxy = await startProxy({
    port,
    host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:1',
    useProviderModels: false,
    modelRefreshIntervalMs: 86400000,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { Authorization: 'Bearer user_models_fallback_test' } });
  const body = await response.json();
  const ids = body.data.map(model => model.id);
  assert.ok(ids.includes('deepseek/deepseek-v4.1-flash'));
  assert.ok(ids.includes('z-ai/glm-5.3-flash'));
});
