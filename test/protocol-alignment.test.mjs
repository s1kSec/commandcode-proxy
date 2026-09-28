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

const insufficientCredits = 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.';

for (const endpoint of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
  for (const scenario of [
    { name: '400 credit exhaustion', status: 400, error: { error: { message: insufficientCredits } }, retry: true },
    { name: '400 plain text credit exhaustion', status: 400, error: insufficientCredits, retry: true },
    { name: '400 invalid parameter', status: 400, error: { error: { message: 'Invalid max_tokens parameter' } }, retry: false },
    { name: '400 echoed credit text', status: 400, error: { error: { message: 'Invalid messages parameter' }, request: { content: insufficientCredits } }, retry: false },
    { name: '400 generic limit error', status: 400, error: { error: { message: 'Invalid credit limit parameter', rateLimit: true } }, retry: false },
    { name: '402 payment required', status: 402, error: { error: { message: 'Payment required' } }, retry: true },
    { name: '429 usage limit', status: 429, error: { error: { message: 'Weekly usage limit reached' } }, retry: true },
    { name: '429 ordinary throttling', status: 429, error: { error: { message: 'Too many requests' } }, retry: false },
  ]) {
    test(`${endpoint}: ${scenario.name}`, async t => {
      const attempts = [];
      const firstKey = 'user_failover_first';
      const secondKey = 'user_failover_second';
      const proxyKey = 'failover-test-proxy-key-at-least-24-characters';
      const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
          res.writeHead(204).end();
          return;
        }
        if (req.url !== '/alpha/generate') return res.writeHead(404).end();
        attempts.push({ key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (req.headers.authorization === `Bearer ${firstKey}`) {
          res.writeHead(scenario.status, { 'Content-Type': typeof scenario.error === 'string' ? 'text/plain' : 'application/json' });
          res.end(typeof scenario.error === 'string' ? scenario.error : JSON.stringify(scenario.error));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ type: 'text-delta', text: 'ok' })}\n${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 } })}\n`);
      });
      const upstreamPort = await listen(upstream);
      const proxy = await startProxy({
        port: await freePort(), host: '127.0.0.1', apiBase: `http://127.0.0.1:${upstreamPort}`,
        useProviderModels: false, adminAuth: { enabled: false },
        accountPool: {
          enabled: true, proxyKey, selectionStrategy: 'priority',
          accounts: [
            { id: 'account-1', priority: 1, apiKey: firstKey, enabled: true },
            { id: 'account-2', priority: 2, apiKey: secondKey, enabled: true },
          ],
        },
      });
      t.after(async () => { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); });
      const send = () => fetch(`${proxy.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v4-flash [1M]', stream: false, max_tokens: 16,
          ...(endpoint === '/v1/responses' ? { input: 'probe' } : { messages: [{ role: 'user', content: 'probe' }] }),
        }),
      });
      const response = await send();
      const result = await response.text();
      assert.equal(response.status, scenario.retry ? 200 : scenario.status, result);
      assert.deepEqual(attempts.map(a => a.key), scenario.retry ? [`Bearer ${firstKey}`, `Bearer ${secondKey}`] : [`Bearer ${firstKey}`]);
      assert.ok(attempts.every(a => a.body.params.model === 'deepseek/deepseek-v4-flash'));
      if (scenario.retry) {
        assert.match(result, /ok/);
        assert.deepEqual(attempts[1].body.params, attempts[0].body.params, 'failover must preserve generation parameters while allowing per-account session IDs');
        const next = await send();
        assert.equal(next.status, 200, await next.text());
        assert.equal(attempts.length, 3);
        assert.equal(attempts[2].key, `Bearer ${secondKey}`, 'subsequent request skips the blocked account');
      } else {
        assert.doesNotMatch(proxy.output(), /Pool account temporarily unavailable/);
      }
    });
  }
}

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
  const directory = mkdtempSync(path.join(os.tmpdir(), 'commandcode-protocol-test-'));
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

async function runChat(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user_protocol_alignment_test_key',
      'Content-Type': 'application/json',
      'x-session-id': 'c30b5aa2-12c3-4ef0-a719-38ea7015bcdf',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'protocol probe' }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
}

test('deterministic fingerprint survives restart and all CC calls share the configured CONNECT proxy', async t => {
  const fingerprints = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/alpha/fingerprint/record') {
      fingerprints.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/lifecycle-events') {
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/alpha/generate') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ type: 'text-delta', text: 'ok' })}\n${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 } })}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const connectRequests = [];
  const connectProxy = http.createServer();
  connectProxy.on('connect', (req, clientSocket, head) => {
    connectRequests.push({ target: req.url, authorization: req.headers['proxy-authorization'] });
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstreamSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', () => clientSocket.destroy());
  });
  const connectProxyPort = await listen(connectProxy);
  t.after(() => new Promise(resolve => connectProxy.close(resolve)));

  const common = {
    host: '127.0.0.1',
    apiBase: `http://127.0.0.1:${upstreamPort}`,
    upstreamProxy: `http://probe-user:probe-pass@127.0.0.1:${connectProxyPort}`,
    useProviderModels: false,
    usageAllowedIps: ['*'],
    adminAuth: { enabled: false },
    accountPool: { enabled: false },
  };

  const first = await startProxy({ ...common, port: await freePort() });
  await runChat(first.baseUrl);
  assert.doesNotMatch(first.output(), /probe-user|probe-pass/);
  await first.close();

  const second = await startProxy({ ...common, port: await freePort() });
  t.after(() => second.close());
  await runChat(second.baseUrl);
  assert.doesNotMatch(second.output(), /probe-user|probe-pass/);

  assert.equal(fingerprints.length, 2);
  assert.deepEqual(fingerprints[1], fingerprints[0], 'same key must keep the same device identity across restarts');
  assert.equal(connectRequests.length, 6, 'fingerprint, lifecycle, and generate must all use the proxy on both runs');
  assert.ok(connectRequests.every(request => request.target === `127.0.0.1:${upstreamPort}`));
  assert.ok(connectRequests.every(request => request.authorization?.startsWith('Basic ')));
});
